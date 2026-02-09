// routes/users.js — list users, user profiles, E2EE public keys + encrypted key bundle backup

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const { users, saveUsers } = require("../data/store");
const { getUserFromRequest } = require("../utils/auth");

const router = express.Router();

// ---------- Avatar upload config ----------
const AVATAR_DIR = path.join(__dirname, "..", "uploads", "avatars");
// Ensure avatar directory exists at module load time
if (!fs.existsSync(AVATAR_DIR)) {
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
}

const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, AVATAR_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});

const avatarUpload = multer({
  storage: avatarStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error("Only JPEG, PNG, WebP, and GIF images are allowed"));
    }
    cb(null, true);
  },
});

// ---------- User listing ----------

// List all VERIFIED users (basic info)
router.get("/api/users", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  res.json(
    users
      .filter((u) => u && u.verified === true)
      .map((u) => ({
        id: u.id,
        username: u.username || "",
        profilePicture: u.profilePicture || null,
        profilePictureThumbnail: u.profilePictureThumbnail || null,
        aboutMe: u.aboutMe || "",
      }))
  );
});

// ---------- User profile ----------

// Upload profile picture (crop/resize to 256x256 + 64x64 thumbnail)
router.post("/api/users/me/profile-picture", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });
  req.user = user;

  avatarUpload.single("avatar")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ message: err.message || "Upload failed" });
    }
    if (!req.file) {
      return res.status(400).json({ message: "No file provided" });
    }

    const dbUser = users.find((u) => u.id === user.id);
    if (!dbUser) return res.status(404).json({ message: "User not found" });

    try {
      const baseName = `${user.id}-${Date.now()}`;
      const fullPath = path.join(AVATAR_DIR, `${baseName}.webp`);
      const thumbPath = path.join(AVATAR_DIR, `${baseName}-thumb.webp`);

      // Read the crop params from the request body (passed as form fields)
      const cropX = parseInt(req.body.cropX) || 0;
      const cropY = parseInt(req.body.cropY) || 0;
      const cropSize = parseInt(req.body.cropSize) || 0;

      let pipeline = sharp(req.file.path);

      // If crop params are provided, extract the region first
      if (cropSize > 0) {
        const meta = await sharp(req.file.path).metadata();
        const x = Math.max(0, Math.min(cropX, (meta.width || 0) - 1));
        const y = Math.max(0, Math.min(cropY, (meta.height || 0) - 1));
        const size = Math.min(cropSize, (meta.width || 0) - x, (meta.height || 0) - y);
        if (size > 0) {
          pipeline = pipeline.extract({ left: x, top: y, width: size, height: size });
        }
      }

      // Full size (256x256)
      await pipeline.clone().resize(256, 256, { fit: "cover" }).webp({ quality: 85 }).toFile(fullPath);

      // Thumbnail (64x64)
      await sharp(fullPath).resize(64, 64, { fit: "cover" }).webp({ quality: 75 }).toFile(thumbPath);

      // Delete the raw uploaded file
      try { fs.unlinkSync(req.file.path); } catch (_) {}

      // Delete old avatar files if they exist
      if (dbUser.profilePicture) {
        const oldFull = path.join(__dirname, "..", dbUser.profilePicture);
        try { fs.unlinkSync(oldFull); } catch (_) {}
      }
      if (dbUser.profilePictureThumbnail) {
        const oldThumb = path.join(__dirname, "..", dbUser.profilePictureThumbnail);
        try { fs.unlinkSync(oldThumb); } catch (_) {}
      }

      dbUser.profilePicture = `/uploads/avatars/${baseName}.webp`;
      dbUser.profilePictureThumbnail = `/uploads/avatars/${baseName}-thumb.webp`;
      saveUsers();

      // Broadcast update to all connected clients
      const io = req.app.get("io");
      if (io) {
        io.emit("user:profileUpdated", {
          userId: user.id,
          profilePicture: dbUser.profilePicture,
          profilePictureThumbnail: dbUser.profilePictureThumbnail,
          aboutMe: dbUser.aboutMe || "",
        });
      }

      res.json({
        profilePicture: dbUser.profilePicture,
        profilePictureThumbnail: dbUser.profilePictureThumbnail,
      });
    } catch (e) {
      // Clean up raw file on error
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      console.error("Avatar processing error:", e);
      res.status(500).json({ message: "Failed to process image" });
    }
  });
});

// Update profile (aboutMe, or remove profile picture)
router.put("/api/users/me/profile", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const dbUser = users.find((u) => u.id === user.id);
  if (!dbUser) return res.status(404).json({ message: "User not found" });

  const { aboutMe, removeProfilePicture } = req.body || {};

  if (typeof aboutMe === "string") {
    dbUser.aboutMe = aboutMe.slice(0, 200);
  }

  if (removeProfilePicture) {
    // Delete avatar files
    if (dbUser.profilePicture) {
      const oldFull = path.join(__dirname, "..", dbUser.profilePicture);
      try { fs.unlinkSync(oldFull); } catch (_) {}
    }
    if (dbUser.profilePictureThumbnail) {
      const oldThumb = path.join(__dirname, "..", dbUser.profilePictureThumbnail);
      try { fs.unlinkSync(oldThumb); } catch (_) {}
    }
    dbUser.profilePicture = null;
    dbUser.profilePictureThumbnail = null;
  }

  saveUsers();

  // Broadcast update
  const io = req.app.get("io");
  if (io) {
    io.emit("user:profileUpdated", {
      userId: user.id,
      profilePicture: dbUser.profilePicture || null,
      profilePictureThumbnail: dbUser.profilePictureThumbnail || null,
      aboutMe: dbUser.aboutMe || "",
    });
  }

  res.json({
    aboutMe: dbUser.aboutMe || "",
    profilePicture: dbUser.profilePicture || null,
    profilePictureThumbnail: dbUser.profilePictureThumbnail || null,
  });
});

