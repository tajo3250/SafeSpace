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

// Message validation limits
const MAX_MESSAGE_CHARS = 4000;
const MAX_ATTACHMENTS = 10;
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB max for a single message payload

// GitHub Release cache for desktop downloads
const GITHUB_RELEASE_URL = "https://api.github.com/repos/hxn1-z/SafeSpace/releases/latest";
const GITHUB_RELEASE_TTL = 5 * 60 * 1000; // 5 minutes
let ghReleaseCache = { data: null, time: 0 };

async function getLatestRelease() {
  if (ghReleaseCache.data && Date.now() - ghReleaseCache.time < GITHUB_RELEASE_TTL) {
    return ghReleaseCache.data;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(GITHUB_RELEASE_URL, {
      signal: controller.signal,
      headers: {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "SafeSpace-Server/1.0",
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return ghReleaseCache.data;
    const data = await res.json();
    ghReleaseCache = { data, time: Date.now() };
    return data;
  } catch {
    return ghReleaseCache.data;
  }
}

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

// Server-side message validation: enforces text length, payload size, and attachment limits.
// Strips inline base64 dataUrl fields from attachment payloads to prevent abuse.
function validateMessageText(rawText) {
  if (!rawText || typeof rawText !== "string") return { valid: false, reason: "Empty message" };

  const trimmed = rawText.trim();
  if (!trimmed) return { valid: false, reason: "Empty message" };

  // Hard limit on total payload byte size
  const byteLength = Buffer.byteLength(trimmed, "utf8");
  if (byteLength > MAX_PAYLOAD_BYTES) {
    return { valid: false, reason: "Message payload too large" };
  }

  // Try to parse as JSON to validate structured payloads
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Not JSON — plain text message
  }

  if (parsed && typeof parsed === "object") {
    // E2EE encrypted messages — server cannot inspect contents, size check above is sufficient
    if (parsed.e2ee === true) {
      return { valid: true, text: trimmed };
    }

    // Attachment payload (ss-message format)
    if (parsed.kind === "ss-message") {
      const innerText = typeof parsed.text === "string" ? parsed.text : "";
      if (innerText.length > MAX_MESSAGE_CHARS) {
        return {
          valid: false,
          reason: "Message text too long (" + innerText.length + "/" + MAX_MESSAGE_CHARS + ")",
        };
      }
      if (Array.isArray(parsed.attachments)) {
        if (parsed.attachments.length > MAX_ATTACHMENTS) {
          return { valid: false, reason: "Too many attachments (max " + MAX_ATTACHMENTS + ")" };
        }
        // Validate attachment metadata sizes, whitelist fields, and strip abusive data
        const ALLOWED_ATT_FIELDS = new Set([
          "id", "type", "name", "mime", "size", "width", "height",
          "encrypted", "fileKey", "iv", "url", "previewUrl", "dataUrl", "gif",
          "processedUrl",
        ]);
        let stripped = false;
        for (let i = 0; i < parsed.attachments.length; i++) {
          const att = parsed.attachments[i];
          if (!att || typeof att !== "object") continue;
          // Strip inline base64 dataUrls — files should be referenced by upload URL only
          if (typeof att.dataUrl === "string") {
            delete att.dataUrl;
            stripped = true;
          }
          // Prevent oversized metadata fields (security: stops abuse of JSON payload size)
          if (typeof att.name === "string" && att.name.length > 255) {
            att.name = att.name.slice(0, 255);
            stripped = true;
          }
          if (typeof att.mime === "string" && att.mime.length > 255) {
            att.mime = att.mime.slice(0, 255);
            stripped = true;
          }
          if (typeof att.url === "string" && att.url.length > 2048) {
            att.url = att.url.slice(0, 2048);
            stripped = true;
          }
          if (typeof att.id === "string" && att.id.length > 255) {
            att.id = att.id.slice(0, 255);
            stripped = true;
          }
          if (typeof att.previewUrl === "string" && att.previewUrl.length > 2048) {
            att.previewUrl = att.previewUrl.slice(0, 2048);
            stripped = true;
          }
          if (typeof att.fileKey === "string" && att.fileKey.length > 128) {
            att.fileKey = att.fileKey.slice(0, 128);
            stripped = true;
          }
          if (typeof att.iv === "string" && att.iv.length > 128) {
            att.iv = att.iv.slice(0, 128);
            stripped = true;
          }
          // Validate gif sub-object fields
          if (att.gif && typeof att.gif === "object") {
            const g = att.gif;
            if (typeof g.url === "string" && g.url.length > 2048) { g.url = g.url.slice(0, 2048); stripped = true; }
            if (typeof g.previewUrl === "string" && g.previewUrl.length > 2048) { g.previewUrl = g.previewUrl.slice(0, 2048); stripped = true; }
            if (typeof g.title === "string" && g.title.length > 255) { g.title = g.title.slice(0, 255); stripped = true; }
            if (typeof g.provider === "string" && g.provider.length > 64) { g.provider = g.provider.slice(0, 64); stripped = true; }
            if (typeof g.id === "string" && g.id.length > 255) { g.id = g.id.slice(0, 255); stripped = true; }
          }
          // Strip unknown properties from attachment objects
          for (const key of Object.keys(att)) {
            if (!ALLOWED_ATT_FIELDS.has(key)) {
              delete att[key];
              stripped = true;
            }
          }
        }
        if (stripped) {
          return { valid: true, text: JSON.stringify(parsed) };
        }
      }
      return { valid: true, text: trimmed };
    }
  }

  // Plain text — enforce character limit
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return {
      valid: false,
      reason: "Message too long (" + trimmed.length + "/" + MAX_MESSAGE_CHARS + ")",
    };
  }

  return { valid: true, text: trimmed };
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

const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "2mb" }));

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

