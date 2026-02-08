// routes/calling.js — WebRTC call signaling via Socket.IO
// Manages ephemeral call sessions (in-memory only, not persisted).
// All media flows peer-to-peer (mesh topology) — server only relays signaling.

const MAX_CALL_PARTICIPANTS = 8;

// In-memory active calls: conversationId -> CallSession
const activeCalls = new Map();

// Track which call each user is in: `${socketId}` -> conversationId
const userCallMap = new Map();

// Track by userId (across multiple sockets/tabs): userId -> conversationId
const userIdCallMap = new Map();

function registerCallEvents(io, socket, conversations) {
  const userId = socket.user.id;
  const username = socket.user.username;

  // --- helpers ---

  function findConversation(convId) {
    return conversations.find((c) => c.id === convId) || null;
  }

  function isMember(conv) {
    if (!conv) return false;
    if (conv.type === "public") return true; // but we block calls in public
    return conv.memberIds?.includes(userId);
  }

  function emitToUser(targetUserId, event, data) {
    io.to(`user:${targetUserId}`).emit(event, data);
  }

  // Broadcast active calls status to all conversation members
  function broadcastCallStatus(conversationId) {
    const session = activeCalls.get(conversationId);
    if (session) {
      io.to(conversationId).emit("call:status", {
        conversationId,
        participants: [...session.participants],
        type: session.type,
        startedAt: session.startedAt,
      });
    } else {
      io.to(conversationId).emit("call:status", {
        conversationId,
        participants: [],
        type: null,
        startedAt: null,
      });
    }
  }

  // --- call:get-active-calls ---
  // Client requests all active calls on connect
  socket.on("call:get-active-calls", () => {
    const result = [];
    for (const [convId, session] of activeCalls) {
      const conv = findConversation(convId);
      if (conv && isMember(conv)) {
        result.push({
          conversationId: convId,
          participants: [...session.participants],
          type: session.type,
          startedAt: session.startedAt,
        });
      }
    }
    socket.emit("call:active-calls", result);
  });

  // --- call:initiate ---
  socket.on("call:initiate", ({ conversationId, type } = {}) => {
    if (!conversationId || !["voice", "video"].includes(type)) return;

    const conv = findConversation(conversationId);
    if (!conv) return;

    if (conv.type === "public") {
      socket.emit("call:error", { message: "Calls are not available in public channels." });
      return;
    }

    if (!isMember(conv)) return;

    // Check if user is already in a call (across all sockets/tabs)
    if (userIdCallMap.has(userId)) {
      const existingCallConvId = userIdCallMap.get(userId);
      if (existingCallConvId === conversationId) {
        // Already in this call, rejoin (reconnect scenario)
        const session = activeCalls.get(conversationId);
        if (session) {
          userCallMap.set(socket.id, conversationId);
          socket.join(`call:${conversationId}`);
          socket.emit("call:joined", {
            conversationId,
            type: session.type,
            participants: [...session.participants],
          });
          return;
        }
      } else {
        socket.emit("call:error", { message: "You are already in a call. Leave it first." });
        return;
      }
    }

    // If call already exists in this conversation, join it instead
    if (activeCalls.has(conversationId)) {
      const session = activeCalls.get(conversationId);
      if (session.participants.size >= MAX_CALL_PARTICIPANTS) {
        socket.emit("call:error", { message: `Call is full (max ${MAX_CALL_PARTICIPANTS} participants).` });
        return;
      }
      session.participants.add(userId);
      userCallMap.set(socket.id, conversationId);
      userIdCallMap.set(userId, conversationId);
      socket.join(`call:${conversationId}`);

      // Notify others
      socket.to(`call:${conversationId}`).emit("call:participant-joined", {
        conversationId,
        userId,
        username,
        participants: [...session.participants],
      });

      // Tell the joiner about existing participants
      socket.emit("call:joined", {
        conversationId,
        type: session.type,
        participants: [...session.participants],
      });

      // Broadcast updated call status to conversation members
      broadcastCallStatus(conversationId);
      return;
    }

    // Create new call session
    const session = {
      conversationId,
      type,
      initiatorId: userId,
      participants: new Set([userId]),
      startedAt: Date.now(),
    };
    activeCalls.set(conversationId, session);
    userCallMap.set(socket.id, conversationId);
    userIdCallMap.set(userId, conversationId);
    socket.join(`call:${conversationId}`);

    // Tell initiator the call is created
    socket.emit("call:joined", {
      conversationId,
      type,
      participants: [...session.participants],
    });

    // Notify other members of the conversation via the conversation room
    // (all members auto-join their conversation rooms on socket connect)
    socket.to(conversationId).emit("call:incoming", {
      conversationId,
      callerId: userId,
      callerName: username,
      type,
      participants: [...session.participants],
    });

    // Broadcast call status so sidebar shows active call
    broadcastCallStatus(conversationId);
  });

  // --- call:join ---
  socket.on("call:join", ({ conversationId } = {}) => {
    if (!conversationId) return;

    const conv = findConversation(conversationId);
    if (!conv || conv.type === "public" || !isMember(conv)) return;

    // Check if user is already in a different call
    if (userIdCallMap.has(userId) && userIdCallMap.get(userId) !== conversationId) {
      socket.emit("call:error", { message: "You are already in a call. Leave it first." });
      return;
    }

    const session = activeCalls.get(conversationId);
    if (!session) {
      socket.emit("call:error", { message: "No active call in this conversation." });
      return;
    }

    if (session.participants.has(userId)) {
      // Already in the call, just rejoin the room (reconnect scenario)
      userCallMap.set(socket.id, conversationId);
      userIdCallMap.set(userId, conversationId);
      socket.join(`call:${conversationId}`);
      socket.emit("call:joined", {
        conversationId,
        type: session.type,
        participants: [...session.participants],
      });
      return;
    }

    if (session.participants.size >= MAX_CALL_PARTICIPANTS) {
      socket.emit("call:error", { message: `Call is full (max ${MAX_CALL_PARTICIPANTS} participants).` });
      return;
    }

    session.participants.add(userId);
    userCallMap.set(socket.id, conversationId);
    userIdCallMap.set(userId, conversationId);
    socket.join(`call:${conversationId}`);

    // Notify existing participants
    socket.to(`call:${conversationId}`).emit("call:participant-joined", {
      conversationId,
      userId,
      username,
      participants: [...session.participants],
    });

    // Tell the joiner
    socket.emit("call:joined", {
      conversationId,
      type: session.type,
      participants: [...session.participants],
    });

    // Broadcast updated call status
    broadcastCallStatus(conversationId);
  });

  // --- call:leave ---
  socket.on("call:leave", ({ conversationId } = {}) => {
    if (!conversationId) return;
    removeParticipant(io, socket, conversationId, userId);
  });

  // --- call:reject ---
  socket.on("call:reject", ({ conversationId } = {}) => {
    if (!conversationId) return;
    const session = activeCalls.get(conversationId);
    if (!session) return;

    // Notify the call participants that this user rejected
    io.to(`call:${conversationId}`).emit("call:rejected", {
      conversationId,
      userId,
      username,
    });
  });

  // --- call:offer (relay SDP offer) ---
  socket.on("call:offer", ({ conversationId, targetUserId, offer } = {}) => {
    if (!conversationId || !targetUserId || !offer) return;
    const session = activeCalls.get(conversationId);
    if (!session || !session.participants.has(userId)) return;

    emitToUser(targetUserId, "call:offer", {
      conversationId,
      fromUserId: userId,
      offer,
    });
  });

  // --- call:answer (relay SDP answer) ---
  socket.on("call:answer", ({ conversationId, targetUserId, answer } = {}) => {
    if (!conversationId || !targetUserId || !answer) return;
    const session = activeCalls.get(conversationId);
    if (!session || !session.participants.has(userId)) return;

    emitToUser(targetUserId, "call:answer", {
      conversationId,
      fromUserId: userId,
      answer,
    });
  });

  // --- call:ice-candidate (relay ICE candidate) ---
  socket.on("call:ice-candidate", ({ conversationId, targetUserId, candidate } = {}) => {
    if (!conversationId || !targetUserId) return;
    const session = activeCalls.get(conversationId);
    if (!session || !session.participants.has(userId)) return;

    emitToUser(targetUserId, "call:ice-candidate", {
      conversationId,
      fromUserId: userId,
      candidate,
    });
  });

  // --- call:toggle-media (broadcast mute/camera state) ---
  socket.on("call:toggle-media", ({ conversationId, kind, enabled } = {}) => {
    if (!conversationId || !["audio", "video", "screen"].includes(kind)) return;
    const session = activeCalls.get(conversationId);
    if (!session || !session.participants.has(userId)) return;

    socket.to(`call:${conversationId}`).emit("call:media-toggled", {
      conversationId,
      userId,
      kind,
      enabled,
    });
  });
}

