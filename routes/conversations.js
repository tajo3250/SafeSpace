// routes/conversations.js — DMs, groups, membership, admins, ownership, disband, message delete, E2EE group keys

const express = require("express");
const path = require("path");
const fs = require("fs");

const {
  users,
  conversations,
  saveConversations,
  ensureGlobalConversation,
  getOrCreateDmConversation,
  isGroupManager, // kept for compatibility, but we enforce permissions locally too
} = require("../data/store");
const { getUserFromRequest } = require("../utils/auth");

const UPLOAD_DIR = path.join(__dirname, "..", "uploads");

const router = express.Router();

function canManage(conv, userId) {
  if (!conv || !userId) return false;
  if (conv.ownerId === userId) return true;
  return Array.isArray(conv.adminIds) && conv.adminIds.includes(userId);
}


// Normalize group key history storage so old messages remain decryptable across domains.
// This stores per-version encrypted group keys on the server (ciphertext-only).
function normalizeGroupKeyHistory(conv) {
  if (!conv || conv.type !== "group") return;

  if (typeof conv.keyVersion !== "number") conv.keyVersion = 0;

  if (!conv.encryptedKeys || typeof conv.encryptedKeys !== "object") {
    conv.encryptedKeys = {};
  }

  if (!conv.encryptedKeysByVersion || typeof conv.encryptedKeysByVersion !== "object") {
    conv.encryptedKeysByVersion = {};
  }

  // Membership snapshots for each key epoch (best-effort). Used to decide which historical
  // key versions a re-joined member should be able to decrypt.
  if (!conv.memberIdsByVersion || typeof conv.memberIdsByVersion !== "object") {
    conv.memberIdsByVersion = {};
  }

  const kv = conv.keyVersion;
  if (kv >= 1) {
    // Ensure current version exists in history
    if (!conv.encryptedKeysByVersion[kv] || typeof conv.encryptedKeysByVersion[kv] !== "object") {
      // IMPORTANT:
      // Never store a live reference to conv.encryptedKeys in history.
      // Membership changes (delete/add) would mutate past epochs and make old messages undecryptable
      // after domain switches.
      conv.encryptedKeysByVersion[kv] = {
        ...(conv.encryptedKeys && typeof conv.encryptedKeys === "object" ? conv.encryptedKeys : {}),
      };
    } else if (conv.encryptedKeysByVersion[kv] === conv.encryptedKeys) {
      // Break accidental reference equality from older saved data.
      conv.encryptedKeysByVersion[kv] = { ...conv.encryptedKeysByVersion[kv] };
    }

    // Create the epoch membership snapshot if missing.
    // IMPORTANT: we only set if missing to avoid rewriting history.
    if (!Array.isArray(conv.memberIdsByVersion[kv])) {
      conv.memberIdsByVersion[kv] = Array.isArray(conv.memberIds) ? [...conv.memberIds] : [];
    }
  }
}

// Helper to build safe conversation payload
function buildSafeConversation(conv) {
  // Ensure group key history is present for safe transport to clients
  normalizeGroupKeyHistory(conv);

  return {
    id: conv.id,
    type: conv.type,
    name: conv.name,
    memberIds: Array.isArray(conv.memberIds) ? conv.memberIds : [],
    ownerId: conv.ownerId || null,
    adminIds: Array.isArray(conv.adminIds) ? conv.adminIds : [],
    createdAt: conv.createdAt,
    // E2EE: client-managed encrypted group keys and version
    encryptedKeys: conv && typeof conv.encryptedKeys === "object" ? conv.encryptedKeys : {},
    keyVersion: typeof conv.keyVersion === "number" ? conv.keyVersion : 0,
    // E2EE: server stores ciphertext-only key history by version so clients can
    // decrypt old messages after key rotations even across domain changes.
    encryptedKeysByVersion:
      conv && typeof conv.encryptedKeysByVersion === "object" ? conv.encryptedKeysByVersion : {},
    memberIdsByVersion:
      conv && typeof conv.memberIdsByVersion === "object" ? conv.memberIdsByVersion : {},
  };
}

