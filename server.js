// server.js — SafeSpace backend (modular)
// Email verification, password reset, global chat, DMs, groups, admins, disband.

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");

const {
  ensureGlobalConversation,
  conversations,
  saveConversations,
} = require("./data/store");
const { verifySocketToken } = require("./utils/auth");

// Route modules
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const conversationRoutes = require("./routes/conversations");

const app = express();
app.use(cors({ origin: "*" }));
app.use(bodyParser.json());

// Mount API routes
app.use(authRoutes);
app.use(userRoutes);
app.use(conversationRoutes);

// ------------------------------------------------------
//                     SOCKET.IO
// ------------------------------------------------------

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
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

  // Join conversation
  socket.on("chat:join", ({ conversationId } = {}) => {
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

    const history = Array.isArray(conv.messages) ? conv.messages : [];

    socket.join(id);
    socket.emit("chat:history", {
      conversationId: id,
      messages: history,
    });
  });

  // Send message
  socket.on("chat:send", (payload) => {
    if (!payload) return;

    let text = payload;
    let id = "global";

    if (typeof payload === "object") {
      text = payload.text;
      id = payload.conversationId || "global";
    }

    if (!text || !String(text).trim()) return;

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
    };

    conv.messages.push(msg);
    saveConversations();

    io.to(id).emit("chat:message", msg);
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.user.username);
  });
});

// ------------------------------------------------------
//               SERVE REACT FRONTEND
// ------------------------------------------------------

app.use(express.static(path.join(__dirname, "build")));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, "build", "index.html"));
});

// ------------------------------------------------------
//                      START SERVER
// ------------------------------------------------------

const PORT = 5000;
server.listen(PORT, () => {
  console.log(`SafeSpace FULL server running at http://localhost:${PORT}`);
});