// Remove a participant from their active call
function removeParticipant(io, socket, conversationId, userId) {
  const session = activeCalls.get(conversationId);
  if (!session) return;

  session.participants.delete(userId);
  userCallMap.delete(socket.id);
  userIdCallMap.delete(userId);
  socket.leave(`call:${conversationId}`);

  if (session.participants.size === 0) {
    // Call ended — no participants left
    activeCalls.delete(conversationId);

    // Notify conversation members that the call ended
    io.to(conversationId).emit("call:ended", {
      conversationId,
      reason: "all_left",
    });

    // Broadcast empty call status
    io.to(conversationId).emit("call:status", {
      conversationId,
      participants: [],
      type: null,
      startedAt: null,
    });
  } else {
    // Notify remaining participants
    io.to(`call:${conversationId}`).emit("call:participant-left", {
      conversationId,
      userId,
      participants: [...session.participants],
    });

    // Broadcast updated call status to conversation members
    io.to(conversationId).emit("call:status", {
      conversationId,
      participants: [...session.participants],
      type: session.type,
      startedAt: session.startedAt,
    });
  }
}

// Called on socket disconnect — clean up any active call
function handleCallDisconnect(io, socket) {
  const conversationId = userCallMap.get(socket.id);
  if (!conversationId) return;

  const userId = socket.user?.id;
  if (!userId) return;

  removeParticipant(io, socket, conversationId, userId);
}

// Get active call for a conversation (used externally if needed)
function getActiveCall(conversationId) {
  const session = activeCalls.get(conversationId);
  if (!session) return null;
  return {
    conversationId: session.conversationId,
    type: session.type,
    initiatorId: session.initiatorId,
    participants: [...session.participants],
    startedAt: session.startedAt,
  };
}

module.exports = { registerCallEvents, handleCallDisconnect, getActiveCall };
