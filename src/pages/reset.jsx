// src/pages/reset.jsx
import React, { useState } from "react";
const API = "https://lakisha-slumberless-deedee.ngrok-free.dev";

export default function Reset() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const [password, setPassword] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    const res = await fetch(`${API}/api/reset-password`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, newPassword: password })
    });

    const data = await res.json();
    alert(data.message);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d1117] px-4">
      <div className="w-full max-w-sm bg-[#161b22] p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold text-white mb-4">Set New Password</h2>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="password"
            placeholder="New password"
            className="p-2 rounded bg-[#0d1117] border border-slate-700 text-white"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <button
            type="submit"
            className="bg-teal-500 hover:bg-teal-400 text-white font-semibold py-2 rounded"
          >
            Change password
          </button>
        </form>
      </div>
    </div>
  );
}
