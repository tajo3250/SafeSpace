// routes/auth.js — register, verify email, login, password reset

const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const {
  users,
  resetTokens,
  saveUsers,
  saveResetTokens
} = require("../data/store");
const {
  SECRET_KEY,
  signUserToken,
  signVerificationToken
} = require("../utils/auth");
const { sendVerificationEmail, sendResetEmail } = require("../utils/email");

const router = express.Router();

// Health / root API
router.get("/api", (req, res) => {
  res.send("SafeSpace backend API is running.");
});

// REGISTER
router.post("/api/register", async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password)
    return res.status(400).json({ message: "Missing fields" });

  const usernameTaken = users.find(
    (u) => (u.username || "").toLowerCase() === username.toLowerCase()
  );
  if (usernameTaken)
    return res.status(400).json({ message: "Username already taken" });

  const existsEmail = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (existsEmail)
    return res.status(400).json({ message: "Email already in use" });

  const hash = await bcrypt.hash(password, 10);
  const user = {
    id: Date.now().toString(),
    username,
    email,
    passwordHash: hash,
    createdAt: new Date().toISOString(),
    verified: false
  };

  users.push(user);
  saveUsers();

  const token = signVerificationToken(user);

  try {
    await sendVerificationEmail(user, token);
  } catch (err) {
    console.error("Email error:", err.message);
  }

  res.json({ message: "Verification email sent." });
});

// VERIFY EMAIL
router.get("/api/verify-email", (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send("Missing token");

  try {
    const payload = jwt.verify(token, SECRET_KEY);
    if (payload.purpose !== "verify") throw new Error("Invalid token");

    const user = users.find((u) => u.id === payload.userId);
    if (!user) return res.status(404).send("User not found");

    user.verified = true;
    saveUsers();

    res.send("Email verified successfully. You may close this tab.");
  } catch (err) {
    res.status(400).send("Invalid or expired link.");
  }
});

// LOGIN
router.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  const user = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );
  if (!user)
    return res.status(400).json({ message: "Invalid email or password" });

  if (!user.verified)
    return res.status(403).json({ message: "Email not verified." });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok)
    return res.status(400).json({ message: "Invalid email or password" });

  const token = signUserToken(user);

  res.json({
    message: "Login successful",
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      createdAt: user.createdAt
    }
  });
});

// REQUEST PASSWORD RESET
router.post("/api/request-password-reset", async (req, res) => {
  const { email } = req.body;

  const user = users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase()
  );

  if (!user)
    return res.json({ message: "If that email exists, a reset link was sent." });

  const token = crypto.randomBytes(32).toString("hex");

  resetTokens.push({
    token,
    email,
    expires: Date.now() + 15 * 60 * 1000
  });
  saveResetTokens();

  try {
    await sendResetEmail(email, token);
  } catch (err) {
    console.error("Reset email error:", err);
  }

  res.json({ message: "If that email exists, a reset link was sent." });
});

// RESET PASSWORD
router.post("/api/reset-password", async (req, res) => {
  const { token, newPassword } = req.body;

  const entry = resetTokens.find((t) => t.token === token);
  if (!entry)
    return res.status(400).json({ message: "Invalid or expired token" });

  if (Date.now() > entry.expires)
    return res.status(400).json({ message: "Token expired" });

  const user = users.find(
    (u) => u.email.toLowerCase() === entry.email.toLowerCase()
  );
  if (!user)
    return res.status(400).json({ message: "User does not exist" });

  user.passwordHash = await bcrypt.hash(newPassword, 10);
  saveUsers();

  const newList = resetTokens.filter((t) => t.token !== token);
  resetTokens.length = 0;
  resetTokens.push(...newList);
  saveResetTokens();

  res.json({ message: "Password updated successfully." });
});

module.exports = router;
