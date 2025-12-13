// routes/users.js — list users (no emails exposed) + E2EE public keys

const express = require("express");
const { users, saveUsers } = require("../data/store");
const { getUserFromRequest } = require("../utils/auth");

const router = express.Router();

// List all users (basic info, username only)
router.get("/api/users", (req, res) => {
  const user = getUserFromRequest(req);
  if (!user) return res.status(401).json({ message: "Unauthorized" });

  res.json(
    users.map((u) => ({
      id: u.id,
      username: u.username || "",
    }))
  );
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
