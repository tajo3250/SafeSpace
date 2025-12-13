// routes/conversations.js — DMs, groups, membership, admins, ownership, disband, message delete, E2EE group keys

const express = require("express");

const {
  users,
  conversations,
  saveConversations,
  ensureGlobalConversation,
  getOrCreateDmConversation,
  isGroupManager,
} = require("../data/store");
const { getUserFromRequest } = require("../utils/auth");

const router = express.Router();

// Helper to build safe conversation payload
function buildSafeConversation(conv) {
  return {
    id: conv.id,
    type: conv.type,
    name: conv.name,
    memberIds: Array.isArray(conv.memberIds) ? conv.memberIds : [],
    ownerId: conv.ownerId || null,
    adminIds: Array.isArray(conv.adminIds) ? conv.adminIds : [],
    createdAt: conv.createdAt,
    // E2EE: client-managed encrypted group keys and version
    encryptedKeys:
      conv && typeof conv.encryptedKeys === "object"
        ? conv.encryptedKeys
        : {},
    keyVersion:
      typeof conv.keyVersion === "number" ? conv.keyVersion : 0,
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

// Start DM by username
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
  if (!target)
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

// Create group
router.post("/api/conversations/group", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const {
    name,
    memberEmails,
    memberIds,
    // E2EE: client may send encrypted group keys + version
    encryptedKeys,
    keyVersion,
  } = req.body || {};

  if (!name || !name.trim())
    return res.status(400).json({ message: "Group name required" });

  const memberIdSet = new Set([user.id]);

  if (Array.isArray(memberIds)) {
    for (const id of memberIds) {
      const u = users.find((usr) => usr.id === id);
      if (u) memberIdSet.add(u.id);
    }
  }

  if (Array.isArray(memberEmails)) {
    for (const emailRaw of memberEmails) {
      const email = String(emailRaw || "").toLowerCase();
      if (!email) continue;
      const u = users.find(
        (usr) => (usr.email || "").toLowerCase() === email
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
      encryptedKeys && typeof encryptedKeys === "object"
        ? encryptedKeys
        : {},
    keyVersion:
      typeof keyVersion === "number" ? keyVersion : 0,
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
router.post("/api/conversations/:id/add-member", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (!isGroupManager(conv, user.id))
    return res
      .status(403)
      .json({ message: "You are not allowed to modify this group" });

  const { userId, userEmail } = req.body || {};
  if (!userId && !userEmail)
    return res
      .status(400)
      .json({ message: "userId or userEmail required" });

  let target = null;

  if (userId) {
    target = users.find((u) => u.id === userId);
  } else if (userEmail) {
    const emailLower = String(userEmail).toLowerCase();
    target = users.find(
      (u) => (u.email || "").toLowerCase() === emailLower
    );
  }

  if (!target)
    return res.status(404).json({ message: "Target user not found" });

  if (!Array.isArray(conv.memberIds)) conv.memberIds = [];
  if (!conv.memberIds.includes(target.id)) {
    conv.memberIds.push(target.id);
    saveConversations();
  }

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    // Update everyone already in the group
    io.to(conv.id).emit("conversation:update", safeConv);
    // Notify the newly added member so they see the group appear
    io.to(`user:${target.id}`).emit("conversation:created", safeConv);
  }

  res.json(safeConv);
});

// Remove member from a group (owner/admin only)
router.post("/api/conversations/:id/remove-member", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group")
    return res.status(404).json({ message: "Group not found" });

  if (!isGroupManager(conv, user.id))
    return res
      .status(403)
      .json({ message: "You are not allowed to modify this group" });

  const { userId } = req.body || {};
  if (!userId)
    return res.status(400).json({ message: "userId required" });

  if (!Array.isArray(conv.memberIds)) conv.memberIds = [];

  if (userId === conv.ownerId) {
    return res
      .status(400)
      .json({ message: "You cannot remove the group creator" });
  }

  const beforeCount = conv.memberIds.length;
  conv.memberIds = conv.memberIds.filter((id) => id !== userId);

  if (Array.isArray(conv.adminIds)) {
    conv.adminIds = conv.adminIds.filter((id) => id !== userId);
  }

  if (conv.memberIds.length !== beforeCount) {
    saveConversations();
  }

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    // Update remaining members
    io.to(conv.id).emit("conversation:update", safeConv);
    // Tell removed user to auto-leave
    io.to(`user:${userId}`).emit("conversation:removed", { id: conv.id });
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

  if (
    !Array.isArray(conv.memberIds) ||
    !conv.memberIds.includes(user.id)
  ) {
    return res
      .status(400)
      .json({ message: "You are not a member of this group" });
  }

  if (conv.ownerId === user.id) {
    return res.status(400).json({
      message:
        "Transfer ownership to another member before leaving this group",
    });
  }

  conv.memberIds = conv.memberIds.filter((id) => id !== user.id);

  if (Array.isArray(conv.adminIds)) {
    conv.adminIds = conv.adminIds.filter((id) => id !== user.id);
  }

  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    // Update remaining members
    io.to(conv.id).emit("conversation:update", safeConv);
    // Tell leaver to auto-leave
    io.to(`user:${user.id}`).emit("conversation:removed", { id: conv.id });
  }

  res.json(safeConv);
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
    return res.status(403).json({
      message: "Only the group creator can manage admins",
    });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ message: "userId required" });

  if (!Array.isArray(conv.memberIds)) conv.memberIds = [];
  if (!conv.memberIds.includes(userId)) {
    return res.status(400).json({
      message: "User must be a member before becoming an admin",
    });
  }

  if (!Array.isArray(conv.adminIds)) conv.adminIds = [];
  if (!conv.adminIds.includes(userId)) {
    conv.adminIds.push(userId);
    saveConversations();
  }

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
  }

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
    return res.status(403).json({
      message: "Only the group creator can manage admins",
    });
  }

  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ message: "userId required" });

  if (userId === conv.ownerId) {
    return res
      .status(400)
      .json({ message: "You cannot demote the group creator" });
  }

  if (!Array.isArray(conv.adminIds)) conv.adminIds = [];

  const before = conv.adminIds.length;
  conv.adminIds = conv.adminIds.filter((id) => id !== userId);

  if (conv.adminIds.length !== before) {
    saveConversations();
  }

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
  }

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
    return res.status(403).json({
      message: "Only the group creator can transfer ownership",
    });
  }

  const { newOwnerId } = req.body || {};
  if (!newOwnerId)
    return res
      .status(400)
      .json({ message: "newOwnerId required" });

  if (
    !Array.isArray(conv.memberIds) ||
    !conv.memberIds.includes(newOwnerId)
  ) {
    return res.status(400).json({
      message: "New owner must be a member of this group",
    });
  }

  conv.ownerId = newOwnerId;

  if (!Array.isArray(conv.adminIds)) conv.adminIds = [];
  if (!conv.adminIds.includes(newOwnerId)) {
    conv.adminIds.push(newOwnerId);
  }

  saveConversations();

  const safeConv = buildSafeConversation(conv);
  const io = req.app.get("io");
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
  }

  res.json(safeConv);
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
    return res.status(403).json({
      message: "Only the group creator can disband this group",
    });
  }

  const deletedId = conv.id;
  conversations.splice(idx, 1);
  saveConversations();

  const io = req.app.get("io");
  if (io) {
    io.to(deletedId).emit("conversation:deleted", { id: deletedId });
  }

  res.json({ message: "Group disbanded." });
});

