// src/pages/signup.jsx
import React, { useState, useEffect } from "react";
import { useNavigate, Link } from "react-router-dom";
import { API_BASE } from "../config";
import BrandHeader from "../components/brand/BrandHeader";
import { getToken, getUser } from "../utils/authStorage";



export default function Signup() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    if (getToken() && getUser()) navigate("/chat", { replace: true });
  }, [navigate]);

  const handleSignup = async (e) => {
    e.preventDefault();
    const res = await fetch(`${API_BASE}/api/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password })
    });

    const data = await res.json();
    if (!res.ok) return alert(data.message);

    alert("Check email for verification.");
    navigate("/");
  };

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px))] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl glass-panel p-6 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)]">
        <BrandHeader title="Create account" subtitle="Claim your SafeSpace handle." />

        <form onSubmit={handleSignup} className="flex flex-col gap-3 mt-6">
          <input
            type="text"
            placeholder="Username"
            className="p-3 rounded-xl bg-white/5 border border-white/10 text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.4)]"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />

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

          <button
            type="submit"
            className="mt-2 w-full py-2.5 rounded-xl pill-accent bg-[rgb(var(--ss-accent-rgb))] text-slate-900 font-semibold shadow-[0_18px_60px_-40px_rgba(0,0,0,0.8)] hover:brightness-110 active:scale-[0.99] transition"
          >
            Sign Up
          </button>
        </form>

        <div className="mt-4 text-sm">
          <Link className="text-[rgb(var(--ss-accent-rgb))] hover:underline" to="/">
            Already have an account?
          </Link>
        </div>
      </div>
    </div>
  );
}
