// src/pages/chat.jsx
// Features:
// - Global chat, DMs, groups, admins, ownership, disband
// - Real-time updates via Socket.IO
// - Unread tracking + teal unread highlight (B2)
// - Sorting by unread > lastActive > createdAt
// - Global Chat pinned
// - Auto-leave on removal
// - E2EE for DMs (ECDH + AES-GCM)
// - E2EE for Groups with per-group key + rotation on member removal (atomic server update)
//
// IMPORTANT FIX (group add/remove encryption):
// - Keep GROUP KEYS BY VERSION (do NOT overwrite/delete old keys).
// - Tag each GROUP message with keyVersion used to encrypt.
// - Decrypt using message.keyVersion; if missing (legacy), try all cached versions.

import React, { useEffect, useState, useMemo, useRef, useLayoutEffect, useCallback } from "react";
import { io } from "socket.io-client";
import { useNavigate } from "react-router-dom";

import { API_BASE, SOCKET_URL } from "../config";
import { getToken, clearAuth, setAuth } from "../utils/authStorage";
import ChatSidebar from "../components/chat/ChatSidebar";
import MessageList from "../components/chat/MessageList";
import MessageInput from "../components/chat/MessageInput";
import GifPicker from "../components/chat/GifPicker";
import EmojiPicker from "../components/chat/EmojiPicker";
import * as E2EE from "../utils/e2ee";
import { buildMessagePayload, parseMessagePayload } from "../utils/messagePayload";
import { resolveAttachmentUrl } from "../utils/attachmentUrls";
import {
  getGifFromMessageText,
  isGifAttachment,
  gifKey,
  normalizeGifRecord,
} from "../utils/gifHelpers";
import { useCallManager } from "../hooks/useCallManager";
import IncomingCallModal from "../components/chat/call/IncomingCallModal";
import ActiveCallOverlay from "../components/chat/call/ActiveCallOverlay";

const socket = io(SOCKET_URL, { autoConnect: false });

const MAX_MESSAGE_CHARS = 4000;
const MAX_FILE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB upload limit
const MAX_SOCKET_MESSAGE_BYTES = 20 * 1024 * 1024;

// -----------------------
// CHAT COMPONENT
// -----------------------