// Blocked MIME types (security risk — can contain executable scripts or code)
const BLOCKED_UPLOAD_MIMES = new Set([
  "text/html", "text/javascript", "application/javascript", "application/x-javascript",
  "image/svg+xml",
  "application/x-executable", "application/x-dosexec", "application/x-msdownload",
  "application/vnd.microsoft.portable-executable",
  "application/x-shellscript", "application/x-sh", "application/x-csh",
  "application/x-httpd-php", "application/x-php",
]);

const MAX_UPLOAD_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB file upload limit

const upload = multer({
  storage: storage,
  limits: { fileSize: MAX_UPLOAD_BYTES },
  fileFilter: function (_req, file, cb) {
    if (BLOCKED_UPLOAD_MIMES.has(file.mimetype)) {
      return cb(new Error("This file type is not allowed"));
    }
    cb(null, true);
  },
});

// Serve uploaded files with restrictive headers to prevent script execution
app.use("/uploads", express.static(UPLOAD_DIR, {
  setHeaders: (res, filePath) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Content-Security-Policy", "default-src 'none'; img-src 'self'; style-src 'none'; script-src 'none'");
    // Force download for non-image files to prevent browser rendering of potentially dangerous content
    const ext = path.extname(filePath).toLowerCase();
    const inlineExts = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".avif"]);
    if (!inlineExts.has(ext)) {
      res.set("Content-Disposition", "attachment");
    }
  },
}));

// Desktop app version check (from GitHub Releases)
app.get("/api/desktop-version", async (req, res) => {
  try {
    const release = await getLatestRelease();
    if (!release) {
      return res.status(404).json({ message: "No release found" });
    }
    res.json({
      version: release.tag_name?.replace(/^v/, "") || "unknown",
      tag: release.tag_name,
      url: release.html_url,
    });
  } catch {
    res.status(500).json({ message: "Failed to fetch release info" });
  }
});

