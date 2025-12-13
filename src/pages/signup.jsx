// src/pages/signup.jsx
import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";

const API_BASE = "https://lakisha-slumberless-deedee.ngrok-free.dev";

export default function Signup() {
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

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
    <div className="min-h-screen flex items-center justify-center bg-[#0d1117] px-4">
      <div className="w-full max-w-sm bg-[#161b22] p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold text-white mb-4">Create Account</h2>

        <form onSubmit={handleSignup} className="flex flex-col gap-3">
          <input
            type="text"
            placeholder="Username"
            className="p-2 rounded bg-[#0d1117] border border-slate-700 text-white"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />

          <input
            type="email"
            placeholder="Email"
            className="p-2 rounded bg-[#0d1117] border border-slate-700 text-white"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <input
            type="password"
            placeholder="Password"
            className="p-2 rounded bg-[#0d1117] border border-slate-700 text-white"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <button
            type="submit"
            className="bg-teal-500 hover:bg-teal-400 text-white font-semibold py-2 rounded"
          >
            Sign Up
          </button>
        </form>

        <div className="mt-4 text-sm">
          <Link className="text-teal-400 hover:underline" to="/">
            Already have an account?
          </Link>
        </div>
      </div>
    </div>
  );
}
