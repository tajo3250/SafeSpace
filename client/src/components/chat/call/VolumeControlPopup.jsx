// components/chat/call/VolumeControlPopup.jsx
// Right-click/long-press popup for per-user volume control in calls.

import React, { useRef, useEffect, useCallback, useState } from "react";

export default function VolumeControlPopup({ x, y, userId, username, profilePicture, volume, onVolumeChange, onClose }) {
  const menuRef = useRef(null);
  const [prevVolume, setPrevVolume] = useState(volume > 0 ? volume : 1.0);
  const isMuted = volume === 0;

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

  const handleMuteToggle = useCallback(() => {
    if (isMuted) {
      onVolumeChange(prevVolume);
    } else {
      setPrevVolume(volume);
      onVolumeChange(0);
    }
  }, [isMuted, volume, prevVolume, onVolumeChange]);

  const volumePercent = Math.round(volume * 100);

  return (
    <div
      ref={menuRef}
      className="fixed z-[70] w-60 rounded-2xl bg-[var(--ss-brand-panel,#0c1425)] border border-[var(--ss-brand-outline,rgba(255,255,255,0.08))] shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)] overflow-hidden animate-in fade-in zoom-in-95 duration-150"
      style={{ top: y, left: x }}
    >
      {/* User header */}
      <div className="flex items-center gap-3 p-3 border-b border-white/8">
        {profilePicture ? (
          <img src={profilePicture} alt={username} className="h-9 w-9 rounded-full object-cover shrink-0" />
        ) : (
          <div className="h-9 w-9 rounded-full bg-[rgb(var(--ss-accent-rgb)/0.2)] flex items-center justify-center text-sm font-bold text-white shrink-0">
            {username?.[0]?.toUpperCase() || "?"}
          </div>
        )}
        <div className="min-w-0">
          <div className="text-sm font-semibold text-white truncate">{username || "User"}</div>
          <div className="text-xs text-slate-500">User Volume</div>
        </div>
      </div>

      {/* Volume slider */}
      <div className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-xs text-slate-400">Volume</label>
          <span className={`text-xs font-medium ${isMuted ? "text-red-400" : "text-slate-300"}`}>
            {isMuted ? "Muted" : `${volumePercent}%`}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="200"
          step="5"
          value={volumePercent}
          onChange={(e) => onVolumeChange(Number(e.target.value) / 100)}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer accent-[rgb(var(--ss-accent-rgb))]"
          style={{
            background: `linear-gradient(to right, rgb(var(--ss-accent-rgb)) 0%, rgb(var(--ss-accent-rgb)) ${volumePercent / 2}%, rgba(255,255,255,0.1) ${volumePercent / 2}%, rgba(255,255,255,0.1) 100%)`,
          }}
        />

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            onClick={handleMuteToggle}
            className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all ${
              isMuted
                ? "bg-red-500/20 text-red-300 hover:bg-red-500/30 border border-red-500/20"
                : "bg-white/5 text-slate-300 hover:bg-white/10 border border-white/8"
            }`}
          >
            {isMuted ? "Unmute" : "Mute"}
          </button>
          <button
            onClick={() => onVolumeChange(1.0)}
            className="flex-1 py-1.5 rounded-lg bg-white/5 border border-white/8 text-slate-300 text-xs font-medium hover:bg-white/10 transition-all"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