// Download endpoint — redirects to latest GitHub Release asset
app.get("/api/download/:platform", async (req, res) => {
  const platform = req.params.platform;
  const patterns = {
    windows: /\.exe$/i,
    mac: /\.dmg$/i,
    linux: /\.AppImage$/i,
  };

  const pattern = patterns[platform];
  if (!pattern) {
    return res.status(400).json({ error: "Invalid platform. Use: windows, mac, linux" });
  }

  try {
    const release = await getLatestRelease();
    if (!release || !Array.isArray(release.assets)) {
      return res.status(404).json({ error: "No release available yet. Check back soon." });
    }

    const asset = release.assets.find(
      (a) => pattern.test(a.name) && !a.name.includes("blockmap")
    );

    if (!asset) {
      return res.status(404).json({ error: `No ${platform} build available in the latest release.` });
    }

    res.redirect(302, asset.browser_download_url);
  } catch {
    res.status(502).json({ error: "Failed to fetch release info" });
  }
});

// UPLOAD ROUTE
app.post("/api/upload", (req, res, next) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  req.user = user;
  return next();
}, (req, res, next) => {
  upload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
    next();
  });
}, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ url: fileUrl, filename: req.file.filename, size: req.file.size });
});

// DELETE UPLOAD (authenticated, path-traversal-safe)
app.delete("/api/upload/:filename", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const filename = req.params.filename;
  if (
    !filename ||
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  ) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = path.resolve(UPLOAD_DIR, filename);
  if (!filePath.startsWith(path.resolve(UPLOAD_DIR) + path.sep)) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  fs.unlink(filePath, (err) => {
    if (err && err.code !== "ENOENT") {
      return res.status(500).json({ error: "Failed to delete file" });
    }
    res.json({ success: true });
  });
});


// LINK PREVIEW — fetch Open Graph metadata for a URL
const linkPreviewCache = new Map();
const LINK_PREVIEW_MAX_CACHE = 500;
const LINK_PREVIEW_TTL = 15 * 60 * 1000; // 15 minutes