// ------------------------------------------------------
//   E2EE GROUP KEYS: client-managed encrypted key map
// ------------------------------------------------------
//
// PATCH /api/conversations/:id/keys
// Body: { encryptedKeys: { [userId]: blob }, keyVersion?: number }
// Only owner/admins may update. Server never decrypts, just stores and broadcasts.
//

router.patch("/api/conversations/:id/keys", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const convId = req.params.id;
  const conv = conversations.find((c) => c.id === convId);
  if (!conv || conv.type !== "group") {
    return res.status(404).json({ message: "Group not found" });
  }

  if (!isGroupManager(conv, user.id)) {
    return res.status(403).json({
      message: "You are not allowed to update encryption keys for this group",
    });
  }

  const { encryptedKeys, keyVersion } = req.body || {};
  if (!encryptedKeys || typeof encryptedKeys !== "object") {
    return res
      .status(400)
      .json({ message: "encryptedKeys object is required" });
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
  if (io) {
    io.to(conv.id).emit("conversation:update", safeConv);
  }

  res.json(safeConv);
});

// ------------------------------------------------------
//        Delete a message (sender-only, with socket)
// ------------------------------------------------------
router.delete(
  "/api/conversations/:id/messages/:messageId",
  (req, res) => {
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

    // Only members (or everyone for public) can touch messages
    if (
      conv.type !== "public" &&
      (!Array.isArray(conv.memberIds) ||
        !conv.memberIds.includes(user.id))
    ) {
      return res.status(403).json({
        message: "You are not a member of this conversation",
      });
    }

    if (!Array.isArray(conv.messages)) conv.messages = [];

    const idx = conv.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      return res
        .status(404)
        .json({ message: "Message not found" });
    }

    const msg = conv.messages[idx];

    // Sender-only delete
    if (msg.senderId !== user.id) {
      return res.status(403).json({
        message: "You can only delete your own messages",
      });
    }

    conv.messages.splice(idx, 1);
    saveConversations();

    // Broadcast delete event over Socket.IO
    const io = req.app.get("io");
    if (io) {
      io.to(conv.id).emit("chat:message-deleted", {
        conversationId: conv.id,
        messageId,
      });
    }

    return res.json({ success: true });
  }
);

module.exports = router;
