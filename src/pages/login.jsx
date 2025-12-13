// src/pages/login.jsx
import React, { useState } from "react";
import { useNavigate, Link } from "react-router-dom";

const API_BASE = "https://lakisha-slumberless-deedee.ngrok-free.dev";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();
      if (!res.ok) return alert(data.message);

      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));

      navigate("/chat");
    } catch (err) {
      alert(err.message);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#0d1117] px-4">
      <div className="w-full max-w-sm bg-[#161b22] p-6 rounded-lg shadow">
        <h2 className="text-xl font-semibold text-white mb-4">Login</h2>

        <form onSubmit={handleLogin} className="flex flex-col gap-3">
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
            className="mt-2 bg-teal-500 hover:bg-teal-400 text-white font-semibold py-2 rounded"
          >
            Login
          </button>
        </form>

        <div className="mt-4 text-sm">
          <Link className="text-teal-400 hover:underline" to="/signup">
            Don't have an account?
          </Link>
        </div>

        <div className="mt-2 text-sm">
          <Link className="text-teal-400 hover:underline" to="/forgot">
            Forgot password?
          </Link>
        </div>
      </div>
    </div>
  );
}
