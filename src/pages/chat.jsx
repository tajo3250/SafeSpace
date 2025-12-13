// src/pages/chat.jsx
// Features:
// - Global chat, DMs, groups, admins, ownership, disband
// - Real-time updates via Socket.IO
// - Unread tracking + teal unread highlight (B2)
// - Sorting by unread > lastActive > createdAt
// - Global Chat pinned
// - Auto-leave on removal
// - E2EE for DMs (ECDH + AES-GCM)
// - E2EE for Groups with per-group key + rotation on member removal

import React, {
  useEffect,
  useState,
  useMemo,
  useRef,
} from "react";
import { io } from "socket.io-client";
import { useNavigate } from "react-router-dom";

const SOCKET_URL = "https://lakisha-slumberless-deedee.ngrok-free.dev";
const API_BASE = "https://lakisha-slumberless-deedee.ngrok-free.dev";

const socket = io(SOCKET_URL, { autoConnect: false });

// -----------------------
// E2EE HELPERS
// -----------------------

// Both DMs and groups are E2EE
const E2EE_TYPES = new Set(["dm", "group"]);
const E2EE_LOCAL_KEY_PREFIX = "e2eeKeyPair:";

// Is this conversation end-to-end encrypted?
function isConversationE2EE(conv) {
  if (!conv) return false;
  return E2EE_TYPES.has(conv.type);
}

// Local storage helpers for per-user ECDH keypair
async function loadOrCreateKeyPairForUser(userId) {
  if (!window.crypto || !window.crypto.subtle) {
    throw new Error("Web Crypto not available in this browser");
  }

  const storageKey = `${E2EE_LOCAL_KEY_PREFIX}${userId}`;
  const existing = localStorage.getItem(storageKey);

  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      const { publicJwk, privateJwk } = parsed || {};

      if (publicJwk && privateJwk) {
        const [publicKey, privateKey] = await Promise.all([
          window.crypto.subtle.importKey(
            "jwk",
            publicJwk,
            { name: "ECDH", namedCurve: "P-256" },
            true,
            []
          ),
          window.crypto.subtle.importKey(
            "jwk",
            privateJwk,
            { name: "ECDH", namedCurve: "P-256" },
            false,
            ["deriveKey", "deriveBits"]
          ),
        ]);

        return { publicKey, privateKey };
      }
    } catch (e) {
      console.error("Failed to import existing E2EE keypair, regenerating", e);
    }
  }

  // No existing valid keypair → generate new
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256",
    },
    true,
    ["deriveKey", "deriveBits"]
  );

  const publicJwk = await window.crypto.subtle.exportKey(
    "jwk",
    keyPair.publicKey
  );
  const privateJwk = await window.crypto.subtle.exportKey(
    "jwk",
    keyPair.privateKey
  );

  localStorage.setItem(
    storageKey,
    JSON.stringify({ publicJwk, privateJwk })
  );

  return keyPair;
}

// base64 helpers
function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToBytes(b64) {
  const binary = window.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// Derive a symmetric AES key for a DM conversation using ECDH
async function deriveDmKeyForConversation({
  conversation,
  currentUserId,
  myKeyPair,
  fetchUserPublicKeyJwk,
}) {
  const memberIds = conversation.memberIds || [];
  const otherId = memberIds.find((id) => id !== currentUserId);
  if (!otherId) {
    throw new Error("No other member in DM");
  }

  const otherJwk = await fetchUserPublicKeyJwk(otherId);
  if (!otherJwk) {
    throw new Error(
      "Recipient has no public key on server yet (they probably have not opened chat)"
    );
  }

  const otherPublicKey = await window.crypto.subtle.importKey(
    "jwk",
    otherJwk,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    []
  );

  const aesKey = await window.crypto.subtle.deriveKey(
    {
      name: "ECDH",
      public: otherPublicKey,
    },
    myKeyPair.privateKey,
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"]
  );

  return aesKey;
}

// Encrypt arbitrary text using AES-GCM key
async function encryptWithAesGcm(plaintext, aesKey) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);
  const ivBytes = window.crypto.getRandomValues(new Uint8Array(12));

  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ivBytes,
    },
    aesKey,
    data
  );

  const ciphertextBytes = new Uint8Array(ciphertextBuffer);

  return {
    ciphertext: bytesToBase64(ciphertextBytes),
    iv: bytesToBase64(ivBytes),
  };
}

// Decrypt arbitrary text using AES-GCM key
async function decryptWithAesGcm(payload, aesKey) {
  const ivBytes = base64ToBytes(payload.iv);
  const ciphertextBytes = base64ToBytes(payload.ciphertext);

  const plaintextBuffer = await window.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ivBytes,
    },
    aesKey,
    ciphertextBytes
  );

  const decoder = new TextDecoder();
  return decoder.decode(plaintextBuffer);
}

// Convenience wrappers for "message encryption" payload shape
async function encryptDmMessage(plaintext, aesKey) {
  const { ciphertext, iv } = await encryptWithAesGcm(plaintext, aesKey);
  return {
    e2ee: true,
    version: 1,
    algo: "AES-GCM",
    iv,
    ciphertext,
  };
}

async function decryptDmMessage(payload, aesKey) {
  return decryptWithAesGcm(payload, aesKey);
}

