// server.js — SafeSpace backend (modular)
// Email verification, password reset, global chat, DMs, groups, admins, disband.

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const fs = require("fs");

const {
  ensureGlobalConversation,
  conversations,
  saveConversations,
} = require("./data/store");
const { verifySocketToken, getUserFromRequest } = require("./utils/auth");

// Route modules
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const conversationRoutes = require("./routes/conversations");
const gifRoutes = require("./routes/gifs");

// RATE LIMITER: map user ID -> { count, startTime }
// 5 messages per 5 seconds
const RATE_LIMIT_WINDOW = 5000;
const RATE_LIMIT_MAX = 5;
const rateLimitMap = new Map();

function checkRateLimit(userId) {
  const now = Date.now();
  let record = rateLimitMap.get(userId);

  if (!record) {
    record = { count: 0, startTime: now };
    rateLimitMap.set(userId, record);
  }

  // Reset if window passed
  if (now - record.startTime > RATE_LIMIT_WINDOW) {
    record.count = 0;
    record.startTime = now;
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return false; // limited
  }

  record.count++;
  return true; // allowed
}

const app = express();
const MAX_SOCKET_MESSAGE_BYTES = Number(
  process.env.SS_MAX_SOCKET_MESSAGE_BYTES || 20 * 1024 * 1024
);

// SECURITY HEADERS
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for now to prevent breaking inline scripts/styles if any
}));

// Enable trust proxy for Cloudflare/Reverse Proxies (fixes req.protocol being 'http')
app.set("trust proxy", 1);

// GLOBAL API RATE LIMITING (Brute-force protection)
// 100 requests per 15 minutes window
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." }
});
app.use("/api/", apiLimiter);

app.use(cors({ origin: "*" })); // TODO: Restrict in production
app.use(express.json());

// UPLOAD CONFIGURATION
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  try {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  } catch (err) {
    console.error("Failed to create start uploads dir:", err);
  }
}

// Storage config
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    // Generate unique filename: timestamp-random-original
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    // Sanitize original name or just use a safe fallback
    const safeName = (file.originalname || "upload").replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, uniqueSuffix + '-' + safeName);
  }
});

// 600MB upload limit
const upload = multer({
  storage: storage,
  limits: { fileSize: 600 * 1024 * 1024 }
});

// STATICALLY SERVE UPLOADS (Make sure this is protected or secure in real app)
app.use("/uploads", express.static(UPLOAD_DIR));

// UPLOAD ROUTE
app.post("/api/upload", (req, res, next) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  req.user = user;
  return next();
}, upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  // Return URL needed to access it
  // Use relative path to avoid Mixed Content errors (Client resolves against its own origin)
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl, filename: req.file.filename, size: req.file.size });
});


// Mount API routes
app.use(authRoutes);
app.use(userRoutes);
app.use(conversationRoutes);
app.use(gifRoutes);

// ------------------------------------------------------
//                     SOCKET.IO
// ------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: MAX_SOCKET_MESSAGE_BYTES,
});
app.set("io", io);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("No token"));

  try {
    const payload = verifySocketToken(token);
    socket.user = payload;
    next();
  } catch {
    next(new Error("Invalid token"));
  }
});

