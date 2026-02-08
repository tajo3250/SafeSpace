// src/pages/login.jsx
import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";

import { API_BASE } from "../config";
import BrandHeader from "../components/brand/BrandHeader";
import * as E2EE from "../utils/e2ee";
import { setAuth } from "../utils/authStorage";

// --- E2EE key bundle helpers (ciphertext-only backup) ---
const E2EE_LOCAL_KEY_PREFIX = "e2eeKeyPair:";

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}

function base64ToBytes(b64) {
  const binary = window.atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveAesKeyFromPassword(password, saltBytes, iterations) {
  const enc = new TextEncoder();
  const passKey = await window.crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return window.crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations,
      hash: "SHA-256",
    },
    passKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptJsonWithPassword(password, obj) {
  const iterations = 310000;
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await deriveAesKeyFromPassword(password, salt, iterations);

  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(obj));

  const ctBuf = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext);
  const ct = new Uint8Array(ctBuf);

  return {
    v: 1,
    kdf: "PBKDF2",
    hash: "SHA-256",
    iterations,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ct),
  };
}

async function decryptJsonWithPassword(password, bundle) {
  const salt = base64ToBytes(bundle.salt);
  const iv = base64ToBytes(bundle.iv);
  const ct = base64ToBytes(bundle.ciphertext);

  const aesKey = await deriveAesKeyFromPassword(password, salt, bundle.iterations);

  const ptBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ct);
  const dec = new TextDecoder();
  return JSON.parse(dec.decode(ptBuf));
}

async function generateEcdhKeyPair() {
  return window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"]
  );
}

async function exportKeyPairJwks(keyPair) {
  const [publicJwk, privateJwk] = await Promise.all([
    window.crypto.subtle.exportKey("jwk", keyPair.publicKey),
    window.crypto.subtle.exportKey("jwk", keyPair.privateKey),
  ]);
  return { publicJwk, privateJwk };
}

async function buildKeyRingFromJwks(publicJwk, privateJwk, createdAt) {
  const kid = await E2EE.computeKeyId(publicJwk);
  return {
    version: 2,
    currentKid: kid,
    keys: {
      [kid]: {
        publicJwk,
        privateJwk,
        createdAt: createdAt || new Date().toISOString(),
      },
    },
  };
}

function normalizeKeyRing(ring) {
  if (!ring || typeof ring !== "object") return null;
  const keys = ring.keys && typeof ring.keys === "object" ? ring.keys : {};
  const cleaned = {};

  for (const [kid, entry] of Object.entries(keys)) {
    if (!entry?.publicJwk || !entry?.privateJwk) continue;
    cleaned[kid] = {
      publicJwk: entry.publicJwk,
      privateJwk: entry.privateJwk,
      createdAt: entry.createdAt || new Date().toISOString(),
    };
  }

  const currentKid =
    ring.currentKid && cleaned[ring.currentKid] ? ring.currentKid : Object.keys(cleaned)[0] || null;
  if (!currentKid) return null;

  return {
    version: 2,
    currentKid,
    keys: cleaned,
  };
}

async function coerceKeyRing(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.keys && typeof payload.keys === "object") return normalizeKeyRing(payload);
  if (payload.publicJwk && payload.privateJwk) {
    return buildKeyRingFromJwks(payload.publicJwk, payload.privateJwk, payload.createdAt);
  }
  return null;
}

function mergeKeyRings(rings) {
  const merged = { version: 2, currentKid: null, keys: {} };

  for (const ring of rings) {
    const normalized = normalizeKeyRing(ring);
    if (!normalized) continue;

    for (const [kid, entry] of Object.entries(normalized.keys)) {
      if (!merged.keys[kid]) {
        merged.keys[kid] = entry;
      } else if (!merged.keys[kid].privateJwk && entry.privateJwk) {
        merged.keys[kid] = entry;
      }
    }

    if (normalized.currentKid && normalized.keys[normalized.currentKid]) {
      merged.currentKid = normalized.currentKid;
    }
  }

  if (!merged.currentKid) {
    merged.currentKid = Object.keys(merged.keys)[0] || null;
  }

  if (!merged.currentKid) return null;
  return merged;
}

function persistKeyRingToLocalStorage(userId, ring) {
  E2EE.persistKeyRingForUser(userId, ring);
}