app.get("/api/link-preview", async (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== "string") {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return res.status(400).json({ error: "Only http/https URLs allowed" });
  }

  // SSRF protection: block private/internal IPs
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("172.") ||
    host === "[::1]" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return res.status(400).json({ error: "URL not allowed" });
  }

  // Check cache
  const cached = linkPreviewCache.get(targetUrl);
  if (cached && Date.now() - cached.time < LINK_PREVIEW_TTL) {
    return res.json(cached.data);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "SafeSpace-LinkPreview/1.0",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(502).json({ error: "Failed to fetch URL" });
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("xhtml")) {
      return res.status(400).json({ error: "Not an HTML page" });
    }

    // Read only first 50KB
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = 50 * 1024;
    while (totalBytes < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.length;
    }
    reader.cancel();
    const html = Buffer.concat(chunks).toString("utf-8");

    // Extract OG tags via regex
    const getOg = (property) => {
      const patterns = [
        new RegExp(`<meta[^>]+property=["']og:${property}["'][^>]+content=["']([^"']+)["']`, "i"),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:${property}["']`, "i"),
      ];
      for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1].trim();
      }
      return "";
    };

    const getMeta = (name) => {
      const patterns = [
        new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']+)["']`, "i"),
        new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+name=["']${name}["']`, "i"),
      ];
      for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1].trim();
      }
      return "";
    };

    const title = getOg("title") || (() => {
      const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      return m ? m[1].trim() : "";
    })();
    const description = getOg("description") || getMeta("description");
    const image = getOg("image");
    const siteName = getOg("site_name");

    const data = {
      url: targetUrl,
      title: (title || "").slice(0, 200),
      description: (description || "").slice(0, 500),
      image: (image || "").slice(0, 2000),
      siteName: (siteName || "").slice(0, 100),
    };

    // Cache with eviction
    if (linkPreviewCache.size >= LINK_PREVIEW_MAX_CACHE) {
      const oldest = linkPreviewCache.keys().next().value;
      linkPreviewCache.delete(oldest);
    }
    linkPreviewCache.set(targetUrl, { data, time: Date.now() });

    res.json(data);
  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Timeout fetching URL" });
    }
    res.status(502).json({ error: "Failed to fetch URL" });
  }
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
  cors: { origin: CORS_ORIGIN },
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
    let fileRefs = null;

    if (typeof payload === "object") {
      text = payload.text;
      id = payload.conversationId || "global";
      replyToId = payload.replyToId ? String(payload.replyToId) : null;

      // Plaintext file references for server-side cleanup (filenames are random UUIDs, not sensitive)
      if (Array.isArray(payload.fileRefs)) {
        const safeFilenameRegex = /^[a-zA-Z0-9._-]+$/;
        fileRefs = payload.fileRefs.filter(
          (f) => typeof f === "string" && f.length < 256 && safeFilenameRegex.test(f) && !f.includes("..")
        );
      }

      const preview = payload.replyToPreview;
      if (preview && typeof preview === "object") {
        const safePreview = {};
        if (typeof preview.senderId === "string") safePreview.senderId = preview.senderId.slice(0, 64);
        if (typeof preview.senderName === "string") safePreview.senderName = preview.senderName.slice(0, 64);
        if (typeof preview.snippet === "string") {
          safePreview.snippet = preview.snippet.slice(0, 140);
        }
        if (typeof preview.encrypted === "boolean") safePreview.encrypted = preview.encrypted;
        if (Object.keys(safePreview).length > 0) replyToPreview = safePreview;
      }
    }

    // Validate and sanitize message (enforces length/size limits, strips inline dataUrls)
    const validation = validateMessageText(typeof text === "string" ? text : String(text || ""));
    if (!validation.valid) {
      socket.emit("error", { message: validation.reason || "Invalid message" });
      return;
    }

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
      text: validation.text,
      senderId: socket.user.id,
      senderName: socket.user.username,
      createdAt: new Date().toISOString(),
      conversationId: id,
      replyToId,
      replyToPreview,
    };

    // Store plaintext file references for server-side cleanup on delete/disband
    if (fileRefs && fileRefs.length > 0) {
      msg.fileRefs = fileRefs;
    }

    conv.messages.push(msg);
    saveConversations();

    io.to(id).emit("chat:message", msg);
  });


  // Edit message (author-only)
  socket.on("chat:edit", ({ conversationId, messageId, text } = {}) => {
    const id = conversationId || "global";
    if (!messageId) return;
    const editValidation = validateMessageText(typeof text === "string" ? text : String(text || ""));
    if (!editValidation.valid) {
      socket.emit("error", { message: editValidation.reason || "Invalid message" });
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

    if (!Array.isArray(conv.messages)) return;
    const msg = conv.messages.find((m) => String(m.id) === String(messageId));
    if (!msg) return;

    // Only the original sender can edit
    if (msg.senderId !== socket.user.id) return;

    msg.text = editValidation.text;
    msg.editedAt = new Date().toISOString();

    saveConversations();
    io.to(id).emit("chat:message-edited", { conversationId: id, message: msg });
  });

  // React to message (toggle emoji reaction)
  socket.on("chat:react", ({ conversationId, messageId, emoji } = {}) => {
    const id = conversationId || "global";
    if (!messageId || !emoji || typeof emoji !== "string" || emoji.length > 16) return;

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

    // Initialize reactions object if needed
    if (!msg.reactions || typeof msg.reactions !== "object") {
      msg.reactions = {};
    }

    // Toggle: if user already reacted with this emoji, remove; otherwise add
    if (!Array.isArray(msg.reactions[emoji])) {
      msg.reactions[emoji] = [];
    }
    const idx = msg.reactions[emoji].indexOf(socket.user.id);
    if (idx >= 0) {
      msg.reactions[emoji].splice(idx, 1);
      if (msg.reactions[emoji].length === 0) {
        delete msg.reactions[emoji];
      }
    } else {
      msg.reactions[emoji].push(socket.user.id);
    }

    // Clean up empty reactions object
    if (Object.keys(msg.reactions).length === 0) {
      delete msg.reactions;
    }

    saveConversations();
    io.to(id).emit("chat:reaction-updated", {
      conversationId: id,
      messageId,
      reactions: msg.reactions || {},
    });
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

// SPA fallback for React Router, but skip API + Socket.IO + download paths
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/socket.io") || req.path.startsWith("/downloads")) {
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