io.on("connection", (socket) => {
  console.log("User connected:", socket.user.username);

  // Join a user-specific room so REST routes can push updates to this user
  const userRoomId = `user:${socket.user.id}`;
  socket.join(userRoomId);

  ensureGlobalConversation();

  // Auto-join all rooms the user should receive real-time events for
  try {
    for (const conv of conversations) {
      if (!conv) continue;

      if (conv.type === "public" || conv.id === "global") {
        socket.join(conv.id);
        continue;
      }

      if (
        Array.isArray(conv.memberIds) &&
        conv.memberIds.includes(socket.user.id)
      ) {
        socket.join(conv.id);
      }
    }
  } catch (e) {
    console.error("Auto-join rooms failed:", e);
  }

  // Join conversation (also returns history with pagination)
  // Payload: { conversationId, limit? (default 50), beforeId? (cursor), afterId? (cursor), aroundId? (cursor) }
  socket.on("chat:join", ({ conversationId, limit, beforeId, afterId, aroundId } = {}) => {
    const id = conversationId || "global";
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;

    // Only allow members for non-public conversations
    if (
      conv.type !== "public" &&
      (!Array.isArray(conv.memberIds) ||
        !conv.memberIds.includes(socket.user.id))
    ) {
      return;
    }

    const allMessages = Array.isArray(conv.messages) ? conv.messages : [];

    // Pagination logic
    let messagesToReturn = [];
    let direction = "latest";
    let hasMoreOlder = false;
    let hasMoreNewer = false;
    const fetchLimit = typeof limit === "number" ? limit : 50;

    if (aroundId) {
      const idx = allMessages.findIndex((m) => m.id === aroundId);
      if (idx !== -1) {
        const half = Math.floor(fetchLimit / 2);
        let start = Math.max(0, idx - half);
        let end = Math.min(allMessages.length, start + fetchLimit);
        if (end - start < fetchLimit && start > 0) {
          start = Math.max(0, end - fetchLimit);
        }
        messagesToReturn = allMessages.slice(start, end);
        direction = "around";
        hasMoreOlder = start > 0;
        hasMoreNewer = end < allMessages.length;
      } else {
        messagesToReturn = [];
        direction = "around";
      }
    } else if (beforeId) {
      const idx = allMessages.findIndex((m) => m.id === beforeId);
      if (idx !== -1) {
        // Return 'limit' messages BEFORE this index
        const start = Math.max(0, idx - fetchLimit);
        messagesToReturn = allMessages.slice(start, idx);
        direction = "older";
        hasMoreOlder = start > 0;
        hasMoreNewer = idx < allMessages.length - 1;
      } else {
        // cursor not found? return empty or standard
        messagesToReturn = [];
        direction = "older";
      }
    } else if (afterId) {
      const idx = allMessages.findIndex((m) => m.id === afterId);
      if (idx !== -1) {
        const start = idx + 1;
        const end = Math.min(allMessages.length, start + fetchLimit);
        messagesToReturn = allMessages.slice(start, end);
        direction = "newer";
        hasMoreOlder = idx > 0;
        hasMoreNewer = end < allMessages.length;
      } else {
        messagesToReturn = [];
        direction = "newer";
      }
    } else {
      // Return last 'limit' messages
      const start = Math.max(0, allMessages.length - fetchLimit);
      messagesToReturn = allMessages.slice(start);
      direction = "latest";
      hasMoreOlder = start > 0;
      hasMoreNewer = false;
    }

    socket.join(id);
    socket.emit("chat:history", {
      conversationId: id,
      messages: messagesToReturn,
      direction,
      hasMoreOlder,
      hasMoreNewer,
    });
  });

  // Send message
  socket.on("chat:send", (payload) => {
    if (!payload) return;

    let text = payload;
    let id = "global";
    let replyToId = null;
    let replyToPreview = null;

    if (typeof payload === "object") {
      text = payload.text;
      id = payload.conversationId || "global";
      replyToId = payload.replyToId ? String(payload.replyToId) : null;

      const preview = payload.replyToPreview;
      if (preview && typeof preview === "object") {
        const safePreview = {};
        if (typeof preview.senderId === "string") safePreview.senderId = preview.senderId;
        if (typeof preview.senderName === "string") safePreview.senderName = preview.senderName;
        if (typeof preview.snippet === "string") {
          safePreview.snippet = preview.snippet.slice(0, 140);
        }
        if (typeof preview.encrypted === "boolean") safePreview.encrypted = preview.encrypted;
        if (Object.keys(safePreview).length > 0) replyToPreview = safePreview;
      }
    }

    if (!text || !String(text).trim()) return;

    // Rate Limit Check
    if (!checkRateLimit(socket.user.id)) {
      socket.emit("error", { message: "You are sending messages too fast." });
      return;
    }

    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;

    if (
      conv.type !== "public" &&
      (!Array.isArray(conv.memberIds) ||
        !conv.memberIds.includes(socket.user.id))
    ) {
      return;
    }

    if (!Array.isArray(conv.messages)) conv.messages = [];

    const msg = {
      id: Date.now().toString(),
      text: String(text).trim(),
      senderId: socket.user.id,
      senderName: socket.user.username,
      createdAt: new Date().toISOString(),
      conversationId: id,
      replyToId,
      replyToPreview,
    };

    conv.messages.push(msg);
    saveConversations();

    io.to(id).emit("chat:message", msg);
  });


  // Edit message (author-only)
  socket.on("chat:edit", ({ conversationId, messageId, text } = {}) => {
    const id = conversationId || "global";
    if (!messageId) return;
    if (text == null || !String(text).trim()) return;

    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;

    if (
      conv.type !== "public" &&
      (!Array.isArray(conv.memberIds) ||
        !conv.memberIds.includes(socket.user.id))
    ) {
      return;
    }

    if (!Array.isArray(conv.messages)) return;
    const msg = conv.messages.find((m) => String(m.id) === String(messageId));
    if (!msg) return;

    // Only the original sender can edit
    if (msg.senderId !== socket.user.id) return;

    msg.text = String(text).trim();
    msg.editedAt = new Date().toISOString();

    saveConversations();
    io.to(id).emit("chat:message-edited", { conversationId: id, message: msg });
  });
  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.user.username);
  });
});

// ------------------------------------------------------
//     SERVE VITE FRONTEND (client/dist) SAFELY
//     (do NOT hijack /socket.io or /api)
// ------------------------------------------------------

const distPath = path.join(__dirname, "client", "dist");
app.use(express.static(distPath));

// SPA fallback for React Router, but skip API + Socket.IO
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
    return next();
  }
  res.sendFile(path.join(distPath, "index.html"));
});

// ------------------------------------------------------
//                      START SERVER
// ------------------------------------------------------

const PORT = 5000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`SafeSpace server running on http://0.0.0.0:${PORT}`);
});