// Group key: generate a random base64 string (32 bytes)
function generateRandomGroupKeyString() {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

// Import group key string into AES-GCM CryptoKey
async function importAesKeyFromGroupKeyString(groupKeyString) {
  const keyBytes = base64ToBytes(groupKeyString);
  return window.crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

// -----------------------
// CHAT COMPONENT
// -----------------------

export default function Chat() {
  const [currentUser, setCurrentUser] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] =
    useState("global");

  const [allUsers, setAllUsers] = useState([]);
  const [messagesByConversation, setMessagesByConversation] =
    useState({});

  const [input, setInput] = useState("");

  const [userSearchTerm, setUserSearchTerm] = useState("");

  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState([]);

  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [manageSearchTerm, setManageSearchTerm] = useState("");

  // Unread messages per conversation
  const [unreadCounts, setUnreadCounts] = useState({});

  // Track last active timestamp for sorting
  const [lastActive, setLastActive] = useState({});

  // Scroll handling
  const [isUserAtBottom, setIsUserAtBottom] = useState(true);
  const messagesContainerRef = useRef(null);
  const messagesEndRef = useRef(null);

  // E2EE state
  const [myKeyPair, setMyKeyPair] = useState(null);
  const publicKeyCacheRef = useRef({}); // userId -> publicKey JWK

  const [decryptedMessages, setDecryptedMessages] = useState({});

  // Group key map: convId -> { cryptoKey, version, keyString }
  const [groupKeyMap, setGroupKeyMap] = useState({});

  const navigate = useNavigate();
  const selectedConversationRef = useRef(selectedConversationId);

  // Keep selected conversation in a ref for socket handlers
  useEffect(() => {
    selectedConversationRef.current = selectedConversationId;
  }, [selectedConversationId]);

  // ---------- DERIVED DATA ----------
  const currentConversation = useMemo(
    () =>
      conversations.find((c) => c.id === selectedConversationId) ||
      null,
    [conversations, selectedConversationId]
  );

  const currentMessages =
    messagesByConversation[selectedConversationId] || [];

  const isGroup =
    currentConversation && currentConversation.type === "group";

  const isGroupOwner =
    isGroup &&
    currentUser &&
    currentConversation.ownerId === currentUser.id;

  const canManageGroupMembers =
    isGroup &&
    currentUser &&
    (currentConversation.ownerId === currentUser.id ||
      (Array.isArray(currentConversation.adminIds) &&
        currentConversation.adminIds.includes(currentUser.id)));

  const conversationMembers = useMemo(() => {
    if (!isGroup) return [];
    const ids = currentConversation.memberIds || [];
    return ids
      .map((id) => allUsers.find((u) => u.id === id))
      .filter(Boolean);
  }, [isGroup, currentConversation, allUsers]);

  const ownerUser = useMemo(() => {
    if (!isGroup) return null;
    return (
      allUsers.find((u) => u.id === currentConversation.ownerId) ||
      null
    );
  }, [isGroup, currentConversation, allUsers]);

  const adminUsers = useMemo(() => {
    if (!isGroup) return [];
    const adminIds = currentConversation.adminIds || [];
    return adminIds
      .filter((id) => id !== currentConversation.ownerId)
      .map((id) => allUsers.find((u) => u.id === id))
      .filter(Boolean);
  }, [isGroup, currentConversation, allUsers]);

  const regularMembers = useMemo(() => {
    if (!isGroup) return [];
    const excluded = new Set([
      currentConversation.ownerId,
      ...(currentConversation.adminIds || []),
    ]);
    return (currentConversation.memberIds || [])
      .filter((id) => !excluded.has(id))
      .map((id) => allUsers.find((u) => u.id === id))
      .filter(Boolean);
  }, [isGroup, currentConversation, allUsers]);

  const addableUsers = useMemo(() => {
    if (!isGroup) return [];
    const memberSet = new Set(currentConversation.memberIds || []);
    return allUsers.filter((u) => !memberSet.has(u.id));
  }, [isGroup, currentConversation, allUsers]);

  const filteredAddableUsers = useMemo(() => {
    const term = manageSearchTerm.trim().toLowerCase();
    if (!term) return addableUsers;
    return addableUsers.filter((u) =>
      (u.username || "").toLowerCase().includes(term)
    );
  }, [addableUsers, manageSearchTerm]);

  const filteredUsers = useMemo(() => {
    const term = userSearchTerm.trim().toLowerCase();
    return allUsers
      .filter((u) => u.id !== currentUser?.id)
      .filter((u) =>
        term
          ? (u.username || "").toLowerCase().includes(term)
          : true
      );
  }, [allUsers, currentUser, userSearchTerm]);

  const newGroupSelectedUsers = useMemo(
    () =>
      groupMemberIds
        .map((id) => allUsers.find((u) => u.id === id))
        .filter(Boolean),
    [groupMemberIds, allUsers]
  );

  // ---------- INITIAL AUTH + SOCKET + DATA ----------
  useEffect(() => {
    const storedUser = localStorage.getItem("user");
    const token = localStorage.getItem("token");

    if (!storedUser || !token) {
      navigate("/");
      return;
    }

    const user = JSON.parse(storedUser);
    setCurrentUser(user);

    socket.auth = { token };
    socket.connect();

    // MESSAGE HISTORY (on join)
    socket.on("chat:history", (payload) => {
      if (!payload) return;

      if (Array.isArray(payload)) {
        setMessagesByConversation((prev) => ({
          ...prev,
          global: payload,
        }));
        return;
      }

      const { conversationId, messages } = payload;
      if (!conversationId) return;

      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: Array.isArray(messages) ? messages : [],
      }));
    });

    // NEW MESSAGE
    socket.on("chat:message", (msg) => {
      if (!msg) return;

      const convId = msg.conversationId || "global";

      setMessagesByConversation((prev) => ({
        ...prev,
        [convId]: [...(prev[convId] || []), msg],
      }));

      setLastActive((prev) => ({
        ...prev,
        [convId]: Date.now(),
      }));

      setUnreadCounts((prev) => {
        if (convId === selectedConversationRef.current) return prev;
        return { ...prev, [convId]: (prev[convId] || 0) + 1 };
      });
    });

    // MESSAGE DELETED
    socket.on("chat:message-deleted", ({ conversationId, messageId }) => {
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] || []).filter(
          (m) => m.id !== messageId
        ),
      }));
    });

    // NEW CONVERSATION CREATED
    socket.on("conversation:created", (conv) => {
      if (!conv || !conv.id) return;

      setConversations((prev) => {
        if (prev.some((c) => c.id === conv.id)) return prev;
        return [...prev, conv];
      });

      setLastActive((prev) => ({
        ...prev,
        [conv.id]: Date.now(),
      }));
    });

    // CONVERSATION UPDATED
    socket.on("conversation:update", (conv) => {
      if (!conv || !conv.id) return;

      setConversations((prev) =>
        prev.map((c) => (c.id === conv.id ? { ...c, ...conv } : c))
      );

      setLastActive((prev) => ({
        ...prev,
        [conv.id]: Date.now(),
      }));

      if (selectedConversationRef.current === conv.id) {
        setUnreadCounts((prev) => {
          const copy = { ...prev };
          delete copy[conv.id];
          return copy;
        });
      }
    });

    // REMOVED FROM GROUP
    socket.on("conversation:removed", ({ id }) => {
      if (!id) return;

      setConversations((prev) => prev.filter((c) => c.id !== id));

      setMessagesByConversation((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setUnreadCounts((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setLastActive((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setGroupKeyMap((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setSelectedConversationId((prevId) =>
        prevId === id ? "global" : prevId
      );
    });

    // GROUP DISBANDED
    socket.on("conversation:deleted", ({ id }) => {
      if (!id) return;

      setConversations((prev) => prev.filter((c) => c.id !== id));

      setMessagesByConversation((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setUnreadCounts((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setLastActive((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setGroupKeyMap((prev) => {
        const copy = { ...prev };
        delete copy[id];
        return copy;
      });

      setSelectedConversationId((prevId) =>
        prevId === id ? "global" : prevId
      );
    });

    let usersPollId;

    const fetchInitial = async () => {
      try {
        const headers = { Authorization: `Bearer ${token}` };

        const [usersRes, convRes] = await Promise.all([
          fetch(`${API_BASE}/api/users`, { headers }),
          fetch(`${API_BASE}/api/conversations`, { headers }),
        ]);

        if (usersRes.ok) {
          const usersData = await usersRes.json();
          setAllUsers(Array.isArray(usersData) ? usersData : []);
        }

        let convData = [];
        if (convRes.ok) {
          convData = await convRes.json();
          convData = Array.isArray(convData) ? convData : [];
        }

        const hasGlobal = convData.some((c) => c.id === "global");

        const baseConvs = hasGlobal
          ? convData
          : [
              {
                id: "global",
                type: "public",
                name: "Global Chat",
                memberIds: [],
                ownerId: null,
                adminIds: [],
                createdAt: new Date().toISOString(),
                encryptedKeys: {},
                keyVersion: 0,
              },
              ...convData,
            ];

        const initialActive = {};
        baseConvs.forEach((c) => {
          initialActive[c.id] = Date.now();
        });

        setLastActive(initialActive);
        setConversations(baseConvs);

        baseConvs.forEach((conv) => {
          if (conv.id !== "global") {
            socket.emit("chat:join", { conversationId: conv.id });
          }
        });

        usersPollId = setInterval(async () => {
          try {
            const res = await fetch(`${API_BASE}/api/users`, {
              headers,
            });
            if (res.ok) {
              const usersData = await res.json();
              if (Array.isArray(usersData)) {
                setAllUsers(usersData);
              }
            }
          } catch (e) {
            console.error("User poll error", e);
          }
        }, 15000);
      } catch (err) {
        console.error("init error", err);
      }

      socket.emit("chat:join", { conversationId: "global" });
    };

    fetchInitial();

    return () => {
      socket.off("chat:history");
      socket.off("chat:message");
      socket.off("chat:message-deleted");
      socket.off("conversation:created");
      socket.off("conversation:update");
      socket.off("conversation:removed");
      socket.off("conversation:deleted");
      if (usersPollId) clearInterval(usersPollId);
      socket.disconnect();
    };
  }, [navigate]);

  // ---------- E2EE INIT (keypair + upload public key) ----------
  useEffect(() => {
    if (!currentUser) return;
    if (!window.crypto || !window.crypto.subtle) {
      console.warn("Web Crypto not available; E2EE disabled.");
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        const kp = await loadOrCreateKeyPairForUser(currentUser.id);
        if (cancelled) return;
        setMyKeyPair(kp);

        const publicJwk = await window.crypto.subtle.exportKey(
          "jwk",
          kp.publicKey
        );

        const token = localStorage.getItem("token");
        if (!token) return;

        await fetch(`${API_BASE}/api/users/keys`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ publicKey: publicJwk }),
        });
      } catch (e) {
        console.error("E2EE init failed", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  // ---------- SCROLL HANDLING ----------
  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const threshold = 50;
      const atBottom =
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - threshold;

      setIsUserAtBottom(atBottom);
    };

    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, []);

  // Auto-scroll on new messages
  useEffect(() => {
    if (!isUserAtBottom) return;
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [currentMessages, isUserAtBottom]);

  // ---------- E2EE PUBLIC KEY FETCHER (per user) ----------
  const getUserPublicKeyJwk = async (userId) => {
    if (!userId) return null;
    const cache = publicKeyCacheRef.current;
    if (cache[userId]) return cache[userId];

    const token = localStorage.getItem("token");
    if (!token) return null;

    try {
      const res = await fetch(
        `${API_BASE}/api/users/${userId}/public-key`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      if (!res.ok) return null;
      const data = await res.json();
      if (!data.publicKey) return null;
      cache[userId] = data.publicKey;
      return data.publicKey;
    } catch (e) {
      console.error("Failed to fetch user public key", e);
      return null;
    }
  };

  // ---------- GROUP KEY HELPERS ----------

  // Ensure we have a usable AES key + groupKeyString for a group
  const ensureGroupKey = async (conversation) => {
    if (
      !conversation ||
      conversation.type !== "group" ||
      !currentUser ||
      !myKeyPair
    ) {
      return null;
    }
    if (!window.crypto || !window.crypto.subtle) return null;

    const convId = conversation.id;
    const version = conversation.keyVersion || 0;

    const existing = groupKeyMap[convId];
    if (existing && existing.version === version) {
      return existing;
    }

    const encMap = conversation.encryptedKeys || {};
    let entry = encMap[currentUser.id];
    if (!entry) {
      // No encrypted key for this user yet
      return null;
    }

    if (typeof entry === "string") {
      try {
        entry = JSON.parse(entry);
      } catch {
        return null;
      }
    }

    if (!entry.ciphertext || !entry.iv || !entry.from) {
      return null;
    }

    const fromUserId = entry.from;
    const wrapperJwk = await getUserPublicKeyJwk(fromUserId);
    if (!wrapperJwk) {
      throw new Error("Missing wrapper public key");
    }

    const wrapperPublicKey = await window.crypto.subtle.importKey(
      "jwk",
      wrapperJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );

    const wrapKey = await window.crypto.subtle.deriveKey(
      {
        name: "ECDH",
        public: wrapperPublicKey,
      },
      myKeyPair.privateKey,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["encrypt", "decrypt"]
    );

    const groupKeyString = await decryptDmMessage(entry, wrapKey);
    const aesKey = await importAesKeyFromGroupKeyString(groupKeyString);

    const record = {
      cryptoKey: aesKey,
      version,
      keyString: groupKeyString,
    };

    setGroupKeyMap((prev) => ({
      ...prev,
      [convId]: record,
    }));

    return record;
  };

  // Build encrypted group key blobs for a set of member IDs
  const buildEncryptedGroupKeysForMembers = async (
    memberIds,
    groupKeyString
  ) => {
    if (!myKeyPair || !currentUser) {
      throw new Error("Missing E2EE key material for group key distribution");
    }
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Web Crypto not available");
    }

    const result = {};

    for (const memberId of memberIds) {
      const pubJwk = await getUserPublicKeyJwk(memberId);
      if (!pubJwk) {
        throw new Error(
          `User with id ${memberId} has no E2EE public key yet. Ask them to log in once.`
        );
      }

      const memberPublicKey = await window.crypto.subtle.importKey(
        "jwk",
        pubJwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
      );

      const wrapKey = await window.crypto.subtle.deriveKey(
        {
          name: "ECDH",
          public: memberPublicKey,
        },
        myKeyPair.privateKey,
        {
          name: "AES-GCM",
          length: 256,
        },
        false,
        ["encrypt", "decrypt"]
      );

      const payload = await encryptDmMessage(
        groupKeyString,
        wrapKey
      );

      result[memberId] = {
        ...payload,
        from: currentUser.id,
      };
    }

    return result;
  };

  // Update encrypted group keys on the server for a conversation
  const patchGroupKeysOnServer = async (
    conversationId,
    encryptedKeys,
    keyVersion
  ) => {
    const token = localStorage.getItem("token");
    if (!token) return null;

    const res = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/keys`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          encryptedKeys,
          keyVersion,
        }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || "Failed to update group keys");
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === data.id ? { ...c, ...data } : c))
    );

    return data;
  };

  // Rotate group key after a member is removed
  const rotateGroupKeyForConversation = async (conv) => {
    if (!conv || conv.type !== "group") return;
    if (!currentUser || !myKeyPair) return;
    if (!window.crypto || !window.crypto.subtle) return;

    const memberIds = Array.isArray(conv.memberIds)
      ? conv.memberIds.slice()
      : [];
    if (memberIds.length === 0) return;

    const newGroupKeyString = generateRandomGroupKeyString();
    const encryptedKeys = await buildEncryptedGroupKeysForMembers(
      memberIds,
      newGroupKeyString
    );

    const newVersion = (conv.keyVersion || 0) + 1;
    const updated = await patchGroupKeysOnServer(
      conv.id,
      encryptedKeys,
      newVersion
    );

    const aesKey = await importAesKeyFromGroupKeyString(
      newGroupKeyString
    );
    setGroupKeyMap((prev) => ({
      ...prev,
      [conv.id]: {
        cryptoKey: aesKey,
        version: newVersion,
        keyString: newGroupKeyString,
      },
    }));

    return updated;
  };

  // After adding a member, include their encrypted group key (no rotation)
  const addMemberKeyForConversation = async (conv, newMemberId) => {
    if (!conv || conv.type !== "group") return;
    if (!currentUser || !myKeyPair) return;
    if (!window.crypto || !window.crypto.subtle) return;

    const keyEntry =
      groupKeyMap[conv.id] || (await ensureGroupKey(conv));
    if (!keyEntry || !keyEntry.keyString) {
      console.warn(
        "Cannot add member group key: no current group key material"
      );
      return;
    }

    const groupKeyString = keyEntry.keyString;

    const encryptedForNew = await buildEncryptedGroupKeysForMembers(
      [newMemberId],
      groupKeyString
    );

    const currentEncrypted =
      (conv.encryptedKeys && typeof conv.encryptedKeys === "object"
        ? conv.encryptedKeys
        : {});

    const merged = {
      ...currentEncrypted,
      ...encryptedForNew,
    };

    const version = conv.keyVersion || 0;

    const updated = await patchGroupKeysOnServer(
      conv.id,
      merged,
      version
    );

    setGroupKeyMap((prev) => ({
      ...prev,
      [conv.id]: {
        cryptoKey: keyEntry.cryptoKey,
        version: updated.keyVersion,
        keyString: groupKeyString,
      },
    }));

    return updated;
  };

  // ---------- E2EE ENCRYPTION WRAPPER ----------
  const encryptForConversation = async (plaintext, conversation) => {
    if (!conversation || !isConversationE2EE(conversation)) {
      return { plaintext };
    }

    if (!currentUser) {
      throw new Error("No current user");
    }
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Web Crypto not available");
    }

    if (conversation.type === "dm") {
      if (!myKeyPair) {
        throw new Error("Missing E2EE keypair for DM");
      }

      const aesKey = await deriveDmKeyForConversation({
        conversation,
        currentUserId: currentUser.id,
        myKeyPair,
        fetchUserPublicKeyJwk: getUserPublicKeyJwk,
      });

      const payload = await encryptDmMessage(plaintext, aesKey);
      return payload;
    }

    if (conversation.type === "group") {
      const keyEntry =
        groupKeyMap[conversation.id] ||
        (await ensureGroupKey(conversation));
      if (!keyEntry || !keyEntry.cryptoKey) {
        throw new Error(
          "Group key is not available yet for this conversation"
        );
      }

      const payload = await encryptDmMessage(
        plaintext,
        keyEntry.cryptoKey
      );
      return payload;
    }

    return { plaintext };
  };

  // ---------- E2EE DECRYPTION EFFECT (DM + Group) ----------
  useEffect(() => {
    const conv = currentConversation;
    if (!conv || !isConversationE2EE(conv)) return;
    if (!currentUser) return;
    if (!window.crypto || !window.crypto.subtle) return;

    let cancelled = false;

    (async () => {
      try {
        let aesKey = null;

        if (conv.type === "dm") {
          if (!myKeyPair) return;
          aesKey = await deriveDmKeyForConversation({
            conversation: conv,
            currentUserId: currentUser.id,
            myKeyPair,
            fetchUserPublicKeyJwk: getUserPublicKeyJwk,
          });
        } else if (conv.type === "group") {
          const keyEntry =
            groupKeyMap[conv.id] || (await ensureGroupKey(conv));
          if (!keyEntry || !keyEntry.cryptoKey) return;
          aesKey = keyEntry.cryptoKey;
        } else {
          return;
        }

        const updates = {};

        for (const msg of currentMessages) {
          if (!msg.text) continue;

          let parsed;
          try {
            parsed = JSON.parse(msg.text);
          } catch {
            updates[msg.id] = msg.text;
            continue;
          }

          if (
            !parsed ||
            !parsed.e2ee ||
            !parsed.ciphertext ||
            !parsed.iv
          ) {
            updates[msg.id] = msg.text;
            continue;
          }

          try {
            const plaintext = await decryptDmMessage(parsed, aesKey);
            updates[msg.id] = plaintext;
          } catch (e) {
            console.error("E2EE decrypt failed", e);
            updates[msg.id] =
              "[Encrypted message – unable to decrypt]";
          }
        }

        if (cancelled) return;
        setDecryptedMessages((prev) => ({
          ...prev,
          ...updates,
        }));
      } catch (e) {
        console.error("E2EE batch decrypt failed", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    currentMessages,
    currentConversation,
    myKeyPair,
    currentUser,
    groupKeyMap,
  ]);

  // ---------- HELPERS ----------
  const conversationLabel = (conv) => {
    if (!conv) return "Conversation";
    if (conv.id === "global") return "Global Chat";

    if (conv.type === "dm" && currentUser) {
      const otherId = conv.memberIds?.find(
        (id) => id !== currentUser.id
      );
      const u = allUsers.find((x) => x.id === otherId);
      return u ? `DM: ${u.username}` : "DM";
    }

    return conv.name || "Group";
  };

  const joinConversation = (id) => {
    setSelectedConversationId(id);
    socket.emit("chat:join", { conversationId: id });

    setUnreadCounts((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });

    setLastActive((prev) => ({
      ...prev,
      [id]: Date.now(),
    }));
  };

  const sendMessage = async () => {
    if (!input.trim() || !currentUser) return;

    const conv =
      conversations.find((c) => c.id === selectedConversationId) ||
      null;
    let textToSend = input.trim();

    if (conv && isConversationE2EE(conv)) {
      try {
        const encryptedPayload = await encryptForConversation(
          textToSend,
          conv
        );

        if (encryptedPayload && encryptedPayload.e2ee) {
          textToSend = JSON.stringify(encryptedPayload);
        } else if (encryptedPayload && encryptedPayload.plaintext) {
          textToSend = encryptedPayload.plaintext;
        }
      } catch (e) {
        console.error("E2EE send failed", e);
        const msg = e.message || "";
        if (msg.includes("public key")) {
          alert(
            "This conversation is encrypted, but at least one member has not opened chat yet to register their key.\nAsk them to log in once, then try again."
          );
        } else {
          alert("Could not encrypt message. Please try again.");
        }
        return;
      }
    }

    socket.emit("chat:send", {
      conversationId: selectedConversationId || "global",
      text: textToSend,
    });

    setInput("");
  };

  const handleLogout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    socket.disconnect();
    navigate("/");
  };

  // Start a DM with a user
  const startDmWith = async (username) => {
    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(`${API_BASE}/api/conversations/dm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ targetUsername: username }),
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Could not start DM");
      return;
    }

    setConversations((prev) =>
      prev.some((c) => c.id === data.id) ? prev : [...prev, data]
    );

    setLastActive((prev) => ({
      ...prev,
      [data.id]: Date.now(),
    }));

    joinConversation(data.id);
  };

  // Group creation logic (with E2EE group key distribution)
  const submitCreateGroup = async () => {
    const token = localStorage.getItem("token");
    if (!token) return;
    if (!currentUser) return;

    if (!groupName.trim()) {
      alert("Enter a group name.");
      return;
    }

    // All members that must have group key (including creator)
    const allMemberIds = Array.from(
      new Set([currentUser.id, ...groupMemberIds])
    );

    let payload = {
      name: groupName.trim(),
      memberIds: groupMemberIds,
    };

    let groupKeyString = null;
    let encryptedKeys = null;
    let keyVersion = 0;

    if (
      window.crypto &&
      window.crypto.subtle &&
      myKeyPair &&
      allMemberIds.length > 0
    ) {
      try {
        groupKeyString = generateRandomGroupKeyString();
        encryptedKeys = await buildEncryptedGroupKeysForMembers(
          allMemberIds,
          groupKeyString
        );
        keyVersion = 1;

        payload.encryptedKeys = encryptedKeys;
        payload.keyVersion = keyVersion;
      } catch (e) {
        console.error("Group E2EE init failed", e);
        alert(
          e.message ||
            "Failed to initialize encryption for this group. Make sure all members have logged in once."
        );
        return;
      }
    }

    const res = await fetch(`${API_BASE}/api/conversations/group`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Could not create group");
      return;
    }

    // Store our own group key in memory if we created one
    if (groupKeyString && keyVersion === 1 && data.id) {
      try {
        const aesKey = await importAesKeyFromGroupKeyString(
          groupKeyString
        );
        setGroupKeyMap((prev) => ({
          ...prev,
          [data.id]: {
            cryptoKey: aesKey,
            version: keyVersion,
            keyString: groupKeyString,
          },
        }));
      } catch (e) {
        console.error("Failed to cache group key locally", e);
      }
    }

    setIsCreatingGroup(false);
    setGroupName("");
    setGroupMemberIds([]);

    joinConversation(data.id);
  };

  const cancelCreateGroup = () => {
    setIsCreatingGroup(false);
    setGroupName("");
    setGroupMemberIds([]);
  };

  const toggleUserInNewGroup = (userId) => {
    setGroupMemberIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  // Group actions
  const addUserToCurrentGroup = async (userId) => {
    if (!currentConversation) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/add-member`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to add member");
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === data.id ? { ...c, ...data } : c))
    );

    // E2EE: wrap current group key for new member, no rotation
    try {
      await addMemberKeyForConversation(data, userId);
    } catch (e) {
      console.error("Failed to add member group key", e);
      alert(
        e.message ||
          "Member added, but failed to update encrypted group key for them."
      );
    }
  };

  const removeUserFromCurrentGroup = async (userId) => {
    if (!currentConversation) return;

    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/remove-member`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to remove member");
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === data.id ? { ...c, ...data } : c))
    );

    // E2EE: rotate group key after removal
    try {
      await rotateGroupKeyForConversation(data);
    } catch (e) {
      console.error("Failed to rotate group key after removal", e);
      alert(
        e.message ||
          "Member removed, but failed to rotate encrypted group key. Consider recreating the group if needed."
      );
    }
  };

  const promoteUserInCurrentGroup = async (userId) => {
    if (!currentConversation) return;

    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/promote-admin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ userId }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to promote");
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === data.id ? { ...c, ...data } : c))
    );
  };

  const demoteUserInCurrentGroup = async (userId) => {
    if (!currentConversation) return;

    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/demote-admin`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}` },
        body: JSON.stringify({ userId }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to demote");
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === data.id ? { ...c, ...data } : c))
    );
  };

  const transferOwnership = async (newOwnerId) => {
    if (!currentConversation) return;

    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/transfer-ownership`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}` },
        body: JSON.stringify({ newOwnerId }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Ownership transfer failed");
      return;
    }

    setConversations((prev) =>
      prev.map((c) => (c.id === data.id ? { ...c, ...data } : c))
    );
  };

  const disbandCurrentGroup = async () => {
    if (!currentConversation || !isGroupOwner) return;

    const confirmDelete = window.confirm(
      "Disband this group for everyone?"
    );
    if (!confirmDelete) return;

    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed");
      return;
    }

    setConversations((prev) =>
      prev.filter((c) => c.id !== currentConversation.id)
    );

    setUnreadCounts((prev) => {
      const copy = { ...prev };
      delete copy[currentConversation.id];
      return copy;
    });

    setLastActive((prev) => {
      const copy = { ...prev };
      delete copy[currentConversation.id];
      return copy;
    });

    setGroupKeyMap((prev) => {
      const copy = { ...prev };
      delete copy[currentConversation.id];
      return copy;
    });

    setSelectedConversationId("global");
    setShowSettingsModal(false);

    socket.emit("chat:join", { conversationId: "global" });
  };

  const leaveCurrentGroup = async () => {
    if (!currentConversation || !isGroup) return;

    if (isGroupOwner) {
      alert("Transfer ownership first.");
      return;
    }

    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/leave`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to leave");
      return;
    }

    setConversations((prev) =>
      prev.filter((c) => c.id !== currentConversation.id)
    );

    setUnreadCounts((prev) => {
      const copy = { ...prev };
      delete copy[currentConversation.id];
      return copy;
    });

    setLastActive((prev) => {
      const copy = { ...prev };
      delete copy[currentConversation.id];
      return copy;
    });

    setGroupKeyMap((prev) => {
      const copy = { ...prev };
      delete copy[currentConversation.id];
      return copy;
    });

    setSelectedConversationId("global");
    setShowSettingsModal(false);
    socket.emit("chat:join", { conversationId: "global" });
  };

  const deleteMessage = async (conversationId, messageId) => {
    const token = localStorage.getItem("token");
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${conversationId}/messages/${messageId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed");
      return;
    }

    setMessagesByConversation((prev) => ({
      ...prev,
      [conversationId]: (prev[conversationId] || []).filter(
        (m) => m.id !== messageId
      ),
    }));
  };

  // --------------- RENDER ---------------
  if (!currentUser) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0d1117] text-gray-300">
        Loading…
      </div>
    );
  }

  const convIsE2EE = isConversationE2EE(currentConversation);

  return (
    <div className="flex h-screen flex-col bg-[#0d1117] text-gray-200 md:flex-row">
      {/* LEFT SIDEBAR */}
      <div className="hidden w-64 flex-col border-r border-[#1f2937] bg-[#161b22] md:flex">
        <div className="flex items-center justify-between px-4 pb-3 pt-4 border-b border-[#1f2937]">
          <h2 className="text-sm font-semibold text-gray-100">
            Conversations
          </h2>
          {!isCreatingGroup && (
            <button
              onClick={() => setIsCreatingGroup(true)}
              className="rounded bg-teal-500 px-2 py-1 text-xs font-medium text-white hover:bg-teal-400"
            >
              New group
            </button>
          )}
        </div>

        {isCreatingGroup && (
          <div className="border-b border-[#1f2937] px-4 py-3 space-y-2">
            <input
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
              placeholder="Group name"
              className="w-full rounded-md border border-gray-700 bg-[#0d1117] px-2 py-1 text-xs text-gray-200"
            />
            <p className="text-xs text-gray-400">
              Add members from the right panel.
            </p>
            <div className="flex flex-wrap gap-1">
              {newGroupSelectedUsers.map((u) => (
                <span
                  key={u.id}
                  className="rounded border border-gray-700 px-2 py-0.5 text-[11px]"
                >
                  {u.username}
                </span>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={cancelCreateGroup}
                className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-300 hover:bg-[#0d1117]"
              >
                Cancel
              </button>
              <button
                onClick={submitCreateGroup}
                className="rounded bg-teal-500 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-400"
              >
                Create
              </button>
            </div>
          </div>
        )}

        {/* SORTED LIST */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {[...conversations]
            .sort((a, b) => {
              if (a.id === "global") return -1;
              if (b.id === "global") return 1;

              const ua = unreadCounts[a.id] || 0;
              const ub = unreadCounts[b.id] || 0;
              if (ua !== ub) return ub - ua;

              const ta = lastActive[a.id] || 0;
              const tb = lastActive[b.id] || 0;
              return tb - ta;
            })
            .map((conv) => {
              const isSelected =
                conv.id === selectedConversationId;
              const unread = unreadCounts[conv.id] > 0;

              let styles = "";
              if (isSelected) {
                styles =
                  "bg-[#1f2937] text-gray-100 font-semibold";
              } else if (unread) {
                styles =
                  "bg-[#065f46] text-white font-semibold hover:bg-[#047857]";
              } else {
                styles = "text-gray-400 hover:bg-[#1f2937]";
              }

              return (
                <button
                  key={conv.id}
                  onClick={() => joinConversation(conv.id)}
                  className={`w-full text-left px-3 py-2 rounded mb-1 text-xs flex items-center justify-between ${styles}`}
                >
                  <span className="truncate">
                    {conversationLabel(conv)}
                    {isConversationE2EE(conv) && ""}
                  </span>

                  {unread && (
                    <span className="ml-2 rounded-full bg-teal-500 px-2 py-0.5 text-[10px] font-semibold text-white">
                      {unreadCounts[conv.id]}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      </div>

      {/* MAIN CHAT AREA */}
      <div className="flex flex-1 flex-col bg-[#0d1117]">
        {/* Header */}
        <div className="border-b border-[#1f2937] bg-[#161b22] px-4 py-3 flex justify-between">
          <div>
            <div className="text-xs text-gray-500 uppercase tracking-widest">
              SafeSpace
            </div>
            <div className="text-sm font-semibold">
              {conversationLabel(currentConversation)}
              {convIsE2EE && ""}
            </div>
            <div className="text-[11px] text-gray-400">
              Signed in as {currentUser.username}
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="rounded bg-slate-800 px-2 py-1 text-xs font-medium text-gray-200 hover:bg-slate-700"
          >
            Log out
          </button>
        </div>

        {/* Members bar for groups */}
        {isGroup && (
          <div className="border-b border-[#1f2937] bg-[#161b22] px-4 py-2">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-[11px] text-gray-500 uppercase">
                  Members
                </div>
                <div className="flex flex-wrap mt-1 gap-1">
                  {conversationMembers.map((m) => (
                    <span
                      key={m.id}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-gray-700 bg-[#0d1117]"
                    >
                      {m.username}
                    </span>
                  ))}
                </div>
              </div>

              <button
                onClick={() => setShowSettingsModal(true)}
                className="h-7 self-center rounded bg-slate-800 px-2 text-[11px] text-gray-100 hover:bg-slate-700"
              >
                Settings
              </button>
            </div>
          </div>
        )}

        {/* MESSAGES */}
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto px-4 py-3 flex flex-col bg-[#0d1117]"
        >
          {currentMessages.map((msg) => {
            const isSelf = msg.senderId === currentUser.id;
            const displayText = convIsE2EE
              ? decryptedMessages[msg.id] || "[Decrypting…]"
              : msg.text;

            return (
              <div
                key={msg.id}
                className={`mb-2 flex ${
                  isSelf ? "justify-end" : "justify-start"
                }`}
              >
                <div
                  className={`relative max-w-[80%] rounded-lg px-3 py-2 text-xs shadow ${
                    isSelf
                      ? "bg-teal-600 text-white"
                      : "bg-[#161b22] text-gray-200"
                  }`}
                >
                  <div className="text-[10px] mb-1 opacity-70">
                    {msg.senderName}
                  </div>

                  <div className="text-sm whitespace-pre-wrap">
                    {displayText}
                  </div>

                  {isSelf && (
                    <button
                      onClick={() =>
                        deleteMessage(selectedConversationId, msg.id)
                      }
                      className="absolute top-1 right-1 text-[10px] text-gray-200/70 hover:text-red-400"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>

        {/* INPUT BAR */}
        <div className="border-t border-[#1f2937] bg-[#161b22] px-3 py-2">
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Message"
              className="flex-1 rounded bg-[#0d1117] border border-gray-700 px-3 py-2 text-sm text-gray-200"
            />

            <button
              onClick={sendMessage}
              className="rounded bg-teal-500 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-400"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* RIGHT SIDEBAR */}
      <div className="hidden w-64 flex-col border-l border-[#1f2937] bg-[#161b22] md:flex">
        <div className="border-b border-[#1f2937] px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-100">Users</h3>
          <input
            value={userSearchTerm}
            onChange={(e) => setUserSearchTerm(e.target.value)}
            placeholder="Search username"
            className="mt-2 w-full rounded bg-[#0d1117] border border-gray-700 px-2 py-1 text-xs text-gray-200"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {filteredUsers.map((u) => (
            <div
              key={u.id}
              className="mb-2 rounded border border-[#1f2937] bg-[#0d1117] px-3 py-2 text-xs"
            >
              <div className="font-medium text-gray-100">
                {u.username}
              </div>

              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => startDmWith(u.username)}
                  className="rounded bg-slate-800 px-2 py-1 text-[11px] text-gray-100 hover:bg-slate-700"
                >
                  DM
                </button>

                {isCreatingGroup && (
                  <button
                    onClick={() => toggleUserInNewGroup(u.id)}
                    className="rounded bg-[#161b22] border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-[#0d1117]"
                  >
                    {groupMemberIds.includes(u.id)
                      ? "Remove"
                      : "Add"}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* SETTINGS MODAL */}
      {showSettingsModal && isGroup && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
          <div className="w-full max-w-lg rounded-lg bg-[#161b22] p-4 shadow-lg border border-[#1f2937]">
            {/* HEADER */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-100">
                Group Settings – {conversationLabel(currentConversation)}
              </h2>
              <button
                onClick={() => setShowSettingsModal(false)}
                className="text-xs text-gray-400 hover:text-gray-200"
              >
                ✕
              </button>
            </div>

            {/* OWNER */}
            <div className="mb-3">
              <div className="text-[11px] text-gray-500 uppercase mb-1">
                Owner
              </div>
              <div className="rounded border border-[#1f2937] bg-[#0d1117] px-3 py-2 text-xs flex justify-between items-center">
                <div className="font-medium text-gray-100">
                  {ownerUser?.username}
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-gray-300">
                  Owner
                </span>
              </div>
            </div>

            {/* ADMINS */}
            <div className="mb-3">
              <div className="text-[11px] text-gray-500 uppercase mb-1">
                Admins
              </div>

              {adminUsers.length === 0 && (
                <div className="text-[11px] text-gray-500">No admins.</div>
              )}

              {adminUsers.map((a) => (
                <div
                  key={a.id}
                  className="mb-1 rounded border border-[#1f2937] bg-[#0d1117] px-3 py-2 text-xs flex justify-between items-center"
                >
                  <div className="font-medium text-gray-100">
                    {a.username}
                  </div>

                  <div className="flex gap-2 items-center">
                    {canManageGroupMembers && (
                      <button
                        onClick={() => removeUserFromCurrentGroup(a.id)}
                        className="text-[11px] px-2 py-1 rounded bg-slate-800 text-gray-100 hover:bg-slate-700"
                      >
                        Remove
                      </button>
                    )}

                    {isGroupOwner && (
                      <>
                        <button
                          onClick={() => demoteUserInCurrentGroup(a.id)}
                          className="text-[11px] px-2 py-1 rounded border border-slate-600 text-gray-200 hover:bg-[#0d1117]"
                        >
                          Demote
                        </button>

                        {a.id !== currentUser.id && (
                          <button
                            onClick={() => transferOwnership(a.id)}
                            className="text-[11px] px-2 py-1 rounded bg-teal-600 text-white hover:bg-teal-500"
                          >
                            Make owner
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* MEMBERS */}
            <div className="mb-3">
              <div className="text-[11px] text-gray-500 uppercase mb-1">
                Members
              </div>

              {regularMembers.length === 0 && (
                <div className="text-[11px] text-gray-500">No members.</div>
              )}

              {regularMembers.map((m) => (
                <div
                  key={m.id}
                  className="mb-1 rounded border border-[#1f2937] bg-[#0d1117] px-3 py-2 text-xs flex justify-between items-center"
                >
                  <div className="font-medium text-gray-100">
                    {m.username}
                  </div>

                  <div className="flex gap-2 items-center">
                    {canManageGroupMembers && (
                      <button
                        onClick={() => removeUserFromCurrentGroup(m.id)}
                        className="text-[11px] px-2 py-1 rounded bg-slate-800 text-gray-100 hover:bg-slate-700"
                      >
                        Remove
                      </button>
                    )}

                    {isGroupOwner && (
                      <>
                        <button
                          onClick={() => promoteUserInCurrentGroup(m.id)}
                          className="text-[11px] px-2 py-1 rounded border border-slate-600 text-gray-200 hover:bg-[#0d1117]"
                        >
                          Promote
                        </button>

                        <button
                          onClick={() => transferOwnership(m.id)}
                          className="text-[11px] px-2 py-1 rounded bg-teal-600 text-white hover:bg-teal-500"
                        >
                          Make owner
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* ADD MEMBERS */}
            {canManageGroupMembers && (
              <div className="mb-3">
                <div className="text-[11px] text-gray-500 uppercase mb-1">
                  Add members
                </div>

                <input
                  value={manageSearchTerm}
                  onChange={(e) => setManageSearchTerm(e.target.value)}
                  placeholder="Search username"
                  className="mb-2 w-full rounded bg-[#0d1117] border border-gray-700 px-2 py-1 text-xs text-gray-200"
                />

                <div className="max-h-40 overflow-y-auto space-y-1">
                  {filteredAddableUsers.length === 0 && (
                    <div className="text-[11px] text-gray-500">No users.</div>
                  )}

                  {filteredAddableUsers.map((u) => (
                    <div
                      key={u.id}
                      className="rounded border border-[#1f2937] bg-[#0d1117] px-3 py-2 text-xs flex justify-between items-center"
                    >
                      <div className="font-medium text-gray-100">
                        {u.username}
                      </div>
                      <button
                        onClick={() => addUserToCurrentGroup(u.id)}
                        className="text-[11px] px-2 py-1 rounded bg-teal-600 text-white hover:bg-teal-500"
                      >
                        Add
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* FOOTER BUTTONS */}
            <div className="flex justify-between items-center mt-3 gap-2">
              <button
                onClick={() => setShowSettingsModal(false)}
                className="text-xs px-3 py-1 rounded border border-gray-700 text-gray-300 hover:bg-[#0d1117]"
              >
                Close
              </button>

              <button
                onClick={leaveCurrentGroup}
                className="text-xs px-3 py-1 rounded bg-slate-800 text-gray-100 hover:bg-slate-700"
              >
                Leave
              </button>

              {isGroupOwner && (
                <button
                  onClick={disbandCurrentGroup}
                  className="text-xs px-3 py-1 rounded bg-red-600 text-white hover:bg-red-500"
                >
                  Disband
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
