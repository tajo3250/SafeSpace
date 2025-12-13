// src/pages/forgot.jsx
import React, { useState } from "react";
const API = "https://lakisha-slumberless-deedee.ngrok-free.dev";

export default function Forgot() {
  const [email, setEmail] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    await fetch(`${API}/api/request-password-reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    alert("If that email exists, a reset link has been sent.");
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d1117] px-4">
      <div className="w-full max-w-sm bg-[#161b22] p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold text-white mb-4">Reset Password</h2>

        <form onSubmit={submit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="Your email"
            className="p-2 rounded bg-[#0d1117] border border-slate-700 text-white"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <button
            type="submit"
            className="bg-teal-500 hover:bg-teal-400 text-white font-semibold py-2 rounded"
          >
            Send reset email
          </button>
        </form>
      </div>
    </div>
  );
}
