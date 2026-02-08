// src/pages/reset.jsx
import React, { useState } from "react";
import { API_BASE } from "../config";
import BrandHeader from "../components/brand/BrandHeader";

export default function Reset() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const [password, setPassword] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    const res =    await fetch(`${API_BASE}/api/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: password })
    });

    const data = await res.json();
    alert(data.message);
  };

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px))] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl glass-panel p-6 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)]">
        <BrandHeader title="Set new password" subtitle="Choose a strong password to secure your account." />

        <form onSubmit={submit} className="flex flex-col gap-3 mt-6">
          <input
            type="password"
            placeholder="New password"
            className="p-3 rounded-xl bg-white/5 border border-white/10 text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.4)]"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <button
            type="submit"
            className="mt-2 w-full py-2.5 rounded-xl pill-accent bg-[rgb(var(--ss-accent-rgb))] text-slate-900 font-semibold shadow-[0_18px_60px_-40px_rgba(0,0,0,0.8)] hover:brightness-110 active:scale-[0.99] transition"
          >
            Change password
          </button>
        </form>
      </div>
    </div>
  );
}
