// components/chat/UserProfilePopup.jsx
// Discord-style user profile popup shown on right-click of avatars.

import React, { useRef, useEffect } from "react";

export default function UserProfilePopup({ x, y, userId, allUsers, onClose, onStartDm, currentUserId }) {
  const menuRef = useRef(null);
  const user = allUsers?.find(u => u.id === userId);

  // Reposition if overflows viewport
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      el.style.left = `${Math.max(4, window.innerWidth - rect.width - 8)}px`;
    }
    if (rect.bottom > window.innerHeight) {
      el.style.top = `${Math.max(4, window.innerHeight - rect.height - 8)}px`;
    }
  }, [x, y]);

  // Close on outside click
  useEffect(() => {
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose();
    };
    const closeCtx = (e) => { e.preventDefault(); onClose(); };
    document.addEventListener("mousedown", close);
    document.addEventListener("contextmenu", closeCtx);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("contextmenu", closeCtx);
    };
  }, [onClose]);

  if (!user) return null;

  const initial = user.username?.[0]?.toUpperCase() || "?";
  const pic = user.profilePicture;
  const isSelf = userId === currentUserId;

  return (
    <div
      ref={menuRef}
      className="fixed z-[70] w-72 rounded-2xl bg-[var(--ss-brand-panel,#0c1425)] border border-[var(--ss-brand-outline,rgba(255,255,255,0.08))] shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      style={{ top: y, left: x }}
    >
      {/* Banner */}
      <div className="h-16 bg-gradient-to-br from-[rgb(var(--ss-accent-rgb)/0.25)] to-[rgb(var(--ss-accent-rgb)/0.05)]" />

      {/* Profile picture overlapping banner */}
      <div className="-mt-8 px-4">
        {pic ? (
          <img
            src={pic}
            alt={user.username}
            className="h-16 w-16 rounded-full border-4 border-[var(--ss-brand-panel,#0c1425)] object-cover"
          />
        ) : (
          <div className="h-16 w-16 rounded-full border-4 border-[var(--ss-brand-panel,#0c1425)] bg-[rgb(var(--ss-accent-rgb)/0.2)] flex items-center justify-center text-xl font-bold text-white">
            {initial}
          </div>
        )}
      </div>

      {/* User info */}
      <div className="px-4 pt-2 pb-4">
        <div className="text-base font-semibold text-white">{user.username || "Unknown"}</div>

        {user.aboutMe && (
          <div className="mt-2 p-2.5 rounded-lg bg-white/5 border border-white/8">
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">About Me</div>
            <div className="text-sm text-slate-300 whitespace-pre-wrap break-words">{user.aboutMe}</div>
          </div>
        )}

        {user.createdAt && (
          <div className="mt-2 text-xs text-slate-500">
            Member since {new Date(user.createdAt).toLocaleDateString(undefined, { month: "long", year: "numeric" })}
          </div>
        )}

        {/* Action buttons */}
        {!isSelf && onStartDm && (
          <div className="mt-3">
            <button
              onClick={() => { onStartDm(user.username); onClose(); }}
              className="w-full py-2 rounded-lg bg-[rgb(var(--ss-accent-rgb)/0.15)] hover:bg-[rgb(var(--ss-accent-rgb)/0.25)] border border-[rgb(var(--ss-accent-rgb)/0.3)] text-[rgb(var(--ss-accent-rgb))] text-sm font-semibold transition-all"
            >
              Message
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