// Get a user's profile
router.get("/api/users/:id/profile", (req, res) => {
  const authUser = getUserFromRequest(req);
  if (!authUser) return res.status(401).json({ message: "Unauthorized" });

  const target = users.find((u) => u.id === req.params.id);
  if (!target) return res.status(404).json({ message: "User not found" });

  res.json({
    id: target.id,
    username: target.username || "",
    profilePicture: target.profilePicture || null,
    profilePictureThumbnail: target.profilePictureThumbnail || null,
    aboutMe: target.aboutMe || "",
    createdAt: target.createdAt || null,
  });
});

// ------------------------------------------------------
//   E2EE KEY BUNDLE (ciphertext-only backup)
//   - Client encrypts their own keypair using a password-derived key (PBKDF2 / AES-GCM)
//   - Server stores ONLY the encrypted bundle; server cannot decrypt it
// ------------------------------------------------------

// Get current user's encrypted key bundle (if exists)
router.get("/api/users/me/key-bundle", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const dbUser = users.find((u) => u.id === user.id);
  if (!dbUser) return res.status(404).json({ message: "User not found" });

  const bundles = Array.isArray(dbUser.keyBundles)
    ? dbUser.keyBundles.filter(Boolean)
    : [];

  if (bundles.length > 0) {
    const latest = dbUser.keyBundle || bundles[bundles.length - 1] || bundles[0];
    return res.json({ bundles, bundle: latest });
  }

  if (!dbUser.keyBundle) {
    return res.status(404).json({ message: "No key bundle on server" });
  }

  return res.json({ bundles: [dbUser.keyBundle], bundle: dbUser.keyBundle });
});

// Store/overwrite current user's encrypted key bundle
router.post("/api/users/me/key-bundle", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const dbUser = users.find((u) => u.id === user.id);
  if (!dbUser) return res.status(404).json({ message: "User not found" });

  const { bundle } = req.body || {};
  if (!bundle || typeof bundle !== "object") {
    return res.status(400).json({ message: "bundle object required" });
  }

  // Basic validation to avoid garbage/huge payloads
  const {
    v,
    kdf,
    hash,
    iterations,
    salt,
    iv,
    ciphertext,
  } = bundle;

  if (v !== 1) return res.status(400).json({ message: "Unsupported bundle version" });
  if (kdf !== "PBKDF2") return res.status(400).json({ message: "Unsupported kdf" });
  if (hash !== "SHA-256") return res.status(400).json({ message: "Unsupported hash" });

  if (
    typeof iterations !== "number" ||
    !Number.isFinite(iterations) ||
    iterations < 100000
  ) {
    return res.status(400).json({ message: "Invalid iterations" });
  }

  if (
    typeof salt !== "string" ||
    typeof iv !== "string" ||
    typeof ciphertext !== "string" ||
    salt.length < 16 ||
    iv.length < 8 ||
    ciphertext.length < 16
  ) {
    return res.status(400).json({ message: "Invalid bundle fields" });
  }

  // Prevent oversized bundle abuse
  if (ciphertext.length > 25000) {
    return res.status(400).json({ message: "Bundle too large" });
  }

  const existing = Array.isArray(dbUser.keyBundles)
    ? dbUser.keyBundles.filter(Boolean)
    : [];

  const isDuplicate = existing.some(
    (b) =>
      b &&
      b.ciphertext === bundle.ciphertext &&
      b.iv === bundle.iv &&
      b.salt === bundle.salt &&
      b.iterations === bundle.iterations
  );

  const nextBundles = isDuplicate ? existing : [...existing, bundle];
  dbUser.keyBundles = nextBundles;
  dbUser.keyBundle = bundle;
  saveUsers();

  return res.json({ success: true, total: nextBundles.length });
});

// Store or update the current user's E2EE public key (JWK)
router.post("/api/users/keys", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  const { publicKey } = req.body || {};
  if (!publicKey) {
    return res.status(400).json({ message: "publicKey required" });
  }

  const dbUser = users.find((u) => u.id === user.id);
  if (!dbUser) {
    return res.status(404).json({ message: "User not found" });
  }

  dbUser.publicKey = publicKey;
  saveUsers();

  res.json({ success: true });
});

// Get a user's E2EE public key (for DM key derivation)
router.get("/api/users/:id/public-key", (req, res) => {
  const authUser = getUserFromRequest(req);
  if (!authUser) return res.status(401).json({ message: "Unauthorized" });

  const targetId = req.params.id;
  const target = users.find((u) => u.id === targetId);
  if (!target) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json({
    publicKey: target.publicKey || null,
  });
});

module.exports = router;