// Get all conversations for current user
router.get("/api/conversations", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  ensureGlobalConversation();

  if (!Array.isArray(conversations)) {
    conversations.length = 0;
    saveConversations();
    ensureGlobalConversation();
  }

  const visible = conversations.filter((c) => {
    if (c.type === "public") return true;
    return Array.isArray(c.memberIds) && c.memberIds.includes(user.id);
  });

  res.json(visible.map(buildSafeConversation));
});

// Start DM by username (verified users only)
router.post("/api/conversations/dm", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const { targetUsername } = req.body || {};
  if (!targetUsername)
    return res.status(400).json({ message: "targetUsername required" });

  const target = users.find(
    (u) =>
      (u.username || "").toLowerCase() ===
      String(targetUsername).toLowerCase()
  );
  if (!target || target.verified !== true)
    return res.status(404).json({ message: "User not found" });

  if (target.id === user.id)
    return res.status(400).json({ message: "Cannot DM yourself" });

  const conv = getOrCreateDmConversation(user.id, target.id);
  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    for (const memberId of safeConv.memberIds) {
      io.to(`user:${memberId}`).emit("conversation:created", safeConv);
    }
  }

  res.json(safeConv);
});

// Create group (verified users only)
router.post("/api/conversations/group", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const { name, memberEmails, memberIds, encryptedKeys, keyVersion } =
    req.body || {};

  if (!name || !name.trim())
    return res.status(400).json({ message: "Group name required" });

  const memberIdSet = new Set([user.id]);

  if (Array.isArray(memberIds)) {
    for (const id of memberIds) {
      const u = users.find((usr) => usr.id === id && usr.verified === true);
      if (u) memberIdSet.add(u.id);
    }
  }

  if (Array.isArray(memberEmails)) {
    for (const emailRaw of memberEmails) {
      const email = String(emailRaw || "").toLowerCase();
      if (!email) continue;
      const u = users.find(
        (usr) =>
          (usr.email || "").toLowerCase() === email && usr.verified === true
      );
      if (u) memberIdSet.add(u.id);
    }
  }

  const conv = {
    id: `group-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
    type: "group",
    name: name.trim(),
    ownerId: user.id,
    adminIds: [user.id],
    memberIds: Array.from(memberIdSet),
    messages: [],
    createdAt: new Date().toISOString(),
    // E2EE group keys (client-managed, server-blind)
    encryptedKeys:
      encryptedKeys && typeof encryptedKeys === "object" ? encryptedKeys : {},
    keyVersion: typeof keyVersion === "number" ? keyVersion : 0,
    // E2EE key history (ciphertext-only)
    encryptedKeysByVersion:
      typeof keyVersion === "number" && keyVersion >= 1 && encryptedKeys && typeof encryptedKeys === "object"
        ? { [keyVersion]: { ...encryptedKeys } }
        : {},
    memberIdsByVersion:
      typeof keyVersion === "number" && keyVersion >= 1
        ? { [keyVersion]: Array.from(memberIdSet) }
        : {},
  };

  conversations.push(conv);
  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    for (const memberId of safeConv.memberIds) {
      io.to(`user:${memberId}`).emit("conversation:created", safeConv);
    }
  }

  res.json(safeConv);
});

// Add member to a group (owner/admin only)
// IMPORTANT: supports immediate key delivery in the SAME request.
// Body may include:
// - userId / userEmail
// - encryptedKeyForNewMember: object (AES-GCM payload + from)
router.post("/api/conversations/:id/add-member", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (!canManage(conv, user.id) && !(isGroupManager && isGroupManager(conv, user.id))) {
    return res.status(403).json({ message: "You are not allowed to modify this group" });
  }

  const { userId, userEmail, encryptedKeyForNewMember, encryptedKeysForNewMemberByVersion } = req.body || {};
  if (!userId && !userEmail)
    return res.status(400).json({ message: "userId or userEmail required" });

  let target = null;

  if (userId) {
    target = users.find((u) => u.id === userId);
  } else if (userEmail) {
    const emailLower = String(userEmail).toLowerCase();
    target = users.find((u) => (u.email || "").toLowerCase() === emailLower);
  }

  if (!target || target.verified !== true)
    return res.status(404).json({ message: "Target user not found" });

  if (!Array.isArray(conv.memberIds)) conv.memberIds = [];
  const wasMember = conv.memberIds.includes(target.id);

  if (!wasMember) conv.memberIds.push(target.id);

  // E2EE: store encrypted key blob(s) for the new member (if provided)
  // Supports:
  // - encryptedKeyForNewMember (current epoch)
  // - encryptedKeysForNewMemberByVersion (map of version -> blob)
  const hasCurrentKeyBlob = encryptedKeyForNewMember && typeof encryptedKeyForNewMember === "object";
  const hasVersionedKeyBlobs =
    encryptedKeysForNewMemberByVersion && typeof encryptedKeysForNewMemberByVersion === "object";

  if (hasCurrentKeyBlob || hasVersionedKeyBlobs) {
    if (!conv.encryptedKeys || typeof conv.encryptedKeys !== "object") {
      conv.encryptedKeys = {};
    }

    // Keep history so older messages remain decryptable for new members
    normalizeGroupKeyHistory(conv);
    const kv = typeof conv.keyVersion === "number" ? conv.keyVersion : 0;

    // Ensure membership snapshot for the current epoch includes the new member
    if (kv >= 1) {
      if (!conv.memberIdsByVersion || typeof conv.memberIdsByVersion !== "object") {
        conv.memberIdsByVersion = {};
      }
      if (!Array.isArray(conv.memberIdsByVersion[kv])) {
        conv.memberIdsByVersion[kv] = Array.isArray(conv.memberIds) ? [...conv.memberIds] : [];
      }
      if (!conv.memberIdsByVersion[kv].includes(target.id)) {
        conv.memberIdsByVersion[kv].push(target.id);
      }
    }

    // Store per-version blobs first (lets the new member decrypt older history immediately)
    if (hasVersionedKeyBlobs && kv >= 1) {
      for (const [vStr, blob] of Object.entries(encryptedKeysForNewMemberByVersion)) {
        const v = Number(vStr);
        if (!Number.isFinite(v) || v < 1 || v > kv) continue;
        if (!blob || typeof blob !== "object") continue;

        if (!conv.encryptedKeysByVersion[v] || typeof conv.encryptedKeysByVersion[v] !== "object") {
          conv.encryptedKeysByVersion[v] = {};
        }
        conv.encryptedKeysByVersion[v][target.id] = blob;

        // If we're giving access to this epoch, record it in the snapshot too (best-effort)
        if (!conv.memberIdsByVersion || typeof conv.memberIdsByVersion !== "object") {
          conv.memberIdsByVersion = {};
        }
        if (!Array.isArray(conv.memberIdsByVersion[v])) {
          conv.memberIdsByVersion[v] = [];
        }
        if (!conv.memberIdsByVersion[v].includes(target.id)) {
          conv.memberIdsByVersion[v].push(target.id);
        }

        if (v === kv) {
          conv.encryptedKeys[target.id] = blob;
        }
      }
    }

    // Back-compat: if only the current key blob is provided, also store it under current keyVersion
    if (hasCurrentKeyBlob) {
      conv.encryptedKeys[target.id] = encryptedKeyForNewMember;

      if (kv >= 1) {
        if (!conv.encryptedKeysByVersion[kv] || typeof conv.encryptedKeysByVersion[kv] !== "object") {
          conv.encryptedKeysByVersion[kv] = {};
        }
        conv.encryptedKeysByVersion[kv][target.id] = encryptedKeyForNewMember;

        if (!conv.memberIdsByVersion || typeof conv.memberIdsByVersion !== "object") {
          conv.memberIdsByVersion = {};
        }
        if (!Array.isArray(conv.memberIdsByVersion[kv])) {
          conv.memberIdsByVersion[kv] = [];
        }
        if (!conv.memberIdsByVersion[kv].includes(target.id)) {
          conv.memberIdsByVersion[kv].push(target.id);
        }
      }
    }
  }

  // CRITICAL: do NOT change keyVersion on add-member.

  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);

    io.to(`user:${target.id}`).emit("conversation:created", safeConv);


    const kv = typeof safeConv.keyVersion === "number" ? safeConv.keyVersion : 0;
    const deliveredKey =
      encryptedKeysForNewMemberByVersion &&
        typeof encryptedKeysForNewMemberByVersion === "object" &&
        kv >= 1 &&
        encryptedKeysForNewMemberByVersion[String(kv)] &&
        typeof encryptedKeysForNewMemberByVersion[String(kv)] === "object"
        ? encryptedKeysForNewMemberByVersion[String(kv)]
        : encryptedKeyForNewMember;

    if (deliveredKey && typeof deliveredKey === "object") {
      io.to(`user:${target.id}`).emit("group:keys_delivered", {
        conversationId: conv.id,
        encryptedKey: deliveredKey,
        keyVersion: safeConv.keyVersion,
      });
    }

    io.to(`user:${target.id}`).emit("group:join_room", {
      conversationId: conv.id,
    });

    // SYSTEM MESSAGE
    const sysMsg = {
      id: "sys-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      text: `${user.username} added ${target.username} to the group.`,
      senderId: "system",
      senderName: "System",
      createdAt: new Date().toISOString(),
      conversationId: conv.id,
      type: "system",
    };
    if (!Array.isArray(conv.messages)) conv.messages = [];
    conv.messages.push(sysMsg);
    saveConversations();
    io.to(conv.id).emit("chat:message", sysMsg);
  }

  res.json(safeConv);
});


// Backfill/Upsert encrypted group key history for a specific key version (ciphertext-only).
// This is used to keep old messages decryptable across domain changes even after rotations.
// Only owner/admins can upsert history to reduce poisoning risk.
// Body: { version: number, encryptedKeys: object }
router.post("/api/conversations/:id/key-history/upsert", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group") {
    return res.status(404).json({ message: "Group not found" });
  }

  if (!canManage(conv, user.id) && !(isGroupManager && isGroupManager(conv, user.id))) {
    return res.status(403).json({ message: "You are not allowed to modify this group" });
  }

  const { version, encryptedKeys } = req.body || {};
  if (typeof version !== "number" || !Number.isFinite(version) || version < 1) {
    return res.status(400).json({ message: "version must be a number >= 1" });
  }
  if (!encryptedKeys || typeof encryptedKeys !== "object") {
    return res.status(400).json({ message: "encryptedKeys object required" });
  }

  normalizeGroupKeyHistory(conv);

  // Do not allow writing versions newer than current keyVersion (prevents weird future epochs)
  const currentKV = typeof conv.keyVersion === "number" ? conv.keyVersion : 0;
  if (version > currentKV) {
    return res.status(400).json({ message: "Cannot upsert a version newer than current keyVersion" });
  }

  if (!conv.encryptedKeysByVersion || typeof conv.encryptedKeysByVersion !== "object") {
    conv.encryptedKeysByVersion = {};
  }

  // Only set if missing to avoid accidental overwrites
  if (!conv.encryptedKeysByVersion[version]) {
    conv.encryptedKeysByVersion[version] = { ...encryptedKeys };
    if (version === currentKV) {
      conv.encryptedKeys = { ...encryptedKeys };
    }
    saveConversations();
  }

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
  }

  res.json(safeConv);
});


// Patch encrypted key history for a single user across specific historical versions.
// Used when a member is removed (rotation) and later re-joined, and their per-version
// key envelopes were missing (e.g. due to earlier bugs or domain changes).
// Only owner/admins can patch to reduce poisoning risk.
// Body: { userId: string, versions: { [version:number]: encryptedKeyBlob } }
router.post("/api/conversations/:id/key-history/patch-user", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group") {
    return res.status(404).json({ message: "Group not found" });
  }

  if (!canManage(conv, user.id) && !(isGroupManager && isGroupManager(conv, user.id))) {
    return res.status(403).json({ message: "You are not allowed to modify this group" });
  }

  const { userId, versions } = req.body || {};
  if (!userId) return res.status(400).json({ message: "userId required" });
  if (!versions || typeof versions !== "object") {
    return res.status(400).json({ message: "versions object required" });
  }

  normalizeGroupKeyHistory(conv);
  const currentKV = typeof conv.keyVersion === "number" ? conv.keyVersion : 0;

  let wrote = false;
  for (const [vStr, blob] of Object.entries(versions)) {
    const v = Number(vStr);
    if (!Number.isFinite(v) || v < 1 || v > currentKV) continue;
    if (!blob || typeof blob !== "object") continue;

    if (!conv.encryptedKeysByVersion[v] || typeof conv.encryptedKeysByVersion[v] !== "object") {
      conv.encryptedKeysByVersion[v] = {};
    }
    if (!conv.encryptedKeysByVersion[v][userId]) {
      conv.encryptedKeysByVersion[v][userId] = blob;
      wrote = true;
    }
  }

  if (wrote) saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io && wrote) {
    io.to(conv.id).emit("conversation:update", safeConv);
  }

  res.json(safeConv);
});


// Remove member from a group (owner/admin only)
// Supports atomic E2EE key rotation in the SAME request.
// Body may include:
// - userId (required)
// - rotatedEncryptedKeys: object (map userId->encryptedKeyBlob for remaining members)
// - rotatedKeyVersion: number
router.post("/api/conversations/:id/remove-member", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (!canManage(conv, user.id) && !(isGroupManager && isGroupManager(conv, user.id))) {
    return res.status(403).json({ message: "You are not allowed to modify this group" });
  }

  const { userId, rotatedEncryptedKeys, rotatedKeyVersion } = req.body || {};
  if (!userId) return res.status(400).json({ message: "userId required" });

  if (!Array.isArray(conv.memberIds)) conv.memberIds = [];

  // E2EE: snapshot current epoch into history BEFORE we mutate encryptedKeys.
  // This is required so a user who is removed (and later re-added) can still decrypt
  // messages from the epochs when they were previously a member.
  normalizeGroupKeyHistory(conv);

  if (userId === conv.ownerId) {
    return res.status(400).json({ message: "You cannot remove the group creator" });
  }

  conv.memberIds = conv.memberIds.filter((id) => id !== userId);

  if (Array.isArray(conv.adminIds)) {
    conv.adminIds = conv.adminIds.filter((id) => id !== userId);
  }

  if (conv.encryptedKeys && typeof conv.encryptedKeys === "object") {
    // Remove from CURRENT epoch map only. Do NOT remove from encryptedKeysByVersion history.
    delete conv.encryptedKeys[userId];
  }

  // E2EE rotation applied ONLY if rotatedEncryptedKeys is provided
  if (rotatedEncryptedKeys && typeof rotatedEncryptedKeys === "object") {
    // Remove the removed user from the rotated map if present
    let rotatedMap = rotatedEncryptedKeys;
    if (rotatedEncryptedKeys[userId]) {
      const copy = { ...rotatedEncryptedKeys };
      delete copy[userId];
      rotatedMap = copy;
    }

    // Determine next key version
    const nextVersion =
      typeof rotatedKeyVersion === "number"
        ? rotatedKeyVersion
        : (typeof conv.keyVersion === "number" ? conv.keyVersion : 0) + 1;

    conv.keyVersion = nextVersion;
    conv.encryptedKeys = rotatedMap;

    if (!conv.encryptedKeysByVersion || typeof conv.encryptedKeysByVersion !== "object") {
      conv.encryptedKeysByVersion = {};
    }
    conv.encryptedKeysByVersion[nextVersion] = { ...rotatedMap };

    if (!conv.memberIdsByVersion || typeof conv.memberIdsByVersion !== "object") {
      conv.memberIdsByVersion = {};
    }
    // Snapshot the new epoch membership (post-removal).
    if (!Array.isArray(conv.memberIdsByVersion[nextVersion])) {
      conv.memberIdsByVersion[nextVersion] = Array.isArray(conv.memberIds) ? [...conv.memberIds] : [];
    }
  } else {
    // Even without a rotation payload, keep history consistent for current version
    normalizeGroupKeyHistory(conv);
    const kv = typeof conv.keyVersion === "number" ? conv.keyVersion : 0;
    if (kv >= 1) {
      if (!conv.encryptedKeysByVersion[kv] || typeof conv.encryptedKeysByVersion[kv] !== "object") {
        conv.encryptedKeysByVersion[kv] = conv.encryptedKeys || {};
      }
      // Do NOT delete from history.
    }
  }

  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
    io.to(`user:${userId}`).emit("conversation:removed", { id: conv.id });

    // SYSTEM MESSAGE
    let removedUserName = "a member";
    const removedUser = users.find(u => u.id === userId);
    if (removedUser) {
      removedUserName = removedUser.username;
    }

    const sysMsg = {
      id: "sys-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      text: `${user.username} removed ${removedUserName} from the group.`,
      senderId: "system",
      senderName: "System",
      createdAt: new Date().toISOString(),
      conversationId: conv.id,
      type: "system",
    };
    if (!Array.isArray(conv.messages)) conv.messages = [];
    conv.messages.push(sysMsg);
    saveConversations();
    io.to(conv.id).emit("chat:message", sysMsg);
  }

  res.json(safeConv);
});

// Leave group (any member; owner must transfer ownership first)
router.post("/api/conversations/:id/leave", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (!Array.isArray(conv.memberIds) || !conv.memberIds.includes(user.id)) {
    return res.status(400).json({ message: "You are not a member of this group" });
  }

  if (conv.ownerId === user.id) {
    return res.status(400).json({
      message: "Transfer ownership to another member before leaving this group",
    });
  }

  conv.memberIds = conv.memberIds.filter((id) => id !== user.id);

  if (Array.isArray(conv.adminIds)) {
    conv.adminIds = conv.adminIds.filter((id) => id !== user.id);
  }

  // Snapshot current epoch into history before we mutate encryptedKeys.
  normalizeGroupKeyHistory(conv);

  if (conv.encryptedKeys && typeof conv.encryptedKeys === "object") {
    // Remove from CURRENT epoch map only. Do NOT remove from encryptedKeysByVersion history.
    delete conv.encryptedKeys[user.id];
  }

  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
    io.to(`user:${user.id}`).emit("conversation:removed", { id: conv.id });

    // SYSTEM MESSAGE
    const sysMsg = {
      id: "sys-" + Date.now() + "-" + Math.random().toString(36).slice(2),
      text: `${user.username} left the group.`,
      senderId: "system",
      senderName: "System",
      createdAt: new Date().toISOString(),
      conversationId: conv.id,
      type: "system",
    };
    if (!Array.isArray(conv.messages)) conv.messages = [];
    conv.messages.push(sysMsg);
    saveConversations();
    io.to(conv.id).emit("chat:message", sysMsg);
  }

  res.json(safeConv);
});

// Get message history (for lazy loading media/search without socket state)
router.get("/api/conversations/:id/messages", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const beforeId = req.query.beforeId;

  const conv = conversations.find((c) => c.id === convId);
  if (!conv) return res.status(404).json({ message: "Conversation not found" });

  // Access control
  if (
    conv.type !== "public" &&
    (!Array.isArray(conv.memberIds) || !conv.memberIds.includes(user.id))
  ) {
    return res.status(403).json({ message: "Access denied" });
  }

  let messages = Array.isArray(conv.messages) ? conv.messages : [];

  if (beforeId) {
    const idx = messages.findIndex((m) => m.id === beforeId);
    if (idx !== -1) {
      // slice before this index (get [idx-limit, idx])
      const start = Math.max(0, idx - limit);
      messages = messages.slice(start, idx);
    } else {
      messages = [];
    }
  } else {
    // latest
    const start = Math.max(0, messages.length - limit);
    messages = messages.slice(start);
  }

  res.json(messages);
});

// Promote a member to admin (owner only)
router.post("/api/conversations/:id/promote-admin", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (conv.ownerId !== user.id) {
    return res.status(403).json({ message: "Only the group creator can manage admins" });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ message: "userId required" });

  if (!Array.isArray(conv.memberIds)) conv.memberIds = [];
  if (!conv.memberIds.includes(userId)) {
    return res.status(400).json({ message: "User must be a member before becoming an admin" });
  }

  if (!Array.isArray(conv.adminIds)) conv.adminIds = [];
  if (!conv.adminIds.includes(userId)) {
    conv.adminIds.push(userId);
    saveConversations();
  }

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) io.to(conv.id).emit("conversation:update", safeConv);

  res.json(safeConv);
});

// Demote an admin back to member (owner only)
router.post("/api/conversations/:id/demote-admin", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (conv.ownerId !== user.id) {
    return res.status(403).json({ message: "Only the group creator can manage admins" });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ message: "userId required" });

  if (userId === conv.ownerId) {
    return res.status(400).json({ message: "You cannot demote the group creator" });
  }

  if (!Array.isArray(conv.adminIds)) conv.adminIds = [];
  conv.adminIds = conv.adminIds.filter((id) => id !== userId);
  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) io.to(conv.id).emit("conversation:update", safeConv);

  res.json(safeConv);
});

// Transfer ownership to another member (owner only)
router.post("/api/conversations/:id/transfer-ownership", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (conv.ownerId !== user.id) {
    return res.status(403).json({ message: "Only the group creator can transfer ownership" });
  }

  const { newOwnerId } = req.body || {};
  if (!newOwnerId) return res.status(400).json({ message: "newOwnerId required" });

  if (!Array.isArray(conv.memberIds) || !conv.memberIds.includes(newOwnerId)) {
    return res.status(400).json({ message: "New owner must be a member of this group" });
  }

  const oldOwnerId = conv.ownerId;
  conv.ownerId = newOwnerId;

  if (!Array.isArray(conv.adminIds)) conv.adminIds = [];
  if (!conv.adminIds.includes(newOwnerId)) conv.adminIds.push(newOwnerId);

  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
    io.to(conv.id).emit("group:ownership_transferred", {
      conversationId: conv.id,
      oldOwnerId,
      newOwnerId,
      transferredBy: user.id,
    });
  }

  res.json(safeConv);
});

// Disband (delete) a group (owner only)
router.get("/api/conversations/:id/my-group-key", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group") {
    return res.status(404).json({ message: "Group not found" });
  }

  // Must be a member
  if (!Array.isArray(conv.memberIds) || !conv.memberIds.includes(user.id)) {
    return res.status(403).json({ message: "You are not a member of this group" });
  }

  const version = parseInt(req.query.version);
  const requestedVersion = Number.isFinite(version) ? version : conv.keyVersion;

  // 1. Try fetching from history first (most reliable for versioned keys)
  let encryptedKey = null;

  if (
    conv.encryptedKeysByVersion &&
    typeof conv.encryptedKeysByVersion === "object" &&
    conv.encryptedKeysByVersion[requestedVersion] &&
    typeof conv.encryptedKeysByVersion[requestedVersion] === "object"
  ) {
    encryptedKey = conv.encryptedKeysByVersion[requestedVersion][user.id];
  }

  // 2. Fallback to current keys if version matches current
  if (!encryptedKey && requestedVersion === conv.keyVersion) {
    if (conv.encryptedKeys && typeof conv.encryptedKeys === "object") {
      encryptedKey = conv.encryptedKeys[user.id];
    }
  }

  if (!encryptedKey) {
    return res.status(404).json({ message: "Key not found for your user in this group/version." });
  }

  res.json({ encryptedKey });
});

// Disband (delete) a group (owner only)
router.delete("/api/conversations/:id", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const idx = conversations.findIndex((c) => c.id === convId);
  if (idx === -1 || conversations[idx].type !== "group")
    return res.status(404).json({ message: "Group not found" });

  const conv = conversations[idx];

  if (conv.ownerId !== user.id) {
    return res.status(403).json({ message: "Only the group creator can disband this group" });
  }

  // Clean up uploaded files from all messages before removing conversation
  if (Array.isArray(conv.messages)) {
    const uploadsDirResolved = path.resolve(UPLOAD_DIR) + path.sep;
    const safeFilenameRegex = /^[a-zA-Z0-9._-]+$/;
    const uploadRegex = /\/uploads\/([a-zA-Z0-9._-]+)/g;

    const deleteFile = (filename) => {
      if (!filename || !safeFilenameRegex.test(filename) || filename.includes("..")) return;
      const filePath = path.resolve(UPLOAD_DIR, filename);
      if (!filePath.startsWith(uploadsDirResolved)) return;
      fs.unlink(filePath, () => {});
    };

    for (const msg of conv.messages) {
      // Primary: use fileRefs array (works for E2EE messages)
      if (Array.isArray(msg.fileRefs)) {
        for (const f of msg.fileRefs) deleteFile(f);
      }
      // Fallback: regex on text (works for legacy non-encrypted messages)
      const text = msg.text || "";
      let match;
      while ((match = uploadRegex.exec(text)) !== null) {
        deleteFile(match[1]);
      }
      uploadRegex.lastIndex = 0;
    }
  }

  const deletedId = conv.id;
  conversations.splice(idx, 1);
  saveConversations();

  const io = req.app.get("io");
  if (io) io.to(deletedId).emit("conversation:deleted", { id: deletedId });

  res.json({ message: "Group disbanded." });
});

// ------------------------------------------------------
//   E2EE GROUP KEYS: client-managed encrypted key map
// ------------------------------------------------------
router.patch("/api/conversations/:id/keys", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group") {
    return res.status(404).json({ message: "Group not found" });
  }

  if (!canManage(conv, user.id) && !(isGroupManager && isGroupManager(conv, user.id))) {
    return res.status(403).json({ message: "You are not allowed to update encryption keys for this group" });
  }

  const { encryptedKeys, keyVersion } = req.body || {};
  if (!encryptedKeys || typeof encryptedKeys !== "object") {
    return res.status(400).json({ message: "encryptedKeys object is required" });
  }

  conv.encryptedKeys = encryptedKeys;

  if (typeof keyVersion === "number") {
    conv.keyVersion = keyVersion;
  } else {
    conv.keyVersion = (conv.keyVersion || 0) + 1;
  }

  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) io.to(conv.id).emit("conversation:update", safeConv);

  res.json(safeConv);
});

// ------------------------------------------------------
//        Delete a message (sender-only, with socket)
// ------------------------------------------------------
router.delete("/api/conversations/:id/messages/:messageId", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const convId = req.params.id;
  const messageId = req.params.messageId;

  const conv = conversations.find((c) => c.id === convId);
  if (!conv) {
    return res.status(404).json({ message: "Conversation not found" });
  }

  if (
    conv.type !== "public" &&
    (!Array.isArray(conv.memberIds) || !conv.memberIds.includes(user.id))
  ) {
    return res.status(403).json({ message: "You are not a member of this conversation" });
  }

  if (!Array.isArray(conv.messages)) conv.messages = [];

  const idx = conv.messages.findIndex((m) => m.id === messageId);
  if (idx === -1) {
    return res.status(404).json({ message: "Message not found" });
  }

  const msg = conv.messages[idx];

  if (msg.senderId !== user.id) {
    return res.status(403).json({ message: "You can only delete your own messages" });
  }

  // Collect uploaded file references for cleanup
  const uploadFilenames = [];
  // Primary: use fileRefs array (works for E2EE messages)
  if (Array.isArray(msg.fileRefs)) {
    uploadFilenames.push(...msg.fileRefs);
  }
  // Fallback: regex on text (works for legacy non-encrypted messages)
  const text = msg.text || "";
  const uploadRegex = /\/uploads\/([a-zA-Z0-9._-]+)/g;
  let match;
  while ((match = uploadRegex.exec(text)) !== null) {
    uploadFilenames.push(match[1]);
  }

  conv.messages.splice(idx, 1);
  saveConversations();

  // Clean up uploaded files from disk (best-effort, non-blocking)
  for (const filename of uploadFilenames) {
    if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) continue;
    const filePath = path.resolve(UPLOAD_DIR, filename);
    if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) continue;
    fs.unlink(filePath, () => {});
  }

  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("chat:message-deleted", {
      conversationId: conv.id,
      messageId,
    });
  }

  return res.json({ success: true });
});

module.exports = router;