// Ensure local E2EE keypair exists and is stable across domains by restoring from server bundle (ciphertext-only)
async function ensureE2EEKeysAfterLogin({ token, userId, password }) {
  if (!window.crypto || !window.crypto.subtle) return;
  const headers = { Authorization: `Bearer ${token}` };

  const fetchServerBundles = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/users/me/key-bundle`, { headers });
      if (!res.ok) return [];
      const data = await res.json();
      if (Array.isArray(data?.bundles)) return data.bundles;
      if (data?.bundle) return [data.bundle];
    } catch {
      // ignore
    }
    return [];
  };

  const uploadPublicKey = async (publicJwk) => {
    if (!publicJwk) return;
    await fetch(`${API_BASE}/api/users/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ publicKey: publicJwk }),
    });
  };

  const uploadKeyBundle = async (ring) => {
    if (!ring) return;
    const bundle = await encryptJsonWithPassword(password, ring);
    await fetch(`${API_BASE}/api/users/me/key-bundle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ bundle }),
    });
  };

  let localRing = E2EE.loadKeyRingForUser(userId);
  if (localRing) {
    localRing = normalizeKeyRing(localRing);
  }

  if (!localRing) {
    const legacyRaw = localStorage.getItem(`${E2EE_LOCAL_KEY_PREFIX}${userId}`);
    if (legacyRaw) {
      try {
        const parsed = JSON.parse(legacyRaw);
        if (parsed?.publicJwk && parsed?.privateJwk) {
          localRing = await buildKeyRingFromJwks(parsed.publicJwk, parsed.privateJwk);
          persistKeyRingToLocalStorage(userId, localRing);
        }
      } catch {
        // ignore
      }
    }
  }

  const serverBundles = await fetchServerBundles();
  const rings = [];
  const decryptedRings = [];
  let usedLegacyPayload = false;

  if (localRing) rings.push(localRing);

  if (serverBundles.length > 0) {
    for (const bundle of serverBundles) {
      try {
        const payload = await decryptJsonWithPassword(password, bundle);
        const ring = await coerceKeyRing(payload);
        if (ring) {
          decryptedRings.push(ring);
          rings.push(ring);
          if (!payload?.keys || typeof payload.keys !== "object") {
            usedLegacyPayload = true;
          }
        }
      } catch {
        // ignore bad bundle
      }
    }
  }

  if (rings.length > 0) {
    const merged = mergeKeyRings(rings);
    if (merged) {
      persistKeyRingToLocalStorage(userId, merged);
      const currentEntry = merged.keys?.[merged.currentKid];
      await uploadPublicKey(currentEntry?.publicJwk);

      const serverRing = decryptedRings.length === 1 ? decryptedRings[0] : null;
      const localHasExtraKeys =
        localRing && serverRing
          ? Object.keys(localRing.keys || {}).some((kid) => !serverRing.keys?.[kid])
          : false;

      const shouldUploadBundle =
        serverBundles.length === 0 ||
        decryptedRings.length === 0 ||
        decryptedRings.length > 1 ||
        usedLegacyPayload ||
        localHasExtraKeys;

      if (shouldUploadBundle) {
        await uploadKeyBundle(merged);
      }
      return;
    }
  }

  // No bundle and no usable local keys: create new stable keypair
  const kp = await generateEcdhKeyPair();
  const { publicJwk, privateJwk } = await exportKeyPairJwks(kp);
  const ring = await buildKeyRingFromJwks(publicJwk, privateJwk);

  persistKeyRingToLocalStorage(userId, ring);
  await uploadPublicKey(publicJwk);
  await uploadKeyBundle(ring);
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();
      if (!res.ok) return alert(data.message);

      setAuth(data.token, data.user, rememberMe);

      // E2EE: restore/create stable keys BEFORE entering chat (prevents key resets on new domains)
      try {
        await ensureE2EEKeysAfterLogin({
          token: data.token,
          userId: data.user.id,
          password,
        });
      } catch (e2eeErr) {
        console.error("E2EE login key setup failed:", e2eeErr);
        // Do not block login; user can still use unencrypted/global,
        // but encrypted chats may not work until keys are fixed.
      }

      navigate("/chat");
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px))] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl glass-panel p-6 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)]">
        <BrandHeader title="Welcome back" />

        <form onSubmit={handleLogin} className="flex flex-col gap-3 mt-6">
          <input
            type="email"
            placeholder="Email"
            className="p-3 rounded-xl bg-white/5 border border-white/10 text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.4)]"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <input
            type="password"
            placeholder="Password"
            className="p-3 rounded-xl bg-white/5 border border-white/10 text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.4)]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {/* Hide "Remember me" in desktop app - always persisted there */}
          {typeof window !== "undefined" && !window.electronAPI && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded border-white/20 bg-white/5 accent-[rgb(var(--ss-accent-rgb))]"
              />
              <span className="text-sm text-slate-300">Remember me</span>
            </label>
          )}

          <button
            type="submit"
            className="mt-2 w-full py-2.5 rounded-xl pill-accent bg-[rgb(var(--ss-accent-rgb))] text-slate-900 font-semibold shadow-[0_18px_60px_-40px_rgba(0,0,0,0.8)] hover:brightness-110 active:scale-[0.99] transition"
          >
            Login
          </button>
        </form>

        <div className="mt-4 text-sm">
          <Link className="text-[rgb(var(--ss-accent-rgb))] hover:underline" to="/signup">
            Don't have an account?
          </Link>
        </div>

        <div className="mt-2 text-sm">
          <Link className="text-[rgb(var(--ss-accent-rgb))] hover:underline" to="/forgot">
            Forgot password?
          </Link>
        </div>

        {/* Desktop app download link - always visible in browser */}
        {typeof window !== "undefined" && !window.electronAPI && (
          <div className="mt-5 pt-4 border-t border-white/10 text-center">
            <p className="text-xs text-slate-400 mb-2">Get the desktop app for the best experience</p>
            <Link
              to="/download"
              className="inline-block w-full py-2 rounded-xl bg-white/5 border border-white/10 text-sm text-[rgb(var(--ss-accent-rgb))] font-semibold hover:bg-white/10 transition"
            >
              Download SafeSpace
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
