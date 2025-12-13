// utils/auth.js — JWT + request auth helpers

const jwt = require("jsonwebtoken");
const { users } = require("../data/store");

const SECRET_KEY = process.env.JWT_SECRET || "dev_secret";

function getUserFromRequest(req) {
  const auth = req.headers.authorization || "";
  const [, token] = auth.split(" ");
  if (!token) return null;

  try {
    const payload = jwt.verify(token, SECRET_KEY);
    return users.find((u) => u.id === payload.id) || null;
  } catch {
    return null;
  }
}

function signUserToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    SECRET_KEY,
    { expiresIn: "7d" }
  );
}

function verifySocketToken(token) {
  return jwt.verify(token, SECRET_KEY);
}

function signVerificationToken(user) {
  return jwt.sign(
    { userId: user.id, purpose: "verify" },
    SECRET_KEY,
    { expiresIn: "1d" }
  );
}

module.exports = {
  SECRET_KEY,
  getUserFromRequest,
  signUserToken,
  verifySocketToken,
  signVerificationToken
};