export default function Chat() {
  const PAGE_SIZE = 30;
  const WINDOW_SIZE = 90;
  const [currentUser, setCurrentUser] = useState(null);

  const [conversations, setConversations] = useState([]);
  const [selectedConversationId, setSelectedConversationId] = useState("global");

  const [allUsers, setAllUsers] = useState([]);
  const [messagesByConversation, setMessagesByConversation] = useState({});
  const [hasMoreOlder, setHasMoreOlder] = useState(true);
  const [hasMoreNewer, setHasMoreNewer] = useState(false);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const [isLoadingNewer, setIsLoadingNewer] = useState(false);

  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState([]);
  const [isGifPickerOpen, setIsGifPickerOpen] = useState(false);
  const [isEmojiPickerOpen, setIsEmojiPickerOpen] = useState(false);
  const [gifQuery, setGifQuery] = useState("");
  const [gifTab, setGifTab] = useState("search");
  const [gifResults, setGifResults] = useState([]);
  const [gifFavorites, setGifFavorites] = useState([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifError, setGifError] = useState("");
  const [gifSendingKey, setGifSendingKey] = useState("");
  const [userSearchTerm, setUserSearchTerm] = useState("");

  const [isCreatingGroup, setIsCreatingGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState([]);

  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [manageSearchTerm, setManageSearchTerm] = useState("");

  const [transferOwnerId, setTransferOwnerId] = useState("");

  const [unreadCounts, setUnreadCounts] = useState({});
  const [lastActive, setLastActive] = useState({});

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // --- Notification sounds + muted conversations ---
  const [mutedConversations, setMutedConversations] = useState(() => {
    try {
      const raw = localStorage.getItem("ss_muted_convs");
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  });
  const mutedConversationsRef = useRef(mutedConversations);
  mutedConversationsRef.current = mutedConversations;

  const toggleMuteConversation = useCallback((convId) => {
    setMutedConversations((prev) => {
      const next = new Set(prev);
      if (next.has(convId)) next.delete(convId);
      else next.add(convId);
      try { localStorage.setItem("ss_muted_convs", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  const notifAudioCtxRef = useRef(null);
  const playNotificationSound = useCallback(() => {
    try {
      if (!notifAudioCtxRef.current || notifAudioCtxRef.current.state === "closed") {
        notifAudioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = notifAudioCtxRef.current;
      if (ctx.state === "suspended") ctx.resume();

      // Short, pleasant "pop" notification
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);

      // Vibrate on mobile
      if ("vibrate" in navigator) navigator.vibrate(50);
    } catch {}
  }, []);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [detailsTab, setDetailsTab] = useState("details");
  const [activeImage, setActiveImage] = useState(null);
  const mediaScrollRef = useRef(null);

  // --- WebRTC calling ---
  const {
    callState, incomingCall, localStream, screenStream, remoteStreams, remoteMediaState,
    streamUpdateTick, activeCallMap, startCall, acceptCall, rejectCall, leaveCall, toggleMute, toggleVideo, toggleScreenShare,
  } = useCallManager(socket, currentUser);

  const [replyToId, setReplyToId] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [flashHighlightId, setFlashHighlightId] = useState(null);
  const flashTimeoutRef = useRef(null);
  const replyPreviewRef = useRef(null);
  const [hasNewWhileScrolledUp, setHasNewWhileScrolledUp] = useState(false);
  const [isUserAtBottom, setIsUserAtBottom] = useState(true);
  const [containerReadyTick, setContainerReadyTick] = useState(0);
  const messagesContainerRef = useRef(null);
  const messagesEndRef = useRef(null);
  const topSentinelRef = useRef(null);
  const initialHistoryLoadedRef = useRef({});
  const pendingAnchorRef = useRef(null);
  const pendingRestoreRef = useRef(null);
  const scrollStateRef = useRef({});
  const lastScrollTopRef = useRef({});
  const restoringRef = useRef(false);
  const lastAtBottomRef = useRef(true);
  const pagingRef = useRef({});
  const pendingJumpRef = useRef(null);
  const pendingJumpToMessageRef = useRef(null);
  const pendingLatestRef = useRef(null);
  const loadOlderChainRef = useRef(null);

  const handleContainerReady = useCallback(() => {
    setContainerReadyTick((tick) => tick + 1);
  }, []);
  const keyHistoryBackfillRef = useRef({}); // convId -> { [version]: true }
  const keyHistoryPatchInFlightRef = useRef({}); // convId -> boolean
  const keyHistoryFetchRef = useRef({}); // convId -> { [version]: true }

  const [myKeyPair, setMyKeyPair] = useState(null);
  const [myKeyId, setMyKeyId] = useState(null);
  const keyRingRef = useRef(null);
  const myPublicJwkRef = useRef(null);
  const keyPairCacheRef = useRef({});
  const dmKeyCacheRef = useRef({});
  const publicKeyCacheRef = useRef({}); // userId -> publicKey JWK

  const [decryptedMessages, setDecryptedMessages] = useState({});

  // Decryption queue: convId -> Set(messageId)
  const decryptQueueRef = useRef({});

  // Group key map: convId -> { [version]: { cryptoKey, version, keyString } }
  const [groupKeyMap, setGroupKeyMap] = useState({});

  const [attachmentBlobUrls, setAttachmentBlobUrls] = useState({});
  const attachmentDecryptionQueueRef = useRef(new Set());

  // MEDIA LAZY LOADING
  const [mediaMessagesMap, setMediaMessagesMap] = useState(new Map()); // id -> msg
  const mediaCursorRef = useRef(null); // id of oldest fetched message for media scan
  const [isMediaLoading, setIsMediaLoading] = useState(false);
  const [hasMoreMedia, setHasMoreMedia] = useState(true);

  // Sync currentMessages into media map (live updates)
  useEffect(() => {
    const relevant = messagesByConversation[selectedConversationId] || [];
    if (relevant.length === 0) return;

    setMediaMessagesMap((prev) => {
      const next = new Map(prev);
      let changed = false;
      for (const msg of relevant) {
        if (!next.has(msg.id)) {
          // Check if has media
          const raw = decryptedMessages[msg.id] || msg.text;
          const payload = parseMessagePayload(String(raw));
          if (payload && Array.isArray(payload.attachments) && payload.attachments.length > 0) {
            next.set(msg.id, { ...msg, text: raw }); // Store decrypt version
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });

    // Initialize cursor if needed (to the oldest known message in current view if we haven't fetched history yet)
    if (!mediaCursorRef.current && relevant.length > 0) {
      mediaCursorRef.current = relevant[0].id;
    }
  }, [messagesByConversation, selectedConversationId, decryptedMessages]);





  useEffect(() => {
    const relevantMsgs = messagesByConversation[selectedConversationId] || [];
    relevantMsgs.forEach((msg) => {
      if (!msg || !msg.id) return;
      const raw = decryptedMessages[msg.id] || msg.text;
      if (!raw) return;

      const payload = parseMessagePayload(String(raw));
      if (!payload || !payload.attachments) return;

      payload.attachments.forEach((att) => {
        if (att.encrypted && att.url && att.fileKey && att.iv) {
          // Guard against maliciously oversized key material
          if (att.fileKey.length > 128 || att.iv.length > 128) return;
          const cacheKey = att.id || att.url;
          if (attachmentBlobUrls[cacheKey]) return;
          if (attachmentDecryptionQueueRef.current.has(cacheKey)) return;

          attachmentDecryptionQueueRef.current.add(cacheKey);

          (async () => {
            try {
              let targetUrl = resolveAttachmentUrl(att.url);
              if (window.location.protocol === "https:" && targetUrl.startsWith("http:")) {
                targetUrl = targetUrl.replace("http:", "https:");
              }

              const res = await fetch(targetUrl);
              if (!res.ok) throw new Error("Failed to fetch encrypted attachment");
              const encryptedBlob = await res.arrayBuffer();

              const key = await E2EE.importKeyFromString(att.fileKey);
              const iv = E2EE.base64ToBytes(att.iv);
              const decryptedBuffer = await E2EE.decryptFile(encryptedBlob, key, iv);

              const blob = new Blob([decryptedBuffer], { type: att.mime || "application/octet-stream" });
              const blobUrl = URL.createObjectURL(blob);

              setAttachmentBlobUrls((prev) => ({ ...prev, [cacheKey]: blobUrl }));
            } catch (e) {
              console.error("Failed to decrypt attachment", e);
            } finally {
              attachmentDecryptionQueueRef.current.delete(cacheKey);
            }
          })();
        }
      });
    });
  }, [messagesByConversation, selectedConversationId, decryptedMessages, attachmentBlobUrls]);

  // Decrypt encrypted attachments from media tab messages (independent of main chat)
  useEffect(() => {
    for (const [, msg] of mediaMessagesMap.entries()) {
      if (!msg || !msg.id) continue;
      const raw = decryptedMessages[msg.id] || msg.text;
      if (!raw) continue;

      const payload = parseMessagePayload(String(raw));
      if (!payload || !payload.attachments) continue;

      payload.attachments.forEach((att) => {
        if (att.encrypted && att.url && att.fileKey && att.iv) {
          // Guard against maliciously oversized key material
          if (att.fileKey.length > 128 || att.iv.length > 128) return;
          const cacheKey = att.id || att.url;
          if (attachmentBlobUrls[cacheKey]) return;
          if (attachmentDecryptionQueueRef.current.has(cacheKey)) return;

          attachmentDecryptionQueueRef.current.add(cacheKey);

          (async () => {
            try {
              let targetUrl = resolveAttachmentUrl(att.url);
              if (window.location.protocol === "https:" && targetUrl.startsWith("http:")) {
                targetUrl = targetUrl.replace("http:", "https:");
              }

              const res = await fetch(targetUrl);
              if (!res.ok) throw new Error("Failed to fetch encrypted attachment");
              const encryptedBlob = await res.arrayBuffer();

              const key = await E2EE.importKeyFromString(att.fileKey);
              const iv = E2EE.base64ToBytes(att.iv);
              const decryptedBuffer = await E2EE.decryptFile(encryptedBlob, key, iv);

              const blob = new Blob([decryptedBuffer], { type: att.mime || "application/octet-stream" });
              const blobUrl = URL.createObjectURL(blob);

              setAttachmentBlobUrls((prev) => ({ ...prev, [cacheKey]: blobUrl }));
            } catch (e) {
              console.error("Failed to decrypt media tab attachment", e);
            } finally {
              attachmentDecryptionQueueRef.current.delete(cacheKey);
            }
          })();
        }
      });
    }
  }, [mediaMessagesMap, decryptedMessages, attachmentBlobUrls]);

  const navigate = useNavigate();
  const selectedConversationRef = useRef(selectedConversationId);

  const currentUserRef = useRef(currentUser);
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  const messagesByConversationRef = useRef(messagesByConversation);
  useEffect(() => {
    messagesByConversationRef.current = messagesByConversation;
  }, [messagesByConversation]);

  useEffect(() => {
    selectedConversationRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    const prevBodyOverflow = document.body.style.overflow;
    const prevHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBodyOverflow;
      document.documentElement.style.overflow = prevHtmlOverflow;
    };
  }, []);

  const currentConversation = useMemo(
    () => conversations.find((c) => c.id === selectedConversationId) || null,
    [conversations, selectedConversationId]
  );

  const gifFavoriteKeys = useMemo(() => {
    const list = Array.isArray(gifFavorites) ? gifFavorites : [];
    return new Set(list.map((gif) => gifKey(gif)).filter(Boolean));
  }, [gifFavorites]);

  const currentMessages = messagesByConversation[selectedConversationId] || [];

  // Clear media map on conversation switch to prevent mixing
  useEffect(() => {
    setMediaMessagesMap(new Map());
    mediaCursorRef.current = null;
    setHasMoreMedia(true);
    setIsMediaLoading(false);
  }, [selectedConversationId]);

  const mediaItems = useMemo(() => {
    const items = [];
    // Use the map which has ALL media messages (loaded + lazy fetched)
    for (const [id, msg] of mediaMessagesMap.entries()) {
      // Filter strict for current conversation just in case
      if (msg.conversationId && msg.conversationId !== selectedConversationId) continue;

      const raw = decryptedMessages[msg.id] || msg.text;
      const payload = parseMessagePayload(String(raw));
      const attachments = payload && Array.isArray(payload.attachments) ? payload.attachments : [];

      if (attachments.length > 0) {
        attachments.forEach(att => {
          // Only valid images
          const resolvedUrl = resolveAttachmentUrl(att.processedUrl || att.url);
          if (resolvedUrl || att.dataUrl) {
            items.push({
              id: att.id || msg.id + "-" + Math.random(),
              src: attachmentBlobUrls[att.id || att.url] || resolvedUrl || att.dataUrl,
              name: att.name || "Image",
              size: att.size,
              width: att.width,
              height: att.height,
              // Link back to message
              messageId: msg.id,
              createdAt: msg.createdAt,
              senderName: msg.senderName || "Unknown"
            });
          }
        });
      } else {
        // Check for GIFs (legacy text format or payload?)
        const gifFromText = getGifFromMessageText(raw);
        if (gifFromText) {
          items.push({
            id: `gif-${msg.id}`,
            src: gifFromText.previewUrl || gifFromText.url,
            name: gifFromText.title || "GIF",
            size: null,
            width: gifFromText.width || null,
            height: gifFromText.height || null,
            messageId: msg.id,
            createdAt: msg.createdAt,
            senderName: msg.senderName || "Unknown"
          });
        }
      }
    }
    // Sort newest first
    items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return items;
  }, [mediaMessagesMap, decryptedMessages, attachmentBlobUrls, selectedConversationId]);

  const replyTargetMsg = useMemo(
    () => (replyToId ? currentMessages.find((m) => m.id === replyToId) || null : null),
    [currentMessages, replyToId]
  );

  const editTargetMsg = useMemo(
    () => (editingMessageId ? currentMessages.find((m) => m.id === editingMessageId) || null : null),
    [currentMessages, editingMessageId]
  );

  useEffect(() => {
    if (!replyToId || !replyTargetMsg) return;
    const conv = conversations.find((c) => c.id === selectedConversationId) || null;
    const isE2EE = conv && E2EE.isConversationE2EE(conv);
    const senderName = getSenderNameForMsg(replyTargetMsg);
    const preview = {
      messageId: replyToId,
      senderId: replyTargetMsg.senderId || null,
      senderName,
      encrypted: Boolean(isE2EE),
    };
    const raw = getPlaintextForMsg(replyTargetMsg);
    const snippet = String(raw || "").replace(/\s+/g, " ").trim();
    if (snippet) {
      preview.snippet = snippet.slice(0, 120);
    } else {
      const existing = replyPreviewRef.current;
      if (
        existing &&
        existing.messageId === replyToId &&
        existing.snippet &&
        existing.snippet !== "Encrypted message..."
      ) {
        preview.snippet = existing.snippet;
      }
    }
    replyPreviewRef.current = preview;
  }, [replyToId, replyTargetMsg, conversations, selectedConversationId, decryptedMessages]);


  const getSenderNameForMsg = (msg) => {
    if (!msg) return "Unknown";
    const fromList = allUsers.find((u) => u.id === msg.senderId)?.username;
    return msg.senderName || fromList || "Unknown";
  };

  const summarizePayload = (payload) => {
    if (!payload) return "";
    const text = String(payload.text || "").trim();
    if (text) return text;
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    const gifCount = attachments.filter(isGifAttachment).length;
    if (gifCount === 1) return "GIF";
    if (gifCount > 1) return `GIFs (${gifCount})`;
    const count = attachments.length;
    if (count === 1) return "Image";
    if (count > 1) return `Images (${count})`;
    return "";
  };

  const getPlaintextForMsg = (msg) => {
    if (!msg) return "";
    const raw =
      msg.id && decryptedMessages[msg.id] != null
        ? String(decryptedMessages[msg.id])
        : String(msg.text || "");
    const payload = parseMessagePayload(raw);
    if (payload) {
      const summary = summarizePayload(payload);
      if (summary) return summary;
    }
    const gifFromText = getGifFromMessageText(raw);
    if (gifFromText) return "GIF";
    // Avoid dumping encrypted JSON into UI controls if we haven't decrypted yet.
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.e2ee) return "";
    } catch {
      // not JSON
    }
    return String(raw);
  };

  const formatBytes = useCallback((bytes) => {
    if (!Number.isFinite(bytes)) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let size = bytes;
    let idx = 0;
    while (size >= 1024 && idx < units.length - 1) {
      size /= 1024;
      idx += 1;
    }
    const decimals = size >= 10 || idx === 0 ? 0 : 1;
    return `${size.toFixed(decimals)} ${units[idx]}`;
  }, []);

  const makeImageId = () => {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
      reader.readAsDataURL(file);
    });


  const readImageMeta = (dataUrl) =>
    new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.onerror = () => resolve({ width: null, height: null });
      img.src = dataUrl;
    });

  const addImages = useCallback(
    (files) => {
      if (!files) return;
      const list = Array.from(files);
      if (list.length === 0) return;

      const valid = [];
      let oversizeCount = 0;

      for (const file of list) {
        if (file.size > MAX_FILE_BYTES) {
          oversizeCount += 1;
          continue;
        }
        valid.push(file);
      }

      if (oversizeCount > 0) {
        const label = oversizeCount > 1 ? "Files exceed" : "File exceeds";
        alert(`${label} ${formatBytes(MAX_FILE_BYTES)} limit.`);
      }
      if (valid.length === 0) return;

      const conv = conversations.find((c) => c.id === selectedConversationId);
      const isE2EE = conv && E2EE.isConversationE2EE(conv);

      const uploadFile = async (id, file, isEncrypted) => {
        try {
          let uploadBody;
          let fileKeyStr = null;
          let ivStr = null;

          if (isEncrypted) {
            const fileBytes = await file.arrayBuffer();
            const key = await E2EE.generateFileKey();
            const { encryptedBuffer, iv } = await E2EE.encryptFile(fileBytes, key);

            const blob = new Blob([encryptedBuffer], { type: "application/octet-stream" });
            uploadBody = new FormData();
            uploadBody.append("file", blob, (file.name || "file") + ".enc");

            fileKeyStr = await E2EE.exportKeyToString(key);
            ivStr = E2EE.bytesToBase64(iv);
          } else {
            uploadBody = new FormData();
            uploadBody.append("file", file);
          }

          const token = getToken();
          const uploadResult = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", `${API_BASE}/api/upload`);
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);

            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                setPendingImages((prev) =>
                  prev.map((item) =>
                    item.id === id ? { ...item, progress: pct } : item
                  )
                );
              }
            };

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                try {
                  resolve(JSON.parse(xhr.responseText));
                } catch {
                  reject(new Error("Upload response parse error"));
                }
              } else {
                let msg = "Upload failed";
                try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
                reject(new Error(msg));
              }
            };

            xhr.onerror = () => reject(new Error("Upload failed"));
            xhr.send(uploadBody);
          });

          return { url: uploadResult.url, fileKey: fileKeyStr, iv: ivStr };
        } catch (e) {
          throw e;
        }
      };

      for (const file of valid) {
        const id = makeImageId();
        const isImage = file.type && file.type.startsWith("image/");
        const draft = {
          id,
          name: file.name || "file",
          mime: file.type || "application/octet-stream",
          size: file.size,
          type: isImage ? "image" : "file",
          status: "loading",
          progress: 0,
          dataUrl: "",
          width: null,
          height: null,
          url: null,
          fileKey: null,
          iv: null,
          encrypted: isE2EE,
          file, // Keep reference for retry
        };
        setPendingImages((prev) => [...prev, draft]);

        (async () => {
          try {
            let dataUrl = "";
            let meta = { width: null, height: null };

            if (isImage) {
              dataUrl = await readFileAsDataUrl(file);
              meta = await readImageMeta(dataUrl);
              // Update preview immediately
              setPendingImages((prev) =>
                prev.map((item) =>
                  item.id === id ? { ...item, dataUrl, width: meta.width, height: meta.height } : item
                )
              );
            }

            const result = await uploadFile(id, file, isE2EE);

            setPendingImages((prev) =>
              prev.map((item) =>
                item.id === id
                  ? {
                    ...item,
                    dataUrl,
                    width: meta.width,
                    height: meta.height,
                    status: "ready",
                    progress: 100,
                    url: result.url,
                    fileKey: result.fileKey,
                    iv: result.iv
                  }
                  : item
              )
            );
          } catch (e) {
            console.error("Failed to process/upload file", e);
            setPendingImages((prev) =>
              prev.map((item) =>
                item.id === id
                  ? { ...item, status: "error", error: e.message || "Upload failed" }
                  : item
              )
            );
          }
        })();
      }
    },
    [formatBytes, conversations, selectedConversationId]
  );

  const retryPendingUpload = useCallback((id) => {
    setPendingImages((prev) => {
      const item = prev.find((p) => p.id === id);
      if (!item || !item.file || item.status !== "error") return prev;
      return prev.map((p) => p.id === id ? { ...p, status: "loading", progress: 0, error: null } : p);
    });

    // Small delay to let state update, then re-upload
    setTimeout(() => {
      setPendingImages((prev) => {
        const item = prev.find((p) => p.id === id);
        if (!item || !item.file || item.status !== "loading") return prev;

        const conv = conversations.find((c) => c.id === selectedConversationId);
        const isE2EE = conv && E2EE.isConversationE2EE(conv);

        (async () => {
          try {
            let uploadBody;
            let fileKeyStr = null;
            let ivStr = null;

            if (isE2EE) {
              const fileBytes = await item.file.arrayBuffer();
              const key = await E2EE.generateFileKey();
              const { encryptedBuffer, iv } = await E2EE.encryptFile(fileBytes, key);
              const blob = new Blob([encryptedBuffer], { type: "application/octet-stream" });
              uploadBody = new FormData();
              uploadBody.append("file", blob, (item.file.name || "file") + ".enc");
              fileKeyStr = await E2EE.exportKeyToString(key);
              ivStr = E2EE.bytesToBase64(iv);
            } else {
              uploadBody = new FormData();
              uploadBody.append("file", item.file);
            }

            const token = getToken();
            const uploadResult = await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open("POST", `${API_BASE}/api/upload`);
              xhr.setRequestHeader("Authorization", `Bearer ${token}`);
              xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) {
                  const pct = Math.round((e.loaded / e.total) * 100);
                  setPendingImages((p) =>
                    p.map((x) => x.id === id ? { ...x, progress: pct } : x)
                  );
                }
              };
              xhr.onload = () => {
                if (xhr.status >= 200 && xhr.status < 300) {
                  try { resolve(JSON.parse(xhr.responseText)); }
                  catch { reject(new Error("Upload response parse error")); }
                } else {
                  let msg = "Upload failed";
                  try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
                  reject(new Error(msg));
                }
              };
              xhr.onerror = () => reject(new Error("Upload failed"));
              xhr.send(uploadBody);
            });

            setPendingImages((p) =>
              p.map((x) =>
                x.id === id
                  ? { ...x, status: "ready", progress: 100, url: uploadResult.url, fileKey: fileKeyStr, iv: ivStr }
                  : x
              )
            );
          } catch (e) {
            console.error("Retry upload failed", e);
            setPendingImages((p) =>
              p.map((x) =>
                x.id === id ? { ...x, status: "error", error: e.message || "Upload failed" } : x
              )
            );
          }
        })();

        return prev;
      });
    }, 50);
  }, [conversations, selectedConversationId]);

  const deleteUploadedFile = useCallback((url) => {
    if (!url || typeof url !== "string") return;
    const match = url.match(/\/uploads\/([^/?#]+)/);
    if (!match) return;
    const filename = match[1];
    const token = getToken();
    if (!token) return;
    fetch(`${API_BASE}/api/upload/${encodeURIComponent(filename)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }, []);

  const removePendingImage = useCallback((id) => {
    if (!id) return;
    setPendingImages((prev) => {
      const item = prev.find((img) => img.id === id);
      if (item && item.url) deleteUploadedFile(item.url);
      return prev.filter((img) => img.id !== id);
    });
  }, [deleteUploadedFile]);

  const clearPendingImages = useCallback(() => {
    setPendingImages((prev) => {
      for (const item of prev) {
        if (item.url) deleteUploadedFile(item.url);
      }
      return [];
    });
  }, [deleteUploadedFile]);

  const normalizeGifForFavorite = useCallback((gif) => {
    if (!gif) return null;
    const record = {
      provider: gif.provider,
      id: gif.id,
      url: gif.url,
      previewUrl: gif.previewUrl,
      title: gif.title,
      width: gif.width,
      height: gif.height,
    };
    return normalizeGifRecord(record);
  }, []);

  const openGifPicker = useCallback(() => {
    setGifTab("search");
    setIsGifPickerOpen(true);
  }, []);

  const closeGifPicker = useCallback(() => {
    setIsGifPickerOpen(false);
    setGifError("");
    setGifSendingKey("");
  }, []);

  const openEmojiPicker = useCallback(() => {
    setIsEmojiPickerOpen(true);
  }, []);

  const closeEmojiPicker = useCallback(() => {
    setIsEmojiPickerOpen(false);
  }, []);

  const handleSelectEmoji = useCallback((emoji) => {
    if (!emoji) return;
    setInput((prev) => prev + emoji);
    setIsEmojiPickerOpen(false);
  }, []);

  const toggleGifFavorite = useCallback(
    async (gif) => {
      const normalized = normalizeGifForFavorite(gif);
      if (!normalized) return;
      const token = getToken();
      if (!token) return;

      const key = gifKey(normalized);
      const already = gifFavoriteKeys.has(key);

      try {
        if (already) {
          const res = await fetch(
            `${API_BASE}/api/gifs/favorites/${normalized.provider}/${normalized.id}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${token}` },
            }
          );
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || "Failed to remove favorite");
          }
          const data = await res.json().catch(() => null);
          if (data && Array.isArray(data.favorites)) {
            setGifFavorites(data.favorites);
          } else {
            setGifFavorites((prev) =>
              (Array.isArray(prev) ? prev : []).filter(
                (item) => gifKey(item) !== key
              )
            );
          }
        } else {
          const res = await fetch(`${API_BASE}/api/gifs/favorites`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ gif: normalized }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.message || "Failed to favorite GIF");
          }
          const data = await res.json().catch(() => null);
          if (data && Array.isArray(data.favorites)) {
            setGifFavorites(data.favorites);
          } else {
            setGifFavorites((prev) => {
              const list = Array.isArray(prev) ? prev : [];
              if (list.some((item) => gifKey(item) === key)) return list;
              return [normalized, ...list];
            });
          }
        }
      } catch (err) {
        alert(err.message || "GIF favorite action failed.");
      }
    },
    [gifFavoriteKeys, normalizeGifForFavorite]
  );

  useEffect(() => {
    if (!currentUser) return;
    const token = getToken();
    if (!token) return;
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/gifs/favorites`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data.favorites)
            ? data.favorites
            : [];
        setGifFavorites(list);
      } catch {
        // ignore
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentUser]);

  useEffect(() => {
    if (!isGifPickerOpen || gifTab !== "search") return;
    const token = getToken();
    if (!token) return;

    const term = gifQuery.trim();
    if (term && term.length < 2) {
      setGifResults([]);
      setGifError("");
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const handle = setTimeout(async () => {
      setGifLoading(true);
      setGifError("");

      try {
        const params = new URLSearchParams();
        params.set("limit", "24");
        if (term) params.set("q", term);

        const res = await fetch(`${API_BASE}/api/gifs/search?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.message || "GIF search failed");
        }

        const data = await res.json();
        if (cancelled) return;
        const list = Array.isArray(data)
          ? data
          : Array.isArray(data.results)
            ? data.results
            : [];
        setGifResults(list);
      } catch (err) {
        if (err.name === "AbortError") return;
        if (cancelled) return;
        setGifError(err.message || "GIF search failed");
      } finally {
        if (!cancelled) setGifLoading(false);
      }
    }, term ? 300 : 0);

    return () => {
      cancelled = true;
      clearTimeout(handle);
      controller.abort();
    };
  }, [gifQuery, gifTab, isGifPickerOpen]);

  const getPayloadByteSize = useCallback((text) => {
    if (text == null) return 0;
    try {
      return new TextEncoder().encode(String(text)).length;
    } catch {
      return String(text).length;
    }
  }, []);

  const ensureSocketPayloadFits = useCallback(
    (text) => {
      const bytes = getPayloadByteSize(text);
      if (bytes <= MAX_SOCKET_MESSAGE_BYTES) return true;
      alert(
        `Message payload is ${formatBytes(bytes)} and exceeds the realtime limit of ${formatBytes(
          MAX_SOCKET_MESSAGE_BYTES
        )}. Try removing some attachments.`
      );
      return false;
    },
    [formatBytes, getPayloadByteSize]
  );




  const replyPreviewForInput = useMemo(() => {
    if (!replyToId) return null;
    if (replyTargetMsg) {
      const raw = getPlaintextForMsg(replyTargetMsg);
      const snippet = String(raw || "").replace(/\s+/g, " ").trim();
      const cleaned = snippet === "Encrypted message..." ? "" : snippet;
      const truncated = cleaned ? cleaned.length > 140 : false;
      return {
        senderName: getSenderNameForMsg(replyTargetMsg),
        snippet: cleaned,
        truncated,
      };
    }
    const cached = replyPreviewRef.current;
    if (cached && cached.messageId === replyToId) {
      const senderName =
        cached.senderName ||
        (cached.senderId ? allUsers.find((u) => u.id === cached.senderId)?.username : "") ||
        "";
      const snippetRaw = String(cached.snippet || "").replace(/\s+/g, " ").trim();
      const snippet = snippetRaw === "Encrypted message..." ? "" : snippetRaw;
      const truncated = snippet ? snippetRaw.length >= 120 : false;
      return {
        senderName,
        snippet,
        truncated,
      };
    }
    return null;
  }, [replyToId, replyTargetMsg, decryptedMessages, allUsers]);

  useEffect(() => {
    if (!editingMessageId) return;
    clearPendingImages();
  }, [editingMessageId]);

  const handleReplyToMessage = (msg, previewText = null) => {
    if (!msg || !msg.id) return;
    setReplyToId(msg.id);
    const conv = conversations.find((c) => c.id === selectedConversationId) || null;
    const isE2EE = conv && E2EE.isConversationE2EE(conv);
    const senderName = getSenderNameForMsg(msg);
    const preview = {
      messageId: msg.id,
      senderId: msg.senderId || null,
      senderName,
      encrypted: Boolean(isE2EE),
    };
    let raw = previewText != null ? previewText : getPlaintextForMsg(msg);
    let snippet = String(raw || "").replace(/\s+/g, " ").trim();
    if (snippet === "Encrypted message...") {
      raw = getPlaintextForMsg(msg);
      snippet = String(raw || "").replace(/\s+/g, " ").trim();
      if (snippet === "Encrypted message...") snippet = "";
    }
    if (snippet) preview.snippet = snippet.slice(0, 120);
    replyPreviewRef.current = preview;
  };

  const flashMessage = (messageId, durationMs = 6000) => {
    if (!messageId) return;
    setFlashHighlightId(messageId);
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    flashTimeoutRef.current = setTimeout(() => {
      setFlashHighlightId((prev) => (prev === messageId ? null : prev));
    }, durationMs);
  };

  const scrollToMessage = (messageId) => {
    if (!messageId) return;
    const targetId = `msg-${messageId}`;
    let tries = 0;
    const maxTries = 120;
    const centerMessageInView = (el) => {
      const container = messagesContainerRef.current;
      if (!el) return;
      if (!container) {
        el.scrollIntoView({ behavior: "auto", block: "center" });
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const offsetTop = elRect.top - containerRect.top + container.scrollTop;
      const targetTop = Math.max(
        0,
        offsetTop - container.clientHeight / 2 + elRect.height / 2
      );
      container.scrollTo({ top: targetTop, behavior: "auto" });
    };

    const ensureVisible = () => {
      const el = document.getElementById(targetId);
      const container = messagesContainerRef.current;
      if (!el || !container) return;
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const isVisible = elRect.top >= containerRect.top && elRect.bottom <= containerRect.bottom;
      if (!isVisible) {
        centerMessageInView(el);
      }
      updateScrollState(selectedConversationRef.current, container);
    };

    const tryScroll = () => {
      const el = document.getElementById(targetId);
      const container = messagesContainerRef.current;
      if (el) {
        centerMessageInView(el);
        flashMessage(messageId, 6000);
        if (container) {
          requestAnimationFrame(() => updateScrollState(selectedConversationRef.current, container));
        }
        setTimeout(ensureVisible, 120);
        setTimeout(ensureVisible, 320);
        return;
      }
      tries += 1;
      if (tries < maxTries) requestAnimationFrame(tryScroll);
    };

    requestAnimationFrame(tryScroll);
  };

  const cancelReply = () => {
    setReplyToId(null);
    replyPreviewRef.current = null;
  };


  const buildReplyPreview = (isE2EE) => {
    if (!replyToId) return null;

    let replyToPreview = null;
    const target =
      replyTargetMsg ||
      (messagesByConversationRef.current?.[selectedConversationId] || []).find(
        (m) => m.id === replyToId
      );
    if (target) {
      const senderName = getSenderNameForMsg(target);
      replyToPreview = {
        senderId: target.senderId || null,
        senderName,
        encrypted: Boolean(isE2EE),
      };
      const raw = getPlaintextForMsg(target);
      const snippet = String(raw || "").replace(/\s+/g, " ").trim();
      if (snippet) replyToPreview.snippet = snippet.slice(0, 120);
    }
    const cached = replyPreviewRef.current;
    if (cached && cached.messageId === replyToId) {
      const preview = { ...cached };
      delete preview.messageId;
      if (preview.snippet === "Encrypted message...") {
        delete preview.snippet;
      }
      if (!replyToPreview) {
        replyToPreview = preview;
      } else {
        if (!replyToPreview.senderId && preview.senderId) replyToPreview.senderId = preview.senderId;
        if (!replyToPreview.senderName && preview.senderName) replyToPreview.senderName = preview.senderName;
        if (!replyToPreview.snippet && preview.snippet) replyToPreview.snippet = preview.snippet;
        if (replyToPreview.encrypted == null && typeof preview.encrypted === "boolean") {
          replyToPreview.encrypted = preview.encrypted;
        }
      }
    }

    return replyToPreview;
  };

  const dispatchMessage = async ({
    text,
    attachments,
    clearInput = true,
    clearReply = true,
    clearPendingImages = true,
  }) => {
    const trimmed = String(text || "").trim();
    const safeAttachments = Array.isArray(attachments) ? attachments : [];
    const hasAttachments = safeAttachments.length > 0;

    if ((!trimmed && !hasAttachments) || !currentUser) return;
    if (trimmed.length > MAX_MESSAGE_CHARS) {
      alert(`Message is too long (${trimmed.length}/${MAX_MESSAGE_CHARS}). Please shorten it.`);
      return;
    }

    const conv = conversations.find((c) => c.id === selectedConversationId) || null;
    const isE2EE = conv && E2EE.isConversationE2EE(conv);
    const replyToPreview = buildReplyPreview(isE2EE);

    let textToSend = trimmed;
    if (hasAttachments) {
      // Strip inline base64 dataUrls and File objects from attachments (files are already uploaded by URL)
      const strippedAttachments = safeAttachments.map((att) => {
        const { dataUrl, file, error, ...rest } = att;
        return rest;
      });
      const payload = buildMessagePayload({ text: trimmed, attachments: strippedAttachments });
      if (!payload) {
        alert("Could not prepare attachment payload. Please try again.");
        return;
      }
      textToSend = JSON.stringify(payload);
    }

    if (isE2EE) {
      try {
        const encryptedPayload = await encryptForConversation(textToSend, conv);

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

    if (!ensureSocketPayloadFits(textToSend)) {
      return;
    }

    if (!socket.connected) {
      alert("Not connected to the realtime server yet. Refresh and try again.");
      return;
    }

    // Extract plain upload filenames for server-side file tracking (not sensitive - filenames are random UUIDs)
    const fileRefs = [];
    if (hasAttachments) {
      const uploadRegex = /\/uploads\/([a-zA-Z0-9._-]+)/;
      for (const att of safeAttachments) {
        if (att.url && typeof att.url === "string") {
          const m = att.url.match(uploadRegex);
          if (m) fileRefs.push(m[1]);
        }
      }
    }

    socket.emit("chat:send", {
      conversationId: selectedConversationId || "global",
      text: textToSend,
      replyToId: replyToId || null,
      replyToPreview,
      fileRefs: fileRefs.length > 0 ? fileRefs : undefined,
    });

    if (clearInput) setInput("");
    if (clearReply) setReplyToId(null);
    if (clearPendingImages) setPendingImages([]);
  };

  const handleSelectGif = async (gif) => {
    const normalized = normalizeGifForFavorite(gif);
    if (!normalized) return;
    const key = gifKey(normalized);
    setGifSendingKey(key);

    try {
      await dispatchMessage({
        text: normalized.url,
        attachments: [],
        clearInput: false,
        clearReply: true,
        clearPendingImages: false,
      });
      closeGifPicker();
    } catch (err) {
      console.error("GIF send failed", err);
      alert(err.message || "Failed to send GIF.");
    } finally {
      setGifSendingKey("");
    }
  };


  const cancelEdit = () => {
    setEditingMessageId(null);
    setInput("");
  };


  const getMessageTimestamp = (msg) => {
    if (!msg) return 0;
    const raw = msg.createdAt || msg.timestamp || msg.sentAt || msg.time || msg.date;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : 0;
  };

  const mergeWindowedMessages = (existing, incoming, direction) => {
    const base = Array.isArray(existing) ? existing : [];
    const add = Array.isArray(incoming) ? incoming : [];

    let combined;
    if (direction === "older") combined = [...add, ...base];
    else if (direction === "newer") combined = [...base, ...add];
    else combined = add;

    const unique = Array.from(new Map(combined.map((m) => [m.id, m])).values());
    unique.sort((a, b) => getMessageTimestamp(a) - getMessageTimestamp(b));

    let trimmedFromTop = 0;
    let trimmedFromBottom = 0;
    if (direction !== "around" && unique.length > WINDOW_SIZE) {
      const overflow = unique.length - WINDOW_SIZE;
      if (direction === "older") {
        trimmedFromBottom = overflow;
        unique.splice(unique.length - overflow, overflow);
      } else {
        trimmedFromTop = overflow;
        unique.splice(0, overflow);
      }
    }

    return { merged: unique, trimmedFromTop, trimmedFromBottom };
  };



  const isGroup = currentConversation && currentConversation.type === "group";

  const isGroupMember =
    isGroup &&
    currentUser &&
    Array.isArray(currentConversation?.memberIds) &&
    currentConversation.memberIds.includes(currentUser.id);

  const isGroupOwner =
    isGroup && currentUser && currentConversation.ownerId === currentUser.id;

  const canManageGroupMembers =
    isGroup &&
    currentUser &&
    (currentConversation.ownerId === currentUser.id ||
      (Array.isArray(currentConversation.adminIds) &&
        currentConversation.adminIds.includes(currentUser.id)));

  const conversationMembers = useMemo(() => {
    if (!isGroup) return [];
    const ids = currentConversation.memberIds || [];
    return ids.map((id) => allUsers.find((u) => u.id === id)).filter(Boolean);
  }, [isGroup, currentConversation, allUsers]);

  const ownerUser = useMemo(() => {
    if (!isGroup) return null;
    return allUsers.find((u) => u.id === currentConversation.ownerId) || null;
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
    return addableUsers.filter((u) => (u.username || "").toLowerCase().includes(term));
  }, [addableUsers, manageSearchTerm]);

  const filteredUsers = useMemo(() => {
    const term = userSearchTerm.trim().toLowerCase();

    // Don't show anything until a real username search is entered
    if (term.length < 2) return [];

    // Username-only search, prefix match to prevent huge result sets
    const matches = allUsers
      .filter((u) => u.id !== currentUser?.id)
      .filter((u) => (u.username || "").toLowerCase().startsWith(term));

    return matches.slice(0, 25);
  }, [allUsers, currentUser, userSearchTerm]);


  const newGroupSelectedUsers = useMemo(
    () => groupMemberIds.map((id) => allUsers.find((u) => u.id === id)).filter(Boolean),
    [groupMemberIds, allUsers]
  );

  // ---------- INITIAL AUTH + SOCKET + DATA ----------
  useEffect(() => {
    const storedUser = sessionStorage.getItem("user") || localStorage.getItem("user");
    const token = getToken();

    if (!storedUser || !token) {
      navigate("/");
      return;
    }

    const user = JSON.parse(storedUser);
    setCurrentUser(user);
    const userId = user?.id;

    socket.auth = { token };
    socket.connect();

    // Silently refresh token to extend expiry each time the app loads
    fetch(`${API_BASE}/api/refresh-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.token) {
          setAuth(data.token, data.user);
          socket.auth = { token: data.token };
        }
      })
      .catch(() => {});

    socket.on("chat:history", (payload) => {
      if (!payload) return;

      const {
        conversationId,
        messages,
        direction,
        hasMoreOlder: payloadHasMoreOlder,
        hasMoreNewer: payloadHasMoreNewer,
      } = payload;
      if (!conversationId) return;

      const mode = direction || "latest";
      const pendingLatest = pendingLatestRef.current;
      const pendingJump = pendingJumpToMessageRef.current;
      if (pendingLatest?.convId === conversationId && mode !== "latest") return;
      if (pendingJump?.convId === conversationId && pendingJump.mode === "around" && mode !== "around") return;

      const newMessages = Array.isArray(messages) ? messages : [];
      const previousMessages = messagesByConversationRef.current[conversationId] || [];
      const previousCount = previousMessages.length;
      const isFirstHistory = !initialHistoryLoadedRef.current[conversationId];
      if (isFirstHistory) {
        initialHistoryLoadedRef.current[conversationId] = true;
      }

      const isLatestReset = pendingLatest?.convId === conversationId && mode === "latest";
      const mergeMode =
        mode === "latest" && previousMessages.length > 0 && !isLatestReset ? "newer" : mode;
      const { merged, trimmedFromTop, trimmedFromBottom } = mergeWindowedMessages(
        previousMessages,
        newMessages,
        mergeMode
      );

      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: merged,
      }));

      const nextHasOlder = Boolean(payloadHasMoreOlder) || trimmedFromTop > 0;
      const nextHasNewer = Boolean(payloadHasMoreNewer) || trimmedFromBottom > 0;

      if (mode === "older") {
        setPagingState(conversationId, {
          hasOlder: nextHasOlder,
          hasNewer: nextHasNewer,
          isLoadingOlder: false,
        });
      } else if (mode === "newer") {
        setPagingState(conversationId, {
          hasOlder: nextHasOlder,
          hasNewer: nextHasNewer,
          isLoadingNewer: false,
        });
      } else {
        setPagingState(conversationId, {
          hasOlder: nextHasOlder,
          hasNewer: nextHasNewer,
          isLoadingOlder: false,
          isLoadingNewer: false,
        });
      }

      if (
        pendingJumpRef.current === conversationId &&
        conversationId === selectedConversationRef.current
      ) {
        if (nextHasNewer) {
          loadNewerMessages(conversationId, { forceBottom: true });
        } else {
          pendingJumpRef.current = null;
          requestAnimationFrame(() => scrollToBottom("auto"));
        }
      }

      const pendingJumpAfterMerge = pendingJumpToMessageRef.current;
      if (pendingJumpAfterMerge?.convId === conversationId) {
        const targetId = pendingJumpAfterMerge.messageId;
        const hasTarget = merged.some((m) => m.id === targetId);
        if (hasTarget) {
          pendingJumpToMessageRef.current = null;
          requestAnimationFrame(() => scrollToMessage(targetId));
        } else if (
          (pendingJumpAfterMerge.mode || "older") === "older" &&
          nextHasOlder &&
          newMessages.length > 0
        ) {
          loadOlderMessages(conversationId);
        } else if (pendingJumpAfterMerge.mode === "around" && mode === "around") {
          pendingJumpToMessageRef.current = null;
        }
      }

      if (isLatestReset) {
        pendingLatestRef.current = null;
        if (conversationId === selectedConversationRef.current) {
          pendingRestoreRef.current = { convId: conversationId, mode: "bottom" };
          requestAnimationFrame(() => scrollToBottom("auto"));
          setTimeout(() => scrollToBottom("auto"), 0);
        }
      }

      if (
        conversationId === selectedConversationRef.current &&
        isFirstHistory &&
        previousCount === 0 &&
        merged.length > 0 &&
        mode !== "around"
      ) {
        pendingRestoreRef.current = { convId: conversationId, mode: "bottom" };
        lastAtBottomRef.current = true;
        setIsUserAtBottom(true);
      }
    });

    socket.on("error", (err) => {
      console.error("Socket error:", err);
      alert(err.message || "An error occurred.");
    });

    socket.on("chat:message", (msg) => {
      if (!msg) return;

      const convId = msg.conversationId || "global";
      const atBottom = scrollStateRef.current[convId]?.atBottom;
      const stickToBottom = atBottom !== false;

      setMessagesByConversation((prev) => {
        const existing = prev[convId] || [];
        if (existing.some((m) => m.id === msg.id)) return prev;
        let next = [...existing, msg];
        if (next.length > WINDOW_SIZE) {
          const overflow = next.length - WINDOW_SIZE;
          const paging = getPagingState(convId);
          if (stickToBottom) {
            next = next.slice(overflow);
            setPagingState(convId, { hasOlder: true, hasNewer: paging.hasNewer });
          } else {
            next = next.slice(0, next.length - overflow);
            setPagingState(convId, { hasOlder: paging.hasOlder, hasNewer: true });
          }
        }
        return { ...prev, [convId]: next };
      });

      setLastActive((prev) => ({ ...prev, [convId]: Date.now() }));

      if (convId === selectedConversationRef.current) {
        if (stickToBottom) requestAnimationFrame(() => scrollToBottom("auto"));
        else setHasNewWhileScrolledUp(true);
      }


      setUnreadCounts((prev) => {
        if (convId === selectedConversationRef.current) return prev;
        return { ...prev, [convId]: (prev[convId] || 0) + 1 };
      });

      // Play notification sound for DMs/groups (not global, not from self, not muted)
      if (
        convId !== "global" &&
        msg.senderId !== currentUserRef.current?.id &&
        convId !== selectedConversationRef.current &&
        !mutedConversationsRef.current.has(convId)
      ) {
        playNotificationSound();
      }
    });

    socket.on("chat:message-deleted", ({ conversationId, messageId }) => {
      setMessagesByConversation((prev) => ({
        ...prev,
        [conversationId]: (prev[conversationId] || []).filter((m) => m.id !== messageId),
      }));
      setDecryptedMessages((prev) => {
        const copy = { ...prev };
        delete copy[messageId];
        return copy;
      });
      // Clean up decryption queue for deleted messages
      if (decryptQueueRef.current[messageId]) {
        delete decryptQueueRef.current[messageId];
      }
    });


    socket.on("chat:message-edited", ({ conversationId, message } = {}) => {
      if (!conversationId || !message || !message.id) return;

      setMessagesByConversation((prev) => {
        const arr = prev[conversationId] || [];
        const exists = arr.some((m) => m.id === message.id);
        const next = exists ? arr.map((m) => (m.id === message.id ? message : m)) : [...arr, message];
        return { ...prev, [conversationId]: next };
      });

      // CRITICAL FIX: Clear the decryption queue flag for this message so it can be re-decrypted.
      // Without this, the decryption effect would skip the edited message because it thinks
      // it was already processed.
      if (decryptQueueRef.current[message.id]) {
        delete decryptQueueRef.current[message.id];
      }

      setDecryptedMessages((prev) => {
        const copy = { ...prev };
        const raw = message.text || "";
        try {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.e2ee) {
            // Remove old decrypted text so the effect will re-decrypt it
            delete copy[message.id];
          } else {
            copy[message.id] = raw;
          }
        } catch {
          copy[message.id] = raw;
        }
        return copy;
      });

      setLastActive((prev) => ({ ...prev, [conversationId]: Date.now() }));
    });

    socket.on("chat:reaction-updated", ({ conversationId, messageId, reactions } = {}) => {
      if (!conversationId || !messageId) return;
      setMessagesByConversation((prev) => {
        const arr = prev[conversationId] || [];
        const next = arr.map((m) =>
          String(m.id) === String(messageId) ? { ...m, reactions } : m
        );
        return { ...prev, [conversationId]: next };
      });
    });

    socket.on("conversation:created", (conv) => {
      if (!conv || !conv.id) return;

      setConversations((prev) => {
        if (prev.some((c) => c.id === conv.id)) return prev;
        return [...prev, conv];
      });

      setLastActive((prev) => ({ ...prev, [conv.id]: Date.now() }));

      // If we just got added to a group/DM, join the room immediately for live updates
      if (!initialHistoryLoadedRef.current[conv.id]) {
        setPagingState(conv.id, { isLoadingOlder: true });
      }
      socket.emit("chat:join", { conversationId: conv.id, limit: PAGE_SIZE });
    });

    socket.on("conversation:update", (conv) => {
      if (!conv || !conv.id) return;

      // IMPORTANT: do NOT delete old group keys on rotation.
      // Old messages were encrypted with old keys; we keep keys-by-version so history stays readable.
      setConversations((prev) => prev.map((c) => (c.id === conv.id ? { ...c, ...conv } : c)));

      setLastActive((prev) => ({ ...prev, [conv.id]: Date.now() }));

      if (selectedConversationRef.current === conv.id) {
        setUnreadCounts((prev) => {
          const copy = { ...prev };
          delete copy[conv.id];
          return copy;
        });
      }
    });

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

      setSelectedConversationId((prevId) => (prevId === id ? "global" : prevId));
    });

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

      setSelectedConversationId((prevId) => (prevId === id ? "global" : prevId));
    });

    // VERIFIED USER APPEARS (real-time)
    socket.on("user:verified", (u) => {
      if (!u || !u.id) return;
      setAllUsers((prev) => {
        if (prev.some((x) => x.id === u.id)) return prev;
        return [...prev, { id: u.id, username: u.username || "" }];
      });
    });

    // GROUP: server asks this user to join the room immediately (and get history)
    socket.on("group:join_room", ({ conversationId } = {}) => {
      if (!conversationId) return;
      if (!initialHistoryLoadedRef.current[conversationId]) {
        setPagingState(conversationId, { isLoadingOlder: true });
      }
      socket.emit("chat:join", { conversationId, limit: PAGE_SIZE });
    });

    // GROUP: keys delivered immediately on add (optional helper; client can also read from conversation payload)
    socket.on("group:keys_delivered", ({ conversationId, encryptedKey, keyVersion } = {}) => {
      if (!conversationId || !encryptedKey || !userId) return;

      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== conversationId) return c;
          const enc =
            c.encryptedKeys && typeof c.encryptedKeys === "object" ? c.encryptedKeys : {};
          const kv = typeof keyVersion === "number" ? keyVersion : c.keyVersion;
          const hist =
            c.encryptedKeysByVersion && typeof c.encryptedKeysByVersion === "object"
              ? c.encryptedKeysByVersion
              : {};
          const epoch =
            kv >= 1 && hist[kv] && typeof hist[kv] === "object" ? hist[kv] : {};

          return {
            ...c,
            encryptedKeys: { ...enc, [userId]: encryptedKey },
            keyVersion: kv,
            encryptedKeysByVersion: kv >= 1 ? { ...hist, [kv]: { ...epoch, [userId]: encryptedKey } } : hist,
          };
        })
      );
    });

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

      } catch (err) {
        console.error("init error", err);
      }

      if (!initialHistoryLoadedRef.current.global) {
        setPagingState("global", { isLoadingOlder: true });
      }
      socket.emit("chat:join", { conversationId: "global", limit: PAGE_SIZE });
    };

    fetchInitial();

    return () => {
      socket.off("chat:history");
      socket.off("chat:message");
      socket.off("chat:message-deleted");
      socket.off("chat:message-edited");
      socket.off("chat:reaction-updated");
      socket.off("conversation:created");
      socket.off("conversation:update");
      socket.off("conversation:removed");
      socket.off("conversation:deleted");
      socket.off("user:verified");
      socket.off("group:join_room");
      socket.off("group:keys_delivered");
      socket.disconnect();
    };
  }, [navigate]);

  // ---------- RECONNECT ON VISIBILITY CHANGE (mobile background/foreground) ----------
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible" && !socket.connected) {
        socket.connect();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

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
        const result = await E2EE.loadOrCreateKeyPairForUser(currentUser.id);
        if (cancelled) return;

        const { keyPair, kid, ring } = result || {};
        if (!keyPair || !kid) throw new Error("Missing E2EE keypair");

        setMyKeyPair(keyPair);
        setMyKeyId(kid);
        keyRingRef.current = ring || null;
        keyPairCacheRef.current = { [kid]: keyPair };
        dmKeyCacheRef.current = {};

        const publicJwk =
          ring?.keys?.[kid]?.publicJwk ||
          (await window.crypto.subtle.exportKey("jwk", keyPair.publicKey));
        myPublicJwkRef.current = publicJwk;

        const token = getToken();
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


  // ---------- KEY HISTORY BACKFILL ----------
  // If you ever rotate a group key (member removal), older epochs may only exist in localStorage.
  // This effect backfills ciphertext-only key history to the server so old messages remain
  // decryptable even after switching domains / clearing site data.
  useEffect(() => {
    if (!currentUser || !myKeyPair) return;

    const token = getToken();
    if (!token) return;

    let cancelled = false;

    (async () => {
      try {
        const list = Array.isArray(conversations) ? conversations : [];
        for (const conv of list) {
          if (cancelled) return;
          if (!conv || conv.type !== "group") continue;

          const isManager =
            conv.ownerId === currentUser.id ||
            (Array.isArray(conv.adminIds) && conv.adminIds.includes(currentUser.id));

          if (!isManager) continue;

          const local = E2EE.loadGroupKeyStringMap(currentUser.id, conv.id);
          const serverHist =
            conv.encryptedKeysByVersion && typeof conv.encryptedKeysByVersion === "object"
              ? conv.encryptedKeysByVersion
              : {};

          const attempted =
            keyHistoryBackfillRef.current[conv.id] ||
            (keyHistoryBackfillRef.current[conv.id] = {});

          for (const [vStr, keyString] of Object.entries(local || {})) {
            if (cancelled) return;
            if (!keyString || typeof keyString !== "string") continue;

            const v = Number(vStr);
            if (!Number.isFinite(v) || v < 1) continue;

            if (serverHist && serverHist[vStr]) continue;
            if (attempted[vStr]) continue;
            attempted[vStr] = true;

            try {
              const encryptedKeys = await buildEncryptedGroupKeysForMembers(
                Array.isArray(conv.memberIds) ? conv.memberIds : [],
                keyString
              );

              await fetch(`${API_BASE}/api/conversations/${conv.id}/key-history/upsert`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ version: v, encryptedKeys }),
              });
            } catch (e) {
              console.error("Key history backfill failed", e);
            }
          }
        }
      } catch (e) {
        console.error("Key history backfill init failed", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversations, currentUser, myKeyPair]);


  // ---------- SCROLL HANDLING ----------
  const BOTTOM_THRESHOLD = 64;
  const TOP_THRESHOLD = 50;
  const PRELOAD_THRESHOLD = 400;

  const getBottomScrollTop = (container) =>
    Math.max(0, container.scrollHeight - container.clientHeight);

  const getPagingState = (convId) =>
    pagingRef.current[convId] || {
      hasOlder: true,
      hasNewer: false,
      isLoadingOlder: false,
      isLoadingNewer: false,
    };

  const setPagingState = (convId, patch) => {
    if (!convId) return;
    const next = { ...getPagingState(convId), ...patch };
    pagingRef.current[convId] = next;
    if (selectedConversationRef.current === convId) {
      setHasMoreOlder(next.hasOlder);
      setHasMoreNewer(next.hasNewer);
      setIsLoadingOlder(next.isLoadingOlder);
      setIsLoadingNewer(next.isLoadingNewer);
    }
  };

  const updateScrollState = (convId, container) => {
    if (!convId || !container) return;
    const messages = messagesByConversationRef.current[convId] || [];
    if (!initialHistoryLoadedRef.current[convId] && messages.length === 0) return;
    const bottom = getBottomScrollTop(container);
    const atBottom = Math.abs(container.scrollTop - bottom) <= BOTTOM_THRESHOLD;
    scrollStateRef.current[convId] = {
      scrollTop: container.scrollTop,
      atBottom,
    };
    if (lastAtBottomRef.current !== atBottom) {
      lastAtBottomRef.current = atBottom;
      setIsUserAtBottom(atBottom);
    }
    if (atBottom) setHasNewWhileScrolledUp(false);
    return atBottom;
  };

  const captureAnchor = useCallback((convId) => {
    const container = messagesContainerRef.current;
    if (!convId || !container) return null;
    const containerTop = container.getBoundingClientRect().top;
    const messageEls = container.querySelectorAll("[data-msg-id]");
    let anchorEl = null;
    for (const el of messageEls) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom >= containerTop + 4) {
        anchorEl = el;
        break;
      }
    }
    if (!anchorEl) return null;
    const messageId = anchorEl.getAttribute("data-msg-id");
    if (!messageId) return null;
    return {
      convId,
      messageId,
      offset: anchorEl.getBoundingClientRect().top - containerTop,
    };
  }, []);

  const scrollToBottom = (behavior = "auto") => {
    const el = messagesContainerRef.current;
    if (!el) return;
    const bottom = getBottomScrollTop(el);
    restoringRef.current = true;
    el.scrollTo({ top: bottom, behavior });
    updateScrollState(selectedConversationRef.current, el);
    requestAnimationFrame(() => {
      restoringRef.current = false;
    });
  };

  useLayoutEffect(() => {
    if (!selectedConversationId) return;
    if (pendingRestoreRef.current && pendingRestoreRef.current.convId === selectedConversationId) return;
    pendingJumpRef.current = null;
    pendingAnchorRef.current = null;
    pendingJumpToMessageRef.current = null;
    pendingLatestRef.current = null;
    loadOlderChainRef.current = null;
    const hasHistory = Boolean(initialHistoryLoadedRef.current[selectedConversationId]);
    if (!hasHistory) {
      scrollStateRef.current[selectedConversationId] = { scrollTop: 0, atBottom: true };
      pendingRestoreRef.current = { convId: selectedConversationId, mode: "bottom" };
      lastAtBottomRef.current = true;
      setIsUserAtBottom(true);
      setHasNewWhileScrolledUp(false);
      const paging = getPagingState(selectedConversationId);
      setHasMoreOlder(paging.hasOlder);
      setHasMoreNewer(paging.hasNewer);
      setIsLoadingOlder(paging.isLoadingOlder);
      setIsLoadingNewer(paging.isLoadingNewer);
      return;
    }
    const saved = scrollStateRef.current[selectedConversationId];
    if (saved && !saved.atBottom) {
      pendingRestoreRef.current = {
        convId: selectedConversationId,
        mode: "saved",
        top: saved.scrollTop,
      };
      lastAtBottomRef.current = false;
      setIsUserAtBottom(false);
    } else {
      pendingRestoreRef.current = { convId: selectedConversationId, mode: "bottom" };
      lastAtBottomRef.current = true;
      setIsUserAtBottom(true);
    }
    setHasNewWhileScrolledUp(false);
    const paging = getPagingState(selectedConversationId);
    setHasMoreOlder(paging.hasOlder);
    setHasMoreNewer(paging.hasNewer);
    setIsLoadingOlder(paging.isLoadingOlder);
    setIsLoadingNewer(paging.isLoadingNewer);
  }, [selectedConversationId]);

  // ---------- PAGINATION ----------
  const loadOlderMessages = useCallback((convId) => {
    if (!convId) return;
    const paging = getPagingState(convId);
    if (paging.isLoadingOlder || !paging.hasOlder) return;
    const currentMsgs = messagesByConversationRef.current[convId] || [];
    if (currentMsgs.length === 0) return;

    const anchor = captureAnchor(convId);
    if (anchor) pendingAnchorRef.current = { ...anchor, mode: "older" };

    loadOlderChainRef.current = convId;
    setPagingState(convId, { isLoadingOlder: true });
    socket.emit("chat:join", {
      conversationId: convId,
      limit: PAGE_SIZE,
      beforeId: currentMsgs[0].id,
    });
  }, [captureAnchor]);

  const loadNewerMessages = useCallback((convId, options = {}) => {
    if (!convId) return;
    const { forceBottom = false } = options;
    const paging = getPagingState(convId);
    if (paging.isLoadingNewer || !paging.hasNewer) return;
    const currentMsgs = messagesByConversationRef.current[convId] || [];
    if (currentMsgs.length === 0) return;

    const atBottom = scrollStateRef.current[convId]?.atBottom;
    const anchor = forceBottom ? null : captureAnchor(convId);
    const stickToBottom = forceBottom || Boolean(atBottom);
    if (anchor) {
      pendingAnchorRef.current = {
        ...anchor,
        mode: "newer",
        stickToBottom,
      };
    } else if (stickToBottom) {
      pendingAnchorRef.current = { convId, mode: "newer", stickToBottom: true };
    }

    setPagingState(convId, { isLoadingNewer: true });
    const newest = currentMsgs[currentMsgs.length - 1];
    socket.emit("chat:join", {
      conversationId: convId,
      limit: PAGE_SIZE,
      afterId: newest.id,
    });
  }, [captureAnchor]);

  const jumpToLatest = useCallback(() => {
    const convId = selectedConversationId;
    if (!convId) return;

    setHasNewWhileScrolledUp(false);
    lastAtBottomRef.current = true;
    setIsUserAtBottom(true);

    const paging = getPagingState(convId);
    const forceLatest = convId === "global";
    if (!paging.hasNewer && !forceLatest) {
      scrollToBottom("auto");
      return;
    }

    pendingJumpRef.current = null;
    pendingLatestRef.current = { convId, force: forceLatest };
    pendingJumpToMessageRef.current = null;
    pendingAnchorRef.current = null;
    pendingRestoreRef.current = null;
    scrollStateRef.current[convId] = { scrollTop: 0, atBottom: true };
    setPagingState(convId, { isLoadingOlder: true, isLoadingNewer: true });
    socket.emit("chat:join", {
      conversationId: convId,
      limit: WINDOW_SIZE,
    });
  }, [selectedConversationId]);

  const jumpToMessage = useCallback(
    (messageId, convId = selectedConversationId) => {
      if (!messageId || !convId) return;

      const current = messagesByConversationRef.current?.[convId] || [];
      if (current.some((m) => m.id === messageId)) {
        scrollToMessage(messageId);
        return;
      }

      pendingJumpToMessageRef.current = { convId, messageId, mode: "around" };
      pendingAnchorRef.current = null;
      pendingRestoreRef.current = null;
      if (convId === selectedConversationRef.current) {
        const prevState = scrollStateRef.current[convId] || {};
        scrollStateRef.current[convId] = { ...prevState, atBottom: false };
        lastAtBottomRef.current = false;
        setIsUserAtBottom(false);
      }

      setPagingState(convId, { isLoadingOlder: true, isLoadingNewer: true });
      socket.emit("chat:join", {
        conversationId: convId,
        limit: WINDOW_SIZE,
        aroundId: messageId,
      });
    },
    [selectedConversationId]
  );



  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      if (restoringRef.current) return;
      const bottom = getBottomScrollTop(container);
      const rawAtBottom = Math.abs(container.scrollTop - bottom) <= BOTTOM_THRESHOLD;
      const atTop = container.scrollTop <= TOP_THRESHOLD;

      const prevTop = lastScrollTopRef.current[selectedConversationId];
      const nextTop = container.scrollTop;
      const lastTop = typeof prevTop === "number" ? prevTop : nextTop;
      lastScrollTopRef.current[selectedConversationId] = nextTop;

      const wasAtBottom = scrollStateRef.current[selectedConversationId]?.atBottom;
      let effectiveAtBottom = rawAtBottom;

      // Sticky Bottom Logic:
      // If we were at the bottom, and we haven't scrolled up significantly (allowing for tiny logic jitter),
      // we assume the loss of rawAtBottom is due to content expansion (resizing), 
      // and we want to remain "logically" at the bottom so the ResizeObserver can snap us back.
      if (wasAtBottom && !rawAtBottom && nextTop >= (lastTop - 5)) {
        effectiveAtBottom = true;
      }

      // Update state manually locally to respect our sticky logic
      scrollStateRef.current[selectedConversationId] = {
        scrollTop: nextTop,
        atBottom: effectiveAtBottom,
      };

      if (lastAtBottomRef.current !== effectiveAtBottom) {
        lastAtBottomRef.current = effectiveAtBottom;
        setIsUserAtBottom(effectiveAtBottom);
      }
      if (effectiveAtBottom) setHasNewWhileScrolledUp(false);

      if (!effectiveAtBottom && pendingJumpRef.current === selectedConversationId) {
        pendingJumpRef.current = null;
      }
      if (nextTop <= PRELOAD_THRESHOLD && !effectiveAtBottom && hasMoreOlder && !isLoadingOlder) {
        loadOlderMessages(selectedConversationId);
      }
      if (effectiveAtBottom && hasMoreNewer && !isLoadingNewer) {
        loadNewerMessages(selectedConversationId);
      }
      // Note: we skipped updateScrollState here because we updated ref manually above
      // to handle the sticky logic.
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    // handleScroll(); // Don't trigger immediately on mount to avoid double fetch
    return () => {
      container.removeEventListener("scroll", handleScroll);
    };
  }, [selectedConversationId, hasMoreOlder, isLoadingOlder, hasMoreNewer, isLoadingNewer, loadOlderMessages, loadNewerMessages]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    let lastTouchY = null;

    const maybeLoadOlder = () => {
      const convId = selectedConversationId;
      if (!convId) return;
      if (container.scrollTop > PRELOAD_THRESHOLD) return;
      loadOlderMessages(convId);
    };

    const handleWheel = (event) => {
      if (event.deltaY < 0) {
        maybeLoadOlder();
      }
    };

    const handleTouchStart = (event) => {
      if (event.touches && event.touches.length > 0) {
        lastTouchY = event.touches[0].clientY;
      }
    };

    const handleTouchMove = (event) => {
      if (lastTouchY == null) return;
      if (event.touches && event.touches.length > 0) {
        const nextY = event.touches[0].clientY;
        if (nextY > lastTouchY) {
          maybeLoadOlder();
        }
        lastTouchY = nextY;
      }
    };

    container.addEventListener("wheel", handleWheel, { passive: true });
    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: true });

    return () => {
      container.removeEventListener("wheel", handleWheel);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
    };
  }, [selectedConversationId, loadOlderMessages]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    const sentinel = topSentinelRef.current;
    if (!container || !sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const convId = selectedConversationRef.current;
          if (!convId) continue;
          const paging = getPagingState(convId);
          if (!paging.hasOlder || paging.isLoadingOlder) continue;
          loadOlderMessages(convId);
        }
      },
      {
        root: container,
        rootMargin: "400px 0px 0px 0px",
        threshold: 0,
      }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadOlderMessages, selectedConversationId, containerReadyTick]);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const content = container.firstElementChild;
    if (!content) return;

    const ro = new ResizeObserver(() => {
      const state = scrollStateRef.current[selectedConversationId];
      if (state && state.atBottom) {
        const bottom = Math.max(0, container.scrollHeight - container.clientHeight);
        if (Math.abs(container.scrollTop - bottom) > 2) {
          container.scrollTop = bottom;
        }
      }
    });

    ro.observe(content);
    return () => ro.disconnect();
  }, [selectedConversationId]);

  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    const container = messagesContainerRef.current;
    if (!pending || !container) return;
    if (pending.convId !== selectedConversationId) {
      pendingAnchorRef.current = null;
      return;
    }
    const pendingMode = pending.mode;
    const pendingConvId = pending.convId;

    restoringRef.current = true;
    let didAdjust = false;
    if (pending.messageId) {
      const anchorEl = container.querySelector(`[data-msg-id="${pending.messageId}"]`);
      if (anchorEl) {
        const containerTop = container.getBoundingClientRect().top;
        const newOffset = anchorEl.getBoundingClientRect().top - containerTop;
        const delta = newOffset - (pending.offset || 0);
        if (delta) {
          container.scrollTop += delta;
          didAdjust = true;
        }
      }
    }

    if (pending.stickToBottom) {
      container.scrollTop = getBottomScrollTop(container);
      didAdjust = true;
    }

    if (didAdjust) updateScrollState(selectedConversationId, container);
    pendingAnchorRef.current = null;
    requestAnimationFrame(() => {
      restoringRef.current = false;
      if (pendingMode === "older" && pendingConvId === "global" && loadOlderChainRef.current === pendingConvId) {
        const paging = getPagingState(pendingConvId);
        if (container.scrollTop <= PRELOAD_THRESHOLD && paging.hasOlder && !paging.isLoadingOlder) {
          loadOlderMessages(pendingConvId);
        } else {
          loadOlderChainRef.current = null;
        }
      } else if (loadOlderChainRef.current === pendingConvId) {
        loadOlderChainRef.current = null;
      }
    });
  }, [currentMessages, selectedConversationId, containerReadyTick, loadOlderMessages]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const pending = pendingRestoreRef.current;
    if (!pending || pending.convId !== selectedConversationId) return;
    if ((currentMessages || []).length === 0) return;
    const bottom = getBottomScrollTop(container);
    restoringRef.current = true;
    if (pending.mode === "saved") {
      const targetTop = Math.min(pending.top || 0, bottom);
      container.scrollTop = targetTop;
    } else {
      container.scrollTop = bottom;
    }
    updateScrollState(pending.convId, container);
    pendingRestoreRef.current = null;
    requestAnimationFrame(() => {
      restoringRef.current = false;
    });
  }, [currentMessages, selectedConversationId, containerReadyTick]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const state = scrollStateRef.current[selectedConversationId];
    if (!state || !state.atBottom) return;
    const bottom = getBottomScrollTop(container);
    if (Math.abs(container.scrollTop - bottom) > 1) {
      restoringRef.current = true;
      container.scrollTop = bottom;
      updateScrollState(selectedConversationId, container);
      requestAnimationFrame(() => {
        restoringRef.current = false;
      });
    }
  }, [currentMessages, selectedConversationId, Object.keys(decryptedMessages).length, containerReadyTick]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container || selectedConversationId !== "global") return;
    const paging = getPagingState(selectedConversationId);
    if (!paging.hasOlder || paging.isLoadingOlder) return;
    const isScrollable = container.scrollHeight - container.clientHeight > 2;
    if (!isScrollable) {
      loadOlderMessages(selectedConversationId);
    }
  }, [currentMessages, selectedConversationId, containerReadyTick, loadOlderMessages]);

  const getUserPublicKeyJwk = async (userId, options = {}) => {
    if (!userId) return null;
    const { force = false } = options;
    const cache = publicKeyCacheRef.current;
    if (!force && cache[userId]) return cache[userId];
    if (force) delete cache[userId];

    const token = getToken();
    if (!token) return null;

    try {
      const res = await fetch(`${API_BASE}/api/users/${userId}/public-key`, {
        headers: { Authorization: `Bearer ${token}` },
      });
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

  const getLocalKeyPairForKid = async (kid) => {
    if (!kid) return null;
    const cache = keyPairCacheRef.current;
    if (cache[kid]) return cache[kid];

    if (myKeyId && kid === myKeyId && myKeyPair) {
      cache[kid] = myKeyPair;
      return myKeyPair;
    }

    const ring =
      keyRingRef.current || (currentUser ? E2EE.loadKeyRingForUser(currentUser.id) : null);
    if (ring && !keyRingRef.current) keyRingRef.current = ring;

    const entry = ring?.keys?.[kid];
    if (!entry?.publicJwk || !entry?.privateJwk) return null;

    try {
      const kp = await E2EE.importKeyPairFromJwks(entry.publicJwk, entry.privateJwk);
      cache[kid] = kp;
      return kp;
    } catch (e) {
      console.error("Failed to import keypair for kid", kid, e);
      return null;
    }
  };

  const deriveDmKeyFromPublicJwk = async (privateKey, publicJwk) => {
    if (!privateKey || !publicJwk) return null;
    const otherPublicKey = await window.crypto.subtle.importKey(
      "jwk",
      publicJwk,
      { name: "ECDH", namedCurve: "P-256" },
      true,
      []
    );

    return window.crypto.subtle.deriveKey(
      { name: "ECDH", public: otherPublicKey },
      privateKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  };

  const deriveDmAesKey = async ({ localKid, localKeyPair, remoteJwk, remoteKid }) => {
    if (!localKeyPair?.privateKey || !remoteJwk) return null;
    const cache = dmKeyCacheRef.current;
    let cacheKey = "";

    if (!remoteKid) {
      try {
        remoteKid = await E2EE.computeKeyId(remoteJwk);
      } catch {
        remoteKid = null;
      }
    }

    if (localKid || remoteKid) {
      const localTag = localKid || "current";
      const remoteTag = remoteKid || "remote";
      cacheKey = `${localTag}:${remoteTag}`;
      if (cache[cacheKey]) return cache[cacheKey];
    }

    const aesKey = await deriveDmKeyFromPublicJwk(localKeyPair.privateKey, remoteJwk);
    if (cacheKey) cache[cacheKey] = aesKey;
    return aesKey;
  };

  // ---------- GROUP KEY HELPERS ----------
  const ensureGroupKey = async (conversation, desiredVersion) => {
    if (!conversation || conversation.type !== "group" || !currentUser || !myKeyPair) {
      return null;
    }
    if (!window.crypto || !window.crypto.subtle) return null;

    const convId = conversation.id;
    const version =
      typeof desiredVersion === "number"
        ? desiredVersion
        : typeof conversation.keyVersion === "number"
          ? conversation.keyVersion
          : 0;

    const existing = groupKeyMap?.[convId]?.[version];
    if (existing && existing.cryptoKey) return existing;

    // Try localStorage first so we can decrypt old messages after rotation
    const stored = E2EE.loadGroupKeyStringMap(currentUser.id, convId);
    const storedKeyString = stored[String(version)];
    if (storedKeyString) {
      try {
        const aesKey = await E2EE.importAesKeyFromGroupKeyString(storedKeyString);
        const record = { cryptoKey: aesKey, version, keyString: storedKeyString };
        setGroupKeyMap((prev) => ({
          ...prev,
          [convId]: { ...(prev[convId] || {}), [version]: record },
        }));
        return record;
      } catch {
        // fallthrough
      }
    }

    // Server stores encrypted group keys per user, and (after the key-history fix) may store
    // ciphertext-only key history by version so old messages remain decryptable across domains.
    const encMap = conversation.encryptedKeys || {};
    const currentKV = typeof conversation.keyVersion === "number" ? conversation.keyVersion : 0;
    const hist =
      conversation.encryptedKeysByVersion && typeof conversation.encryptedKeysByVersion === "object"
        ? conversation.encryptedKeysByVersion
        : {};

    const byVersion =
      hist && hist[version] && typeof hist[version] === "object" ? hist[version] : null;

    let entry = null;
    if (byVersion && byVersion[currentUser.id]) {
      entry = byVersion[currentUser.id];
    } else if (version === currentKV) {
      entry = encMap[currentUser.id];
    }
    if (!entry) return null;

    if (typeof entry === "string") {
      try {
        entry = JSON.parse(entry);
      } catch {
        return null;
      }
    }

    if (!entry.ciphertext || !entry.iv) return null;
    if (!entry.senderPublicKey && !entry.from) return null;

    // Try embedded senderPublicKey first (reliable across key rotations),
    // then fall back to fetching current key by userId (legacy `from` field).
    const unwrapWithJwk = async (jwk) => {
      const wrapperPublicKey = await window.crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "ECDH", namedCurve: "P-256" },
        true,
        []
      );
      const wrapKey = await window.crypto.subtle.deriveKey(
        { name: "ECDH", public: wrapperPublicKey },
        myKeyPair.privateKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );
      const keyStr = await E2EE.decryptWithAesGcm(entry, wrapKey);
      return keyStr;
    };

    let groupKeyString = null;

    // Strategy 1: use embedded senderPublicKey (always correct, even after rotation)
    if (entry.senderPublicKey) {
      try {
        groupKeyString = await unwrapWithJwk(entry.senderPublicKey);
      } catch {
        // embedded key failed, try fallback
      }
    }

    // Strategy 2: fetch current public key by userId (works if wrapper hasn't rotated)
    if (!groupKeyString && entry.from) {
      try {
        const wrapperJwk = await getUserPublicKeyJwk(entry.from);
        if (wrapperJwk) {
          groupKeyString = await unwrapWithJwk(wrapperJwk);
        }
      } catch {
        // server key fetch/decrypt failed
      }
    }

    if (!groupKeyString) return null;

    const aesKey = await E2EE.importAesKeyFromGroupKeyString(groupKeyString);

    const record = { cryptoKey: aesKey, version, keyString: groupKeyString };

    setGroupKeyMap((prev) => ({
      ...prev,
      [convId]: { ...(prev[convId] || {}), [version]: record },
    }));
    E2EE.persistGroupKeyString(currentUser.id, convId, version, groupKeyString);

    return record;
  };

  const refreshConversationIfNeeded = async (convId, version) => {
    if (!convId) return null;
    const vKey = typeof version === "number" ? String(version) : "unknown";
    const attempted =
      keyHistoryFetchRef.current[convId] || (keyHistoryFetchRef.current[convId] = {});
    if (attempted[vKey]) return null;
    attempted[vKey] = true;

    const token = getToken();
    if (!token) return null;

    try {
      const res = await fetch(`${API_BASE}/api/conversations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data)) return null;
      const fresh = data.find((c) => c.id === convId) || null;
      if (!fresh) return null;
      setConversations((prev) => prev.map((c) => (c.id === convId ? { ...c, ...fresh } : c)));
      return fresh;
    } catch {
      return null;
    }
  };

  const buildEncryptedGroupKeysForMembers = async (memberIds, groupKeyString) => {
    if (!myKeyPair || !currentUser) {
      throw new Error("Missing E2EE key material for group key distribution");
    }
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Web Crypto not available");
    }

    const myPublicJwk =
      myPublicJwkRef.current ||
      (await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey));

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
        { name: "ECDH", public: memberPublicKey },
        myKeyPair.privateKey,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
      );

      const { ciphertext, iv } = await E2EE.encryptWithAesGcm(groupKeyString, wrapKey);

      // Embed senderPublicKey directly so decryption doesn't depend on the
      // wrapper's *current* server key (which changes on key rotation).
      // Keep `from` for backward compat with older clients.
      result[memberId] = { ciphertext, iv, senderPublicKey: myPublicJwk, from: currentUser.id };
    }

    return result;
  };

  const encryptForConversation = async (plaintext, conversation) => {
    if (!conversation || !E2EE.isConversationE2EE(conversation)) return { plaintext };
    if (!currentUser) throw new Error("No current user");
    if (!window.crypto || !window.crypto.subtle) throw new Error("Web Crypto not available");

    if (conversation.type === "dm") {
      if (!myKeyPair) throw new Error("Missing E2EE keypair for DM");
      const memberIds = conversation.memberIds || [];
      const otherId = memberIds.find((id) => id !== currentUser.id);
      if (!otherId) throw new Error("No other member in DM");

      const otherJwk = await getUserPublicKeyJwk(otherId);
      if (!otherJwk) {
        throw new Error(
          "Recipient has no public key on server yet (they probably have not opened chat)"
        );
      }

      const aesKey = await deriveDmKeyFromPublicJwk(myKeyPair.privateKey, otherJwk);
      if (!aesKey) throw new Error("Failed to derive DM key");

      const payload = await E2EE.encryptDmMessage(plaintext, aesKey);
      const senderPublicJwk =
        myPublicJwkRef.current ||
        (await window.crypto.subtle.exportKey("jwk", myKeyPair.publicKey));
      const senderKeyId = myKeyId || (await E2EE.computeKeyId(senderPublicJwk));
      const recipientKeyId = await E2EE.computeKeyId(otherJwk);

      payload.version = 2;
      if (senderKeyId) payload.senderKeyId = senderKeyId;
      if (recipientKeyId) payload.recipientKeyId = recipientKeyId;
      payload.senderPublicKey = senderPublicJwk;
      payload.recipientPublicKey = otherJwk;

      return payload;
    }

    if (conversation.type === "group") {
      const v = typeof conversation.keyVersion === "number" ? conversation.keyVersion : 0;
      const keyEntry =
        groupKeyMap?.[conversation.id]?.[v] || (await ensureGroupKey(conversation, v));
      if (!keyEntry || !keyEntry.cryptoKey) {
        throw new Error("Group key is not available yet for this conversation");
      }
      const payload = await E2EE.encryptDmMessage(plaintext, keyEntry.cryptoKey);
      payload.keyVersion = v; // tag group messages with key version used
      return payload;
    }

    return { plaintext };
  };

  // ---------- GROUP KEY HISTORY REPAIR (re-joined members) ----------
  // If a member was previously in the group during an older key epoch, but their
  // encrypted key envelope for that epoch is missing (commonly after an older bug
  // + a domain switch), an owner/admin can re-wrap the epoch key for them and
  // patch it to the server. This restores decryption for their older messages.
  const patchMissingGroupKeyHistoryForCurrentMembers = async (conversation) => {
    if (!conversation || conversation.type !== "group") return;
    if (!canManageGroupMembers) return;
    if (!currentUser || !myKeyPair) return;

    const convId = conversation.id;
    if (keyHistoryPatchInFlightRef.current[convId]) return;
    keyHistoryPatchInFlightRef.current[convId] = true;

    try {
      /*
         GROUP KEY HISTORY REPAIR
         Seamlessly ensures all current members satisfy the "full history access" policy 
         by backfilling keys for any version they are missing.
      */
      const hist =
        conversation.encryptedKeysByVersion && typeof conversation.encryptedKeysByVersion === "object"
          ? conversation.encryptedKeysByVersion
          : {};

      const currentMembers = new Set(conversation.memberIds || []);
      const currentKV = typeof conversation.keyVersion === "number" ? conversation.keyVersion : 0;

      const missingByVersion = {};

      if (currentKV >= 1) {
        for (let v = 1; v <= currentKV; v++) {
          const epochMap = hist[v] && typeof hist[v] === "object" ? hist[v] : {};
          const missing = [];
          for (const uid of currentMembers) {
            if (!epochMap[uid]) {
              missing.push(uid);
            }
          }
          if (missing.length > 0) {
            missingByVersion[v] = missing;
          }
        }
      }

      const missingVersions = Object.keys(missingByVersion);
      if (missingVersions.length === 0) return;

      const token = getToken();
      if (!token) return;

      // userId -> { [version]: encryptedKeyBlob }
      const patchByUser = {};

      for (const vStr of missingVersions) {
        const v = Number(vStr);
        const userIds = missingByVersion[v] || [];
        if (userIds.length === 0) continue;

        const keyEntry = await ensureGroupKey(conversation, v);
        if (!keyEntry || !keyEntry.keyString) continue;

        let encryptedForMissing = null;
        try {
          encryptedForMissing = await buildEncryptedGroupKeysForMembers(userIds, keyEntry.keyString);
        } catch (e) {
          console.error("Failed to build historical encrypted keys for missing members", e);
          continue;
        }

        for (const uid of userIds) {
          const blob = encryptedForMissing?.[uid];
          if (!blob) continue;
          if (!patchByUser[uid]) patchByUser[uid] = {};
          patchByUser[uid][v] = blob;
        }
      }

      const userIdsToPatch = Object.keys(patchByUser);
      for (const uid of userIdsToPatch) {
        const res = await fetch(
          `${API_BASE}/api/conversations/${convId}/key-history/patch-user`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ userId: uid, versions: patchByUser[uid] }),
          }
        );

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          console.warn("Failed to patch key history for user", uid, data);
          continue;
        }

        setConversations((prev) =>
          prev.map((c) => (c.id === data.id ? { ...c, ...data } : c))
        );
      }
    } finally {
      keyHistoryPatchInFlightRef.current[convId] = false;
    }
  };

  // When an owner/admin views a group, automatically repair missing historical key envelopes
  // for current members.
  useEffect(() => {
    if (!currentConversation || currentConversation.type !== "group") return;
    if (!canManageGroupMembers) return;

    // Simple debounce/throttle via ref check is handled inside the function, 
    // but we want to ensure we don't spam if dependencies change rapidly.
    const timeout = setTimeout(() => {
      (async () => {
        try {
          await patchMissingGroupKeyHistoryForCurrentMembers(currentConversation);
        } catch (e) {
          console.error("Key history repair failed", e);
        }
      })();
    }, 2000); // 2s delay to let initial load settle

    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversation, canManageGroupMembers, currentUser?.id, myKeyPair]);

  // ---------- MEDIA LAZY LOADING HELPERS ----------
  // Moved here to ensure access to ensuredGroupKey and deriveDmAesKey definitions (hoisting fix)

  const fetchMoreMedia = useCallback(async () => {
    if (!selectedConversationId || isMediaLoading || !hasMoreMedia) return;
    const cid = selectedConversationId;
    setIsMediaLoading(true);

    try {
      const token = getToken();
      const beforeId = mediaCursorRef.current;
      const url = `${API_BASE}/api/conversations/${cid}/messages?limit=50${beforeId ? `&beforeId=${beforeId}` : ""}`;

      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error("Failed to fetch history");

      const messages = await res.json();
      if (!Array.isArray(messages) || messages.length === 0) {
        setHasMoreMedia(false);
        setIsMediaLoading(false);
        return;
      }

      mediaCursorRef.current = messages[0].id;

      // DECRYPT BATCH
      const conv = conversations.find(c => c.id === cid);
      const isE2EE = conv && E2EE.isConversationE2EE(conv);

      const decryptedBatch = [];

      for (const msg of messages) {
        let plaintext = msg.text;

        if (isE2EE) {
          try {
            const parsed = JSON.parse(msg.text);
            if (parsed && parsed.e2ee) {
              if (conv.type === "dm") {
                // Standalone decryption for DM to avoid scope issues with main effect
                const isSender = msg.senderId === currentUser.id;
                const localKid = isSender ? parsed.senderKeyId : parsed.recipientKeyId;
                const remoteJwk = isSender ? parsed.recipientPublicKey : parsed.senderPublicKey;

                let localPair = await getLocalKeyPairForKid(localKid);
                if (!localPair && myKeyPair) localPair = myKeyPair;

                if (localPair && remoteJwk) {
                  try {
                    const key = await deriveDmAesKey({
                      localKid,
                      localKeyPair: localPair,
                      remoteJwk,
                    });
                    if (key) {
                      plaintext = await E2EE.decryptDmMessage(parsed, key);
                    }
                  } catch {
                    // Decryption failed, plaintext stays as original encrypted text
                  }
                }
                // If no remoteJwk in message, try fetching from server (legacy messages)
                if (plaintext === msg.text && !remoteJwk && localPair) {
                  const otherId = conv.memberIds?.find(id => id !== currentUser.id);
                  if (otherId) {
                    try {
                      const fetchedJwk = await getUserPublicKeyJwk(otherId);
                      if (fetchedJwk) {
                        const key = await deriveDmKeyFromPublicJwk(localPair.privateKey, fetchedJwk);
                        if (key) {
                          plaintext = await E2EE.decryptDmMessage(parsed, key);
                        }
                      }
                    } catch {
                      // Fallback decryption failed
                    }
                  }
                }
              } else if (conv.type === "group") {
                const msgVer = typeof parsed.keyVersion === "number" ? parsed.keyVersion : (conv.keyVersion || 0);
                const keyEntry = await ensureGroupKey(conv, msgVer);
                if (keyEntry?.cryptoKey) {
                  try {
                    plaintext = await E2EE.decryptDmMessage(parsed, keyEntry.cryptoKey);
                  } catch { }
                }
              }
            }
          } catch (e) {
            // ignore
          }
        }

        decryptedBatch.push({ ...msg, text: plaintext });
      }

      setMediaMessagesMap((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const msg of decryptedBatch) {
          const payload = parseMessagePayload(String(msg.text));
          if (payload && Array.isArray(payload.attachments) && payload.attachments.length > 0) {
            if (!next.has(msg.id)) {
              next.set(msg.id, msg);
              changed = true;
            }
          }
        }
        return changed ? next : prev;
      });

      // Optimistic cache update
      setDecryptedMessages(prev => {
        const next = { ...prev };
        let changed = false;
        for (const msg of decryptedBatch) {
          if (msg.text !== msg.originalText && !next[msg.id]) {
            next[msg.id] = msg.text;
            changed = true;
          }
        }
        return changed ? next : prev;
      });

    } catch (e) {
      console.error("Lazy media fetch failed", e);
    } finally {
      setIsMediaLoading(false);
    }
  }, [
    selectedConversationId,
    isMediaLoading,
    hasMoreMedia,
    conversations,
    ensureGroupKey,
    currentUser,
    myKeyPair,
    deriveDmAesKey,
    getLocalKeyPairForKid,
    getUserPublicKeyJwk,
    deriveDmKeyFromPublicJwk
  ]);

  const handleMediaScroll = useCallback((e) => {
    const { scrollTop, scrollHeight, clientHeight } = e.target;
    if (scrollHeight - scrollTop - clientHeight < 100) {
      if (!isMediaLoading && hasMoreMedia) {
        fetchMoreMedia();
      }
    }
  }, [isMediaLoading, hasMoreMedia, fetchMoreMedia]);

  // Auto-fetch media when the media tab is opened and there are few items
  useEffect(() => {
    if (detailsTab === "media" && !isMediaLoading && hasMoreMedia && mediaItems.length < 12) {
      fetchMoreMedia();
    }
  }, [detailsTab, isMediaLoading, hasMoreMedia, mediaItems.length, fetchMoreMedia]);

  // ---------- E2EE DECRYPTION EFFECT (DM + Group) ----------
  // Retry-aware: uses a counter per message instead of a boolean flag.
  // When key material changes (myKeyPair), counters are reset to allow fresh attempts.
  const prevDecryptKeyPairRef = useRef(null);

  useEffect(() => {
    const conv = currentConversation;
    if (!conv || !E2EE.isConversationE2EE(conv)) return;
    if (!currentUser) return;
    if (!window.crypto || !window.crypto.subtle) return;
    // Don't attempt decryption until our keypair is loaded
    if (!myKeyPair) return;

    // When key material changes, reset retry counters so we re-attempt all failed messages
    if (prevDecryptKeyPairRef.current !== myKeyPair) {
      prevDecryptKeyPairRef.current = myKeyPair;
      // Reset only failed entries (counters > 0 but message not in decryptedMessages)
      const queue = decryptQueueRef.current;
      for (const id of Object.keys(queue)) {
        if (queue[id] > 0 && !decryptedMessages[id]) {
          delete queue[id];
        }
      }
    }

    let cancelled = false;
    const MAX_DECRYPT_RETRIES = 5;

    (async () => {
      try {
        const updates = {};
        const existingDecrypts = decryptedMessages || {};

        // DM: use key history metadata when available
        let dmFallbackKey = null;
        let dmForceRefresh = false;
        let dmOtherId = null;
        const deriveFallbackKey = async (force = false) => {
          if (!myKeyPair) return null;
          return E2EE.deriveDmKeyForConversation({
            conversation: conv,
            currentUserId: currentUser.id,
            myKeyPair,
            fetchUserPublicKeyJwk: (id) => getUserPublicKeyJwk(id, { force }),
          });
        };

        const decryptDmPayload = async (msg, parsed, options = {}) => {
          const { forceRemote = false } = options;
          const isSender = msg.senderId === currentUser.id;
          const localKid = isSender ? parsed.senderKeyId : parsed.recipientKeyId;
          const remoteKid = isSender ? parsed.recipientKeyId : parsed.senderKeyId;
          const remoteJwk = isSender ? parsed.recipientPublicKey : parsed.senderPublicKey;
          const remoteId = isSender ? dmOtherId : msg.senderId;

          let localPair = await getLocalKeyPairForKid(localKid);

          // Only fall back to current session key if no specific key ID was provided (legacy messages).
          // If a key ID was specified but not found, we still try current key as last resort,
          // but this may fail if keys have rotated.
          if (!localPair && myKeyPair) {
            localPair = myKeyPair;
          }

          if (!localPair) {
            return null; // Return null instead of throwing to allow fallback
          }

          // Try decryption with remote JWK from message (most reliable source)
          if (remoteJwk) {
            // Try cached derived key first
            try {
              const cachedKey = await deriveDmAesKey({
                localKid,
                localKeyPair: localPair,
                remoteJwk,
                remoteKid,
              });
              if (cachedKey) {
                return await E2EE.decryptDmMessage(parsed, cachedKey);
              }
            } catch (e) {
              // Cached key derivation or decryption failed, try fresh derive
            }

            // Fresh derive from JWK in message
            try {
              const freshKey = await deriveDmKeyFromPublicJwk(localPair.privateKey, remoteJwk);
              if (freshKey) {
                return await E2EE.decryptDmMessage(parsed, freshKey);
              }
            } catch (e) {
              // Fresh decryption failed, continue to fallback
            }
          }

          // Fallback: if we have remoteId but no JWK in message (or JWK-based decryption failed),
          // try fetching current public key from server. This works for legacy messages or when
          // the embedded key doesn't match (though it may fail if keys have rotated since sending).
          if (remoteId) {
            try {
              const fetchedJwk = await getUserPublicKeyJwk(remoteId, { force: forceRemote });
              if (fetchedJwk) {
                const freshKey = await deriveDmKeyFromPublicJwk(localPair.privateKey, fetchedJwk);
                if (freshKey) {
                  return await E2EE.decryptDmMessage(parsed, freshKey);
                }
              }
            } catch (e) {
              // Fetched key decryption failed
            }
          }

          return null; // Return null to allow caller to try other fallback methods
        };

        if (conv.type === "dm") {
          dmOtherId = conv.memberIds.find((id) => id !== currentUser.id);
        }

        const tryDecryptWithAnyGroupKey = async (parsed, convForKeys) => {
          if (!convForKeys?.id) return null;
          const local = E2EE.loadGroupKeyStringMap(currentUser.id, convForKeys.id);
          const serverHist =
            convForKeys.encryptedKeysByVersion && typeof convForKeys.encryptedKeysByVersion === "object"
              ? convForKeys.encryptedKeysByVersion
              : {};
          const versions = new Set([
            ...Object.keys(serverHist || {}),
            ...Object.keys(groupKeyMap?.[convForKeys.id] || {}),
            ...Object.keys(local || {}),
          ]);

          for (const vStr of versions) {
            const v = Number(vStr);
            if (!Number.isFinite(v)) continue;
            const candidate =
              groupKeyMap?.[convForKeys.id]?.[v] || (await ensureGroupKey(convForKeys, v));
            if (!candidate?.cryptoKey) continue;
            try {
              return await E2EE.decryptDmMessage(parsed, candidate.cryptoKey);
            } catch {
              // keep trying
            }
          }
          return null;
        };

        const msgs = messagesByConversationRef.current?.[selectedConversationId] || [];
        for (const msg of msgs) {
          if (cancelled) return;
          if (!msg.id || existingDecrypts[msg.id]) continue;

          // If text is not set, skip
          const text = msg.text;
          if (!text) continue;

          // Check if it looks like JSON E2EE
          if (!text.startsWith("{") || !text.includes('"e2ee":true')) {
            // Not encrypted or just plain text
            continue;
          }

          // Retry counter: skip if we've already retried too many times
          const retryCount = decryptQueueRef.current[msg.id] || 0;
          if (retryCount >= MAX_DECRYPT_RETRIES) continue;
          decryptQueueRef.current[msg.id] = retryCount + 1;

          try {
            const parsed = JSON.parse(text);
            if (!parsed.e2ee) continue;

            let decryptedText = null;

            if (conv.type === "dm") {
              // Try decryption using key metadata from the message
              if (parsed.senderKeyId || parsed.recipientKeyId || parsed.senderPublicKey || parsed.recipientPublicKey) {
                try {
                  decryptedText = await decryptDmPayload(msg, parsed, { forceRemote: dmForceRefresh });
                } catch (e) {
                  // Decryption with message keys failed, will try fallback
                  console.debug("DM decryptDmPayload failed, trying fallback:", e.message);
                }
              }

              // Fallback: try with derived key from current keypair and other user's server key
              if (decryptedText == null && dmFallbackKey) {
                try {
                  decryptedText = await E2EE.decryptDmMessage(parsed, dmFallbackKey);
                } catch {
                  // try refresh below
                }
              }

              // If still not decrypted, force refresh and retry
              if (decryptedText == null && !dmForceRefresh && dmOtherId) {
                dmForceRefresh = true;
                dmFallbackKey = await deriveFallbackKey(true);
                try {
                  decryptedText = await decryptDmPayload(msg, parsed, { forceRemote: true });
                } catch (e) {
                  // Decryption with refreshed keys failed
                  console.debug("DM decryptDmPayload (force refresh) failed:", e.message);
                }
                if (decryptedText == null && dmFallbackKey) {
                  try {
                    decryptedText = await E2EE.decryptDmMessage(parsed, dmFallbackKey);
                  } catch {
                    // still failed
                  }
                }
              }

              if (decryptedText != null) {
                updates[msg.id] = decryptedText;
                continue;
              }

              // Don't throw - just skip so retry can happen on next effect run
              continue;
            }

            // GROUP:
            // - prefer message.keyVersion
            // - if missing, try current conv.keyVersion first
            // - if still fails, try any cached versions (localStorage + in-memory)
            const msgKeyVersion =
              typeof parsed.keyVersion === "number"
                ? parsed.keyVersion
                : typeof conv.keyVersion === "number"
                  ? conv.keyVersion
                  : 0;

            let convForKeys = conv;
            let keyEntry =
              groupKeyMap?.[conv.id]?.[msgKeyVersion] ||
              (await ensureGroupKey(convForKeys, msgKeyVersion));

            if (!keyEntry?.cryptoKey) {
              const refreshed = await refreshConversationIfNeeded(conv.id, msgKeyVersion);
              if (refreshed) {
                convForKeys = refreshed;
                keyEntry =
                  groupKeyMap?.[conv.id]?.[msgKeyVersion] ||
                  (await ensureGroupKey(convForKeys, msgKeyVersion));
              }
            }

            if (keyEntry?.cryptoKey) {
              try {
                const plaintext = await E2EE.decryptDmMessage(parsed, keyEntry.cryptoKey);
                updates[msg.id] = plaintext;
                continue;
              } catch (e) {
                const fallback = await tryDecryptWithAnyGroupKey(parsed, convForKeys);
                if (fallback != null) {
                  updates[msg.id] = fallback;
                  continue;
                }
                // Don't throw - allow retry
              }
            }

            const fallback = await tryDecryptWithAnyGroupKey(parsed, convForKeys);
            if (fallback != null) {
              updates[msg.id] = fallback;
            }
            continue;
          } catch (e) {
            console.debug("E2EE decrypt attempt", retryCount + 1, "failed for msg", msg.id);
            // Don't store error text - allow retry on next effect run.
            // The message will naturally show "Encrypted message..." placeholder.
          }
        }

        if (cancelled) return;
        if (Object.keys(updates).length > 0) {
          setDecryptedMessages((prev) => ({ ...prev, ...updates }));
        }
      } catch (e) {
        console.error("E2EE batch decrypt failed", e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentMessages, currentConversation, myKeyPair, myKeyId, currentUser, groupKeyMap]);

  const conversationLabel = (conv) => {
    if (!conv) return "Conversation";
    if (conv.id === "global") return "Global Chat";

    if (conv.type === "dm" && currentUser) {
      const otherId = conv.memberIds?.find((id) => id !== currentUser.id);
      const u = allUsers.find((x) => x.id === otherId);
      return u ? `DM: ${u.username}` : "DM";
    }

    return conv.name || "Group";
  };

  const joinConversation = (id) => {
    updateScrollState(selectedConversationRef.current, messagesContainerRef.current);
    setSelectedConversationId(id);
    if (!initialHistoryLoadedRef.current[id]) {
      setPagingState(id, { isLoadingOlder: true });
      socket.emit("chat:join", { conversationId: id, limit: PAGE_SIZE });
    }

    const saved = scrollStateRef.current[id];
    if (saved && !saved.atBottom) {
      pendingRestoreRef.current = { convId: id, mode: "saved", top: saved.scrollTop };
      lastAtBottomRef.current = false;
      setIsUserAtBottom(false);
    } else {
      pendingRestoreRef.current = { convId: id, mode: "bottom" };
      lastAtBottomRef.current = true;
      setIsUserAtBottom(true);
    }
    setIsSidebarOpen(false);
    setIsDetailsOpen(false);
    setDetailsTab("details");
    setReplyToId(null);
    setEditingMessageId(null);
    clearPendingImages();
    setHasNewWhileScrolledUp(false);


    setUnreadCounts((prev) => {
      const copy = { ...prev };
      delete copy[id];
      return copy;
    });

    setLastActive((prev) => ({ ...prev, [id]: Date.now() }));
  };


  const submitEdit = async () => {
    if (!editingMessageId || !currentUser) return;

    if (editTargetMsg) {
      const raw =
        editTargetMsg.id && decryptedMessages[editTargetMsg.id] != null
          ? String(decryptedMessages[editTargetMsg.id])
          : String(editTargetMsg.text || "");
      const payload = parseMessagePayload(raw);
      if (payload && Array.isArray(payload.attachments) && payload.attachments.length > 0) {
        alert("Messages with images cannot be edited yet.");
        return;
      }
    }

    const trimmed = input.trim();
    if (!trimmed) return;

    if (trimmed.length > MAX_MESSAGE_CHARS) {
      alert(`Message is too long (${trimmed.length}/${MAX_MESSAGE_CHARS}). Please shorten it.`);
      return;
    }

    const conv = conversations.find((c) => c.id === selectedConversationId) || null;

    let textToSend = trimmed;

    if (conv && E2EE.isConversationE2EE(conv)) {
      try {
        const encryptedPayload = await encryptForConversation(textToSend, conv);

        if (encryptedPayload && encryptedPayload.e2ee) {
          textToSend = JSON.stringify(encryptedPayload);
        } else if (encryptedPayload && encryptedPayload.plaintext) {
          textToSend = encryptedPayload.plaintext;
        }
      } catch (e) {
        console.error("E2EE edit failed", e);
        alert("Could not encrypt edited message. Please try again.");
        return;
      }
    }

    if (!ensureSocketPayloadFits(textToSend)) {
      return;
    }

    if (!socket.connected) {
      alert("Not connected to the realtime server yet. Refresh and try again.");
      return;
    }

    const nowIso = new Date().toISOString();

    // Optimistic update for smoother UX
    setMessagesByConversation((prev) => {
      const arr = prev[selectedConversationId] || [];
      return {
        ...prev,
        [selectedConversationId]: arr.map((m) =>
          m.id === editingMessageId ? { ...m, text: textToSend, editedAt: nowIso } : m
        ),
      };
    });
    setDecryptedMessages((prev) => ({ ...prev, [editingMessageId]: trimmed }));

    socket.emit("chat:edit", {
      conversationId: selectedConversationId || "global",
      messageId: editingMessageId,
      text: textToSend,
    });

    setInput("");
    setEditingMessageId(null);
    flashMessage(editingMessageId, 2400);
  };

  const sendMessage = async () => {
    if (editingMessageId) {
      await submitEdit();
      return;
    }
    const trimmed = input.trim();
    const readyImages = pendingImages.filter(
      (item) => item.status === "ready" && (item.dataUrl || item.url)
    );
    const hasProcessing = pendingImages.some((item) => item.status === "loading");

    if (hasProcessing) {
      alert("Files are still uploading. Please wait a moment.");
      return;
    }
    await dispatchMessage({
      text: trimmed,
      attachments: readyImages,
      clearInput: true,
      clearReply: true,
      clearPendingImages: true,
    });
  };

  const openImageViewer = useCallback((image) => {
    if (!image || !image.src) return;
    setActiveImage(image);
  }, []);

  const closeImageViewer = useCallback(() => {
    setActiveImage(null);
  }, []);

  useEffect(() => {
    if (!activeImage) return;
    const handleKey = (event) => {
      if (event.key === "Escape") {
        closeImageViewer();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeImage, closeImageViewer]);


  const handleDeleteMessage = async (messageId) => {
    if (!messageId) return;
    const token = getToken();
    if (!token) return;

    // Use current selected conversation ID since messages belong to it
    const convId = selectedConversationId || "global";

    try {
      const res = await fetch(`${API_BASE}/api/conversations/${convId}/messages/${messageId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        const data = await res.json();
        alert(data.message || "Failed to delete message");
      } else {
        // Clean up uploaded files referenced in the deleted message (client-side best-effort)
        const raw = decryptedMessages[messageId];
        if (raw && typeof raw === "string") {
          const uploadRegex = /\/uploads\/([a-zA-Z0-9._-]+)/g;
          let match;
          while ((match = uploadRegex.exec(raw)) !== null) {
            deleteUploadedFile(`/uploads/${match[1]}`);
          }
        }
      }
    } catch (e) {
      console.error("Delete failed", e);
      alert("Failed to delete message");
    }
  };

  const handleReactToMessage = useCallback((messageId, emoji) => {
    if (!messageId || !emoji || !socket) return;
    const convId = selectedConversationId || "global";
    socket.emit("chat:react", { conversationId: convId, messageId, emoji });
  }, [selectedConversationId]);

  const handleLogout = () => {
    clearAuth();
    socket.disconnect();
    navigate("/");
  };

  const startDmWith = async (username) => {
    const token = getToken();
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

    setConversations((prev) => (prev.some((c) => c.id === data.id) ? prev : [...prev, data]));
    setLastActive((prev) => ({ ...prev, [data.id]: Date.now() }));
    joinConversation(data.id);
  };

  const submitCreateGroup = async () => {
    const token = getToken();
    if (!token) return;
    if (!currentUser) return;

    if (!groupName.trim()) {
      alert("Enter a group name.");
      return;
    }

    const allMemberIds = Array.from(new Set([currentUser.id, ...groupMemberIds]));

    let payload = { name: groupName.trim(), memberIds: groupMemberIds };

    let groupKeyString = null;
    let encryptedKeys = null;
    let keyVersion = 0;

    if (window.crypto && window.crypto.subtle && myKeyPair && allMemberIds.length > 0) {
      try {
        groupKeyString = E2EE.generateRandomGroupKeyString();
        encryptedKeys = await buildEncryptedGroupKeysForMembers(allMemberIds, groupKeyString);
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

    if (groupKeyString && keyVersion === 1 && data.id) {
      try {
        const aesKey = await E2EE.importAesKeyFromGroupKeyString(groupKeyString);
        setGroupKeyMap((prev) => ({
          ...prev,
          [data.id]: {
            ...(prev[data.id] || {}),
            [keyVersion]: { cryptoKey: aesKey, version: keyVersion, keyString: groupKeyString },
          },
        }));
        E2EE.persistGroupKeyString(currentUser.id, data.id, keyVersion, groupKeyString);
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
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]
    );
  };

  // Group actions (atomic add/remove + key delivery/rotation)
  const addUserToCurrentGroup = async (userId) => {
    if (!currentConversation) return;
    const token = getToken();
    if (!token) return;

    // If this is an encrypted group (keyVersion >= 1), we MUST deliver the group key on add.
    const isEncryptedGroup =
      currentConversation.type === "group" &&
      typeof currentConversation.keyVersion === "number" &&
      currentConversation.keyVersion >= 1;

    let encryptedKeyForNewMember = null;
    let encryptedKeysForNewMemberByVersion = {};

    if (isEncryptedGroup) {
      // E2EE may still be initializing (new accounts especially)
      if (!myKeyPair || !currentUser) {
        alert("Encryption is still initializing. Try again in a moment.");
        return;
      }

      try {
        const currentV = currentConversation.keyVersion;
        let successForCurrent = false;

        // Iterate all versions (1..currentV) to ensure new member can read history.
        // We do this best-effort for old keys, but strictly for the current key.
        for (let v = 1; v <= currentV; v++) {
          const keyEntry =
            groupKeyMap?.[currentConversation.id]?.[v] ||
            (await ensureGroupKey(currentConversation, v));

          if (!keyEntry?.keyString) {
            if (v === currentV) {
              console.warn("Current group encryption key is not ready yet.");
            }
            continue;
          }

          // Retry logic (mostly for fetching public key of new user if needed)
          let blob = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const encryptedMap = await buildEncryptedGroupKeysForMembers(
                [userId],
                keyEntry.keyString
              );
              blob = encryptedMap?.[userId] || null;
              if (blob) break;
            } catch (e) {
              if (attempt === 2) console.warn(`Failed to encrypt key v${v} for new user`, e);
              await new Promise((r) => setTimeout(r, 400 + attempt * 200));
            }
          }

          if (blob) {
            encryptedKeysForNewMemberByVersion[v] = blob;
            if (v === currentV) {
              successForCurrent = true;
              encryptedKeyForNewMember = blob;
            }
          }
        }

        if (!successForCurrent) {
          alert(
            "Cannot add this user yet: they haven't generated/uploaded their encryption key.\n" +
            "Tell them to log in and open the chat page once, then try again."
          );
          return;
        }
      } catch (e) {
        console.error("Failed to build encrypted group keys for new member", e);
        alert(
          "Cannot add this user yet: encryption key delivery failed.\n" +
          "Tell them to log in and open the chat page once, then try again."
        );
        return;
      }
    }

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/add-member`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          userId,
          encryptedKeyForNewMember,
          encryptedKeysForNewMemberByVersion,
        }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to add member");
      return;
    }

    setConversations((prev) => prev.map((c) => (c.id === data.id ? { ...c, ...data } : c)));
  };

  const removeUserFromCurrentGroup = async (userId) => {
    if (!currentConversation) return;

    const token = getToken();
    if (!token) return;

    let rotatedEncryptedKeys = null;
    let rotatedKeyVersion = null;

    try {
      const conv = currentConversation;
      const remainingMemberIds = (conv.memberIds || []).filter((id) => id !== userId);

      if (conv.type === "group" && remainingMemberIds.length > 0) {
        const newGroupKeyString = E2EE.generateRandomGroupKeyString();
        rotatedEncryptedKeys = await buildEncryptedGroupKeysForMembers(
          remainingMemberIds,
          newGroupKeyString
        );
        rotatedKeyVersion = (typeof conv.keyVersion === "number" ? conv.keyVersion : 0) + 1;

        const aesKey = await E2EE.importAesKeyFromGroupKeyString(newGroupKeyString);
        setGroupKeyMap((prev) => ({
          ...prev,
          [conv.id]: {
            ...(prev[conv.id] || {}),
            [rotatedKeyVersion]: {
              cryptoKey: aesKey,
              version: rotatedKeyVersion,
              keyString: newGroupKeyString,
            },
          },
        }));
        E2EE.persistGroupKeyString(currentUser.id, conv.id, rotatedKeyVersion, newGroupKeyString);
      }
    } catch (e) {
      console.error("Failed to rotate group key after removal", e);
      rotatedEncryptedKeys = null;
      rotatedKeyVersion = null;
    }

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/remove-member`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          userId,
          rotatedEncryptedKeys,
          rotatedKeyVersion,
        }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to remove member");
      return;
    }

    setConversations((prev) => prev.map((c) => (c.id === data.id ? { ...c, ...data } : c)));
  };

  const leaveCurrentGroup = async () => {
    if (!currentConversation) return;
    const token = getToken();
    if (!token) return;

    const res = await fetch(`${API_BASE}/api/conversations/${currentConversation.id}/leave`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.message || "Failed to leave group");
      return;
    }

    setShowSettingsModal(false);
  };

  const promoteToAdmin = async (userId) => {
    if (!currentConversation) return;
    const token = getToken();
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
      alert(data.message || "Failed to promote admin");
      return;
    }

    setConversations((prev) => prev.map((c) => (c.id === data.id ? { ...c, ...data } : c)));
  };

  const demoteAdmin = async (userId) => {
    if (!currentConversation) return;
    const token = getToken();
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/demote-admin`,
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
      alert(data.message || "Failed to demote admin");
      return;
    }

    setConversations((prev) => prev.map((c) => (c.id === data.id ? { ...c, ...data } : c)));
  };

  const transferOwnership = async (newOwnerId) => {
    if (!currentConversation) return;
    if (!newOwnerId) return;

    const token = getToken();
    if (!token) return;

    const res = await fetch(
      `${API_BASE}/api/conversations/${currentConversation.id}/transfer-ownership`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ newOwnerId }),
      }
    );

    const data = await res.json();
    if (!res.ok) {
      alert(data.message || "Failed to transfer ownership");
      return;
    }

    setConversations((prev) => prev.map((c) => (c.id === data.id ? { ...c, ...data } : c)));
    setTransferOwnerId("");
  };

  // -----------------------
  // UI RENDER
  // -----------------------

  // -----------------------
  // UI RENDER
  // -----------------------



  return (
    <div
      className="relative w-full text-slate-100 overflow-hidden flex flex-col"
      style={{
        height: "calc(100dvh - var(--ss-banner-h, 0px))",
        backgroundColor: "#020308",
        backgroundImage:
          "radial-gradient(1000px 720px at 12% 0%, rgb(var(--ss-accent-rgb) / 0.36), transparent 62%), radial-gradient(900px 600px at 88% 8%, rgb(var(--ss-accent-rgb) / 0.24), transparent 64%), radial-gradient(800px 700px at 50% 120%, rgb(var(--ss-accent-rgb) / 0.14), transparent 60%)",
      }}
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-24 -top-36 h-96 w-96 rounded-full bg-[radial-gradient(circle_at_30%_30%,rgb(var(--ss-accent-rgb)/0.42),transparent)] blur-3xl opacity-90" />
        <div className="absolute right-[-12%] top-8 h-[28rem] w-[28rem] rounded-full bg-[radial-gradient(circle_at_40%_35%,rgb(var(--ss-accent-rgb)/0.28),transparent)] blur-3xl opacity-80" />
        <div className="absolute inset-x-0 bottom-[-40%] h-[50%] bg-[radial-gradient(60%_60%_at_50%_50%,rgb(var(--ss-accent-rgb)/0.18),transparent)] blur-2xl" />
      </div>

      <div className="relative h-full w-full px-3 py-4 md:px-6">
        <div className="relative flex h-full w-full overflow-hidden rounded-3xl nebula-shell">
          {/* Mobile backdrops */}
          {isSidebarOpen && (
            <button
              aria-label="Close sidebar"
              onClick={() => setIsSidebarOpen(false)}
              className="absolute inset-0 z-40 bg-black/60 md:hidden"
            />
          )}

          {isDetailsOpen && (
            <button
              aria-label="Close details"
              onClick={() => setIsDetailsOpen(false)}
              className="absolute inset-0 z-40 bg-black/60 lg:hidden"
            />
          )}
          {/* LEFT SIDEBAR */}
          <ChatSidebar
            isSidebarOpen={isSidebarOpen}
            setIsSidebarOpen={setIsSidebarOpen}
            currentUser={currentUser}
            handleLogout={handleLogout}
            userSearchTerm={userSearchTerm}
            setUserSearchTerm={setUserSearchTerm}
            filteredUsers={filteredUsers}
            startDmWith={startDmWith}
            conversations={conversations}
            unreadCounts={unreadCounts}
            lastActive={lastActive}
            selectedConversationId={selectedConversationId}
            joinConversation={joinConversation}
            setIsCreatingGroup={setIsCreatingGroup}
            conversationLabel={conversationLabel}
            navigate={navigate}
            mutedConversations={mutedConversations}
            toggleMuteConversation={toggleMuteConversation}
            activeCallMap={activeCallMap}
            allUsers={allUsers}
          />

          {/* MAIN CHAT */}
          <section className="flex-1 min-w-0 h-full min-h-0 flex flex-col ss-surface backdrop-blur-xl border-x border-white/5 shadow-[0_24px_120px_-70px_rgba(0,0,0,0.85)]">
            {/* Header */}
            <header className="shrink-0 border-b border-white/10 bg-white/10 backdrop-blur-xl shadow-[0_18px_60px_-50px_rgba(0,0,0,0.75)]">
              <div className="h-16 px-5 flex items-center gap-3">
                <button
                  className="md:hidden inline-flex items-center justify-center h-11 w-11 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100 shadow-[0_12px_40px_-28px_rgba(0,0,0,0.85)]"
                  aria-label="Open sidebar"
                  onClick={() => setIsSidebarOpen(true)}
                >
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M4 6H20M4 12H20M4 18H20"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>

                <div className="min-w-0 flex-1">
                  <div className="text-lg font-semibold truncate text-white">
                    {conversationLabel(currentConversation)}
                  </div>
                  {isGroup && (
                    <div className="text-xs text-slate-300/80 truncate">
                      {currentConversation?.memberIds?.length
                        ? `${currentConversation.memberIds.length} member(s)`
                        : "Group"}
                    </div>
                  )}
                </div>

                {/* Call buttons (DMs and groups only, not global chat) */}
                {currentConversation && currentConversation.type !== "public" && (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => startCall(selectedConversationId, "voice")}
                      disabled={!!callState}
                      className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100 transition-all disabled:opacity-40 disabled:hover:bg-white/10"
                      title="Voice call"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
                      </svg>
                    </button>
                    <button
                      onClick={() => startCall(selectedConversationId, "video")}
                      disabled={!!callState}
                      className="inline-flex items-center justify-center h-9 w-9 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100 transition-all disabled:opacity-40 disabled:hover:bg-white/10"
                      title="Video call"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
                        <rect x="2" y="6" width="14" height="12" rx="2" />
                      </svg>
                    </button>
                  </div>
                )}

                <button
                  className="lg:hidden inline-flex items-center justify-center h-11 w-11 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100 shadow-[0_12px_40px_-28px_rgba(0,0,0,0.85)]"
                  aria-label="Open details"
                  onClick={() => {
                    setDetailsTab("details");
                    setIsDetailsOpen(true);
                  }}
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 8h.01M11 12h1v4h1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10Z" stroke="currentColor" strokeWidth="2" />
                  </svg>
                </button>
              </div>
            </header>

            {/* Join call banner — shows when someone else is in a call and the user is not */}
            {!callState && activeCallMap?.[selectedConversationId] && activeCallMap[selectedConversationId].participants?.length > 0 && (
              <div className="shrink-0 border-b border-green-500/20 bg-green-500/10 backdrop-blur-sm px-4 py-2.5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="relative flex h-2.5 w-2.5 shrink-0">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-400" />
                  </span>
                  <span className="text-sm text-green-200 truncate">
                    <span className="font-semibold text-green-100">
                      {activeCallMap[selectedConversationId].participants
                        .map((uid) => {
                          const u = allUsers?.find((x) => x.id === uid);
                          return u?.username || "Someone";
                        })
                        .join(", ")}
                    </span>
                    {" "}in {activeCallMap[selectedConversationId].type === "video" ? "video" : "voice"} call
                  </span>
                </div>
                <button
                  onClick={() => startCall(selectedConversationId, activeCallMap[selectedConversationId].type || "voice")}
                  className="shrink-0 px-4 py-1.5 rounded-lg bg-green-500/80 hover:bg-green-500 border border-green-400/40 text-white text-sm font-semibold transition-all shadow-[0_8px_24px_-12px_rgba(34,197,94,0.6)]"
                >
                  Join Call
                </button>
              </div>
            )}

            {/* Call bar + panel (Discord-style, inline between header and messages) */}
            {callState && (
              <ActiveCallOverlay
                callState={callState}
                localStream={localStream}
                screenStream={screenStream}
                remoteStreams={remoteStreams}
                remoteMediaState={remoteMediaState}
                streamUpdateTick={streamUpdateTick}
                onToggleMute={toggleMute}
                onToggleVideo={toggleVideo}
                onToggleScreenShare={toggleScreenShare}
                onLeaveCall={leaveCall}
                allUsers={allUsers}
                conversationLabel={conversationLabel(
                  conversations.find((c) => c.id === callState.conversationId)
                ).replace(/^DM: /, "")}
              />
            )}

            {/* Messages */}
            <MessageList
              currentMessages={currentMessages}
              currentUser={currentUser}
              allUsers={allUsers}
              decryptedMessages={decryptedMessages}
              selectedConversationId={selectedConversationId}
              replyToId={replyToId}
              setReplyToId={setReplyToId}
              onReplyToMessage={handleReplyToMessage}
              flashHighlightId={flashHighlightId}
              editingMessageId={editingMessageId}
              setEditingMessageId={setEditingMessageId}
              setInput={setInput}
              handleDeleteMessage={handleDeleteMessage}
              isLoadingOlder={isLoadingOlder}
              messagesEndRef={messagesEndRef}
              messagesContainerRef={messagesContainerRef}
              topSentinelRef={topSentinelRef}
              onContainerReady={handleContainerReady}
              setHasNewWhileScrolledUp={setHasNewWhileScrolledUp}
              setIsUserAtBottom={setIsUserAtBottom}
              scrollToBottom={scrollToBottom}
              jumpToLatest={jumpToLatest}
              jumpToMessage={jumpToMessage}
              isUserAtBottom={isUserAtBottom}
              hasNewWhileScrolledUp={hasNewWhileScrolledUp}
              scrollToMessage={scrollToMessage}
              onOpenImage={openImageViewer}
              gifFavoriteKeys={gifFavoriteKeys}
              onToggleGifFavorite={toggleGifFavorite}
              attachmentBlobUrls={attachmentBlobUrls}
              onReactToMessage={handleReactToMessage}
            />

            {/* Composer */}
            <MessageInput
              input={input}
              setInput={setInput}
              sendMessage={sendMessage}
              editingMessageId={editingMessageId}
              setEditingMessageId={setEditingMessageId}
              replyToId={replyToId}
              setReplyToId={setReplyToId}
              scrollToMessage={scrollToMessage}
              jumpToMessage={jumpToMessage}
              cancelEdit={cancelEdit}
              cancelReply={cancelReply}
              editTargetMsg={editTargetMsg}
              replyTargetMsg={replyTargetMsg}
              replyPreview={replyPreviewForInput}
              getSenderNameForMsg={getSenderNameForMsg}
              getPlaintextForMsg={getPlaintextForMsg}
              pendingImages={pendingImages}
              onAddImages={addImages}
              removePendingImage={removePendingImage}
              clearPendingImages={clearPendingImages}
              retryPendingUpload={retryPendingUpload}
              maxImageBytes={MAX_FILE_BYTES}
              formatBytes={formatBytes}
              onOpenGifPicker={openGifPicker}
              onOpenEmojiPicker={openEmojiPicker}
            />
          </section>

          {/* RIGHT DETAILS */}
          <aside className="hidden lg:flex h-full w-80 shrink-0 border-l border-white/10 ss-surface backdrop-blur-xl flex-col">
            <div className="h-16 px-4 border-b border-white/10 flex items-center">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setDetailsTab("details")}
                  className={[
                    "px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors",
                    detailsTab === "details"
                      ? "bg-white/10 border border-white/10 text-white"
                      : "text-slate-300 hover:text-white",
                  ].join(" ")}
                >
                  Details
                </button>
                <button
                  type="button"
                  onClick={() => setDetailsTab("media")}
                  className={[
                    "px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors",
                    detailsTab === "media"
                      ? "bg-white/10 border border-white/10 text-white"
                      : "text-slate-300 hover:text-white",
                  ].join(" ")}
                >
                  Media
                  {mediaItems.length > 0 && (
                    <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full bg-white/10 border border-white/10">
                      {mediaItems.length}
                    </span>
                  )}
                </button>
              </div>
            </div>

            {detailsTab === "details" ? (
              <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                <div className="rounded-xl glass-panel p-4">
                  <div className="text-xs text-slate-300/80">Conversation</div>
                  <div className="mt-1 font-semibold truncate text-white">{conversationLabel(currentConversation)}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {currentConversation?.type && (
                      <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/10 text-slate-100">
                        {currentConversation.type === "public" ? "Public" : currentConversation.type.toUpperCase()}
                      </span>
                    )}
                    {currentConversation && E2EE.isConversationE2EE(currentConversation) && (
                      <span className="text-xs px-2 py-0.5 rounded-full border border-[rgb(var(--ss-accent-rgb)/0.35)] bg-[rgb(var(--ss-accent-rgb)/0.10)] text-[rgb(var(--ss-accent-rgb))]">
                        E2EE
                      </span>
                    )}
                  </div>
                </div>

                {isGroup && (
                  <div className="rounded-xl glass-panel p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-xs text-slate-300/80">Members</div>
                        <div className="text-sm text-slate-100 mt-1">{conversationMembers.length}</div>
                      </div>

                      {isGroupMember && (
                        <button
                          onClick={() => setShowSettingsModal(true)}
                          className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100 transition-colors"
                        >
                          Group Settings
                        </button>
                      )}
                    </div>

                    <div className="mt-3 space-y-2">
                      {conversationMembers.map((u) => (
                        <div key={u.id} className="flex items-center justify-between gap-3 text-sm">
                          <div className="min-w-0 truncate">{u.username}</div>
                          {u.id === currentConversation.ownerId ? (
                            <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/10 text-slate-100">Owner</span>
                          ) : Array.isArray(currentConversation.adminIds) && currentConversation.adminIds.includes(u.id) ? (
                            <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/10 text-slate-100">Admin</span>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {!isGroup && currentConversation?.type === "dm" && (
                  <div className="rounded-xl glass-panel p-4">
                    <div className="text-xs text-slate-300/80">Direct message</div>
                    <div className="mt-2 text-sm text-slate-100">
                      {(() => {
                        const otherId = currentConversation.memberIds?.find((id) => id !== currentUser?.id);
                        const u = allUsers.find((x) => x.id === otherId);
                        return u ? `With ${u.username}` : "";
                      })()}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div
                ref={mediaScrollRef}
                onScroll={handleMediaScroll}
                className="flex-1 min-h-0 overflow-y-auto p-4"
              >
                {mediaItems.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
                    <div className="h-12 w-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-300">
                      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>
                    </div>
                    <div className="text-sm text-slate-200">No media yet</div>
                    <div className="text-xs text-slate-500">Shared images show up here.</div>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {mediaItems.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => openImageViewer(item)}
                        className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5"
                        title={item.name || "Image"}
                      >
                        <img
                          src={item.src}
                          alt={item.name || "Image"}
                          className="h-28 w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                          loading="lazy"
                          decoding="async"
                        />
                      </button>
                    ))}
                  </div>
                )}

                {isMediaLoading && (
                  <div className="flex justify-center py-4">
                    <div className="animate-spin h-5 w-5 border-2 border-[rgb(var(--ss-accent-rgb))] border-t-transparent rounded-full shadow-lg"></div>
                  </div>
                )}

                {!isMediaLoading && hasMoreMedia && (
                  <button
                    onClick={fetchMoreMedia}
                    className="mt-3 w-full py-2 text-xs text-center text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    Load older media
                  </button>
                )}
              </div>
            )}
          </aside>

          {/* DETAILS DRAWER (mobile/tablet) */}
          {isDetailsOpen && (
            <aside className="fixed inset-y-0 right-0 z-50 w-80 max-w-[90vw] border-l border-white/10 ss-surface flex flex-col backdrop-blur-2xl lg:hidden shadow-[0_24px_80px_-60px_rgba(0,0,0,0.85)]">
              <div className="h-16 px-4 border-b border-white/10 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setDetailsTab("details")}
                    className={[
                      "px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors",
                      detailsTab === "details"
                        ? "bg-white/10 border border-white/10 text-white"
                        : "text-slate-300 hover:text-white",
                    ].join(" ")}
                  >
                    Details
                  </button>
                  <button
                    type="button"
                    onClick={() => setDetailsTab("media")}
                    className={[
                      "px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors",
                      detailsTab === "media"
                        ? "bg-white/10 border border-white/10 text-white"
                        : "text-slate-300 hover:text-white",
                    ].join(" ")}
                  >
                    Media
                    {mediaItems.length > 0 && (
                      <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full bg-white/10 border border-white/10">
                        {mediaItems.length}
                      </span>
                    )}
                  </button>
                </div>
                <button
                  onClick={() => setIsDetailsOpen(false)}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-sm text-slate-100"
                >
                  Close
                </button>
              </div>

              {detailsTab === "details" ? (
                <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                  <div className="rounded-xl glass-panel p-4">
                    <div className="text-xs text-slate-300/80">Conversation</div>
                    <div className="mt-1 font-semibold truncate text-white">{conversationLabel(currentConversation)}</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {currentConversation?.type && (
                        <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/10 text-slate-100">
                          {currentConversation.type === "public" ? "Public" : currentConversation.type.toUpperCase()}
                        </span>
                      )}
                      {currentConversation && E2EE.isConversationE2EE(currentConversation) && (
                        <span className="text-xs px-2 py-0.5 rounded-full border border-[rgb(var(--ss-accent-rgb)/0.35)] bg-[rgb(var(--ss-accent-rgb)/0.10)] text-[rgb(var(--ss-accent-rgb))]">
                          E2EE
                        </span>
                      )}
                    </div>
                  </div>

                  {isGroupMember && (
                    <button
                      onClick={() => {
                        setShowSettingsModal(true);
                        setIsDetailsOpen(false);
                      }}
                      className="w-full px-4 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-sm text-slate-100"
                    >
                      Group Settings
                    </button>
                  )}

                  {isGroup && (
                    <div className="rounded-xl glass-panel p-4">
                      <div className="text-xs text-slate-300/80">Members</div>
                      <div className="mt-3 space-y-2">
                        {conversationMembers.map((u) => (
                          <div key={u.id} className="flex items-center justify-between gap-3 text-sm">
                            <div className="min-w-0 truncate">{u.username}</div>
                            {u.id === currentConversation.ownerId ? (
                              <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/10 text-slate-100">Owner</span>
                            ) : Array.isArray(currentConversation.adminIds) && currentConversation.adminIds.includes(u.id) ? (
                              <span className="text-xs px-2 py-0.5 rounded-full border border-white/10 bg-white/10 text-slate-100">Admin</span>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  ref={mediaScrollRef}
                  onScroll={handleMediaScroll}
                  className="flex-1 min-h-0 overflow-y-auto p-4"
                >
                  {mediaItems.length === 0 && !isMediaLoading ? (
                    <div className="h-full flex flex-col items-center justify-center gap-3 text-center">
                      <div className="h-12 w-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-300">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="4"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><path d="M21 15l-5-5L5 21"></path></svg>
                      </div>
                      <div className="text-sm text-slate-200">No media yet</div>
                      <div className="text-xs text-slate-500">Shared images show up here.</div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {mediaItems.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => openImageViewer(item)}
                          className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5"
                          title={item.name || "Image"}
                        >
                          <img
                            src={item.src}
                            alt={item.name || "Image"}
                            className="h-28 w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                            loading="lazy"
                            decoding="async"
                          />
                        </button>
                      ))}
                    </div>
                  )}

                  {isMediaLoading && (
                    <div className="flex justify-center py-4">
                      <div className="animate-spin h-5 w-5 border-2 border-[rgb(var(--ss-accent-rgb))] border-t-transparent rounded-full shadow-lg"></div>
                    </div>
                  )}

                  {!isMediaLoading && hasMoreMedia && (
                    <button
                      onClick={fetchMoreMedia}
                      className="mt-3 w-full py-2 text-xs text-center text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Load older media
                    </button>
                  )}
                </div>
              )}
            </aside>
          )}

        </div>

        <GifPicker
          isOpen={isGifPickerOpen}
          onClose={closeGifPicker}
          query={gifQuery}
          setQuery={setGifQuery}
          tab={gifTab}
          setTab={setGifTab}
          results={gifResults}
          favorites={gifFavorites}
          favoriteKeys={gifFavoriteKeys}
          onToggleFavorite={toggleGifFavorite}
          onSelectGif={handleSelectGif}
          isLoading={gifLoading}
          error={gifError}
          sendingKey={gifSendingKey}
        />

        <EmojiPicker
          isOpen={isEmojiPickerOpen}
          onClose={closeEmojiPicker}
          onSelectEmoji={handleSelectEmoji}
        />

        {activeImage && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
            <button
              type="button"
              aria-label="Close image viewer"
              onClick={closeImageViewer}
              className="absolute inset-0 bg-black/70"
            />
            <div className="relative w-full max-w-4xl max-h-[90vh] rounded-2xl bg-[#0c111d]/95 border border-white/12 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)] backdrop-blur-2xl overflow-hidden">
              <div className="h-12 px-4 border-b border-white/10 flex items-center justify-between">
                <div className="text-sm font-semibold text-white truncate">
                  {activeImage.name || "Image"}
                </div>
                <button
                  type="button"
                  onClick={closeImageViewer}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-sm text-slate-100"
                >
                  Close
                </button>
              </div>
              <div className="p-4 flex items-center justify-center bg-black/30">
                <img
                  src={activeImage.src}
                  alt={activeImage.name || "Image"}
                  className="max-h-[70vh] w-full object-contain"
                />
              </div>
              <div className="px-4 pb-4 text-xs text-slate-400 flex items-center justify-between">
                <span>
                  {activeImage.width && activeImage.height
                    ? `${activeImage.width} x ${activeImage.height}`
                    : ""}
                </span>
                <span>
                  {Number.isFinite(activeImage.size) ? formatBytes(activeImage.size) : ""}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* CREATE GROUP MODAL */}
        {isCreatingGroup && (
          <div className="fixed inset-0 z-[60] bg-black/60 flex items-center justify-center p-4">
            <div className="w-full max-w-lg rounded-2xl bg-[#0c111d]/95 border border-white/12 overflow-hidden shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)] backdrop-blur-2xl">
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">Create Group</h3>
                <button
                  onClick={cancelCreateGroup}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-sm text-slate-100"
                >
                  Close
                </button>
              </div>

              <div className="p-6 max-h-[75vh] overflow-y-auto">
                <input
                  placeholder="Group name"
                  value={groupName}
                  onChange={(e) => setGroupName(e.target.value)}
                  className="w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)]"
                />

                <div className="mt-4 text-xs text-slate-400">
                  Select members ({groupMemberIds.length} selected)
                </div>

                <div className="mt-3 max-h-56 overflow-y-auto space-y-2 pr-1">
                  {allUsers
                    .filter((u) => u.id !== currentUser?.id)
                    .map((u) => (
                      <label
                        key={u.id}
                        className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100"
                      >
                        <input
                          type="checkbox"
                          checked={groupMemberIds.includes(u.id)}
                          onChange={() => toggleUserInNewGroup(u.id)}
                          style={{ accentColor: "rgb(var(--ss-accent-rgb))" }} />
                        <span className="truncate">{u.username}</span>
                      </label>
                    ))}
                </div>

                <div className="mt-5 flex justify-end gap-2">
                  <button
                    onClick={cancelCreateGroup}
                    className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-sm text-slate-100"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={submitCreateGroup}
                    className="px-4 py-2 rounded-xl pill-accent text-sm font-semibold hover:brightness-110 active:scale-95"
                  >
                    Create
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* MANAGE GROUP MODAL */}
        {showSettingsModal && isGroup && (
          <div className="fixed inset-0 z-[60] bg-black/70 flex items-center justify-center p-4">
            <div className="w-full max-w-3xl rounded-2xl bg-[#0c111d]/95 border border-white/12 overflow-hidden shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)] backdrop-blur-2xl">
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                <h3 className="text-lg font-semibold text-white">Group Settings</h3>
                <button
                  onClick={() => setShowSettingsModal(false)}
                  className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-sm text-slate-100"
                >
                  Close
                </button>
              </div>

              <div className="p-6 max-h-[80vh] overflow-y-auto space-y-5">
                <div className="text-sm text-slate-200 mb-3 space-y-1">
                  <div>
                    <span className="text-slate-400">Owner:</span>{" "}
                    <span className="font-semibold">{ownerUser?.username || "Unknown"}</span>
                  </div>
                  {adminUsers.length > 0 && (
                    <div className="mt-1">
                      <span className="text-slate-400">Admins:</span>{" "}
                      <span className="font-semibold">
                        {adminUsers.map((a) => a.username).join(", ")}
                      </span>
                    </div>
                  )}
                </div>

                <input
                  placeholder="Search users"
                  value={manageSearchTerm}
                  onChange={(e) => setManageSearchTerm(e.target.value)}
                  className="w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)]"
                />

                <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Members */}
                  <div className="rounded-xl glass-panel p-4">
                    <h4 className="text-sm font-semibold mb-3">Members</h4>

                    <ul className="space-y-2">
                      {conversationMembers.map((u) => {
                        const isOwner = u.id === currentConversation.ownerId;
                        const isAdmin =
                          Array.isArray(currentConversation.adminIds) &&
                          currentConversation.adminIds.includes(u.id);

                        return (
                          <li
                            key={u.id}
                            className="flex items-center justify-between gap-3 text-sm"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-medium">{u.username}</div>
                              <div className="text-xs text-slate-400">
                                {isOwner ? "Owner" : isAdmin ? "Admin" : "Member"}
                                {u.id === currentUser?.id ? " (You)" : ""}
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
                              {/* Owner-only admin management */}
                              {isGroupOwner && !isOwner && (
                                <>
                                  {isAdmin ? (
                                    <button
                                      onClick={() => demoteAdmin(u.id)}
                                      className="text-xs px-2 py-1 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
                                    >
                                      Demote
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => promoteToAdmin(u.id)}
                                      className="text-xs px-2 py-1 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
                                    >
                                      Make Admin
                                    </button>
                                  )}
                                </>
                              )}

                              {/* Owner/admin can remove others (not owner, not self) */}
                              {canManageGroupMembers && !isOwner && u.id !== currentUser?.id && (
                                <button
                                  onClick={() => removeUserFromCurrentGroup(u.id)}
                                  className="text-xs px-2 py-1 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  {/* Add users */}
                  <div className="rounded-xl glass-panel p-4">
                    <h4 className="text-sm font-semibold mb-3">Add Users</h4>

                    {!canManageGroupMembers ? (
                      <div className="text-sm text-slate-300/80">
                        Only the owner/admins can add members.
                      </div>
                    ) : (
                      <ul className="space-y-2">
                        {filteredAddableUsers.map((u) => (
                          <li
                            key={u.id}
                            className="flex items-center justify-between gap-3 text-sm"
                          >
                            <span className="truncate">{u.username}</span>
                            <button
                              onClick={() => addUserToCurrentGroup(u.id)}
                              className="text-xs px-2 py-1 rounded-lg pill-accent text-slate-900 font-semibold hover:brightness-110 active:scale-95"
                            >
                              Add
                            </button>
                          </li>
                        ))}

                        {filteredAddableUsers.length === 0 && (
                          <div className="text-sm text-slate-500">No users to add.</div>
                        )}
                      </ul>
                    )}
                  </div>

                </div>

                {/* Transfer ownership (owner only) */}
                {isGroupOwner && (
                  <div className="mt-5 rounded-xl glass-panel p-4 space-y-3">
                    <h4 className="text-sm font-semibold">Transfer Ownership</h4>
                    <div className="flex flex-col md:flex-row gap-2">
                      <select
                        value={transferOwnerId}
                        onChange={(e) => setTransferOwnerId(e.target.value)}
                        className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)]"
                      >
                        <option value="" className="bg-white text-slate-900">
                          Select new owner
                        </option>
                        {(currentConversation.memberIds || [])
                          .filter((id) => id !== currentConversation.ownerId)
                          .map((id) => allUsers.find((u) => u.id === id))
                          .filter(Boolean)
                          .map((u) => (
                            <option key={u.id} value={u.id} className="bg-white text-slate-900">
                              {u.username}
                            </option>
                          ))}
                      </select>

                      <button
                        onClick={() => transferOwnership(transferOwnerId)}
                        disabled={!transferOwnerId}
                        className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-sm disabled:opacity-40 disabled:hover:bg-white/10 text-slate-100"
                      >
                        Transfer
                      </button>
                    </div>

                    <div className="text-xs text-slate-400">
                      Owners cannot leave until ownership is transferred or the group is disbanded.
                    </div>
                  </div>
                )}

                {/* Leave group (any member except owner) */}
                {isGroupMember && !isGroupOwner && (
                  <div className="mt-5 rounded-xl glass-panel p-4">
                    <button
                      onClick={leaveCurrentGroup}
                      className="w-full px-4 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-sm font-semibold text-slate-100"
                    >
                      Leave Group
                    </button>
                  </div>
                )}

                {/* Disband (owner only) */}
                {isGroupOwner && (
                  <button
                    className="mt-3 w-full px-4 py-2 rounded-xl bg-red-600/30 hover:bg-red-600/40 border border-red-500/40 text-red-100 text-sm font-semibold shadow-[0_16px_60px_-40px_rgba(0,0,0,0.7)]"
                    onClick={async () => {
                      const token = getToken();
                      if (!token) return;

                      await fetch(`${API_BASE}/api/conversations/${currentConversation.id}`, {
                        method: "DELETE",
                        headers: { Authorization: `Bearer ${token}` },
                      });
                      setShowSettingsModal(false);
                    }}
                  >
                    Disband Group
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

      {/* ---- Call overlays ---- */}
      {incomingCall && (
        <IncomingCallModal
          incomingCall={incomingCall}
          onAccept={acceptCall}
          onReject={rejectCall}
          allUsers={allUsers}
        />
      )}

      </div>
    </div>
  );
}
