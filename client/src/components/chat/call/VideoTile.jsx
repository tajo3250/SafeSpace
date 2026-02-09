// client/src/components/chat/call/VideoTile.jsx
// Renders a single participant's video/audio stream, or an avatar circle for voice-only.
// Screen shares use object-contain to fit the entire screen in frame.
// Click to focus, hover button or double-click for app fullscreen.

import React, { useRef, useEffect, useState } from "react";

export default function VideoTile({
  stream,
  userId,
  username,
  isMuted,
  isVideoOff,
  isScreenShare,
  isLocal,
  isSmall,
  isFocused,
  streamUpdateTick,
  onFocus,
  onExpand,
  profilePicture,
  onVolumeControl,
  onTheater,
}) {
  const videoRef = useRef(null);
  const [hasLiveVideo, setHasLiveVideo] = useState(false);
  const longPressTimerRef = useRef(null);

  // Attach stream to video element
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (stream) {
      el.srcObject = stream;
      el.play().catch(() => {});
    } else {
      el.srcObject = null;
    }

    return () => {
      if (el) el.srcObject = null;
    };
  }, [stream]);

  // Detect live video tracks (re-check on streamUpdateTick changes)
  useEffect(() => {
    if (!stream) {
      setHasLiveVideo(false);
      return;
    }
    const check = () => {
      const live = stream.getVideoTracks().some(
        (t) => t.enabled && t.readyState === "live" && !t.muted
      );
      setHasLiveVideo(live);
    };
    check();

    // Listen for track add/remove and mute/unmute on all video tracks
    stream.addEventListener("addtrack", check);
    stream.addEventListener("removetrack", check);
    const tracks = stream.getVideoTracks();
    for (const t of tracks) {
      t.addEventListener("mute", check);
      t.addEventListener("unmute", check);
    }

    // Periodic fallback (some browsers don't fire unmute reliably)
    const interval = setInterval(check, 1000);

    return () => {
      stream.removeEventListener("addtrack", check);
      stream.removeEventListener("removetrack", check);
      for (const t of tracks) {
        t.removeEventListener("mute", check);
        t.removeEventListener("unmute", check);
      }
      clearInterval(interval);
    };
  }, [stream, streamUpdateTick]);

  const initial = username ? username[0].toUpperCase() : "?";
  const showVideo = hasLiveVideo && !isVideoOff;

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        if (onFocus) onFocus();
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (onExpand) onExpand();
      }}
      onContextMenu={(e) => {
        if (isLocal || !onVolumeControl) return;
        e.preventDefault();
        e.stopPropagation();
        onVolumeControl(e.clientX, e.clientY);
      }}
      onTouchStart={(e) => {
        if (isLocal || !onVolumeControl) return;
        const touch = e.touches[0];
        longPressTimerRef.current = setTimeout(() => {
          onVolumeControl(touch.clientX, touch.clientY);
        }, 500);
      }}
      onTouchEnd={() => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); }}
      onTouchMove={() => { if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current); }}
      className={`relative flex items-center justify-center overflow-hidden rounded-2xl cursor-pointer group
        ${isSmall ? "h-28 w-40 shrink-0" : "h-full w-full min-h-[100px]"}
        ${isScreenShare ? "bg-black" : "bg-[#0a1220]/90"}
        border ${isFocused ? "border-[rgb(var(--ss-accent-rgb)/0.6)] ring-2 ring-[rgb(var(--ss-accent-rgb)/0.3)]" : "border-white/8 hover:border-white/20"}
        transition-all duration-200
      `}
    >
      {/* Always render the video — show/hide via opacity for seamless transitions */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={`absolute inset-0 h-full w-full transition-opacity duration-200
          ${showVideo ? "opacity-100" : "opacity-0 pointer-events-none"}
          ${isLocal && !isScreenShare ? "scale-x-[-1]" : ""}
          ${isScreenShare ? "object-contain" : "object-cover"}
        `}
        style={isScreenShare ? { background: "#000" } : undefined}
      />

      {/* Avatar fallback for voice-only / video-off */}
      {!showVideo && (
        <div className="flex flex-col items-center gap-2">
          {profilePicture ? (
            <img
              src={profilePicture}
              alt={username}
              className={`rounded-full object-cover border-2 border-[rgb(var(--ss-accent-rgb)/0.35)]
              ${isSmall ? "h-10 w-10" : "h-16 w-16"}`}
              draggable={false}
            />
          ) : (
            <div
              className={`rounded-full bg-[rgb(var(--ss-accent-rgb)/0.2)] border-2 border-[rgb(var(--ss-accent-rgb)/0.35)] flex items-center justify-center font-bold text-white
              ${isSmall ? "h-10 w-10 text-base" : "h-16 w-16 text-xl"}`}
            >
              {initial}
            </div>
          )}
          {!isSmall && (
            <span className="text-sm text-slate-400">{isLocal ? "You" : username}</span>
          )}
        </div>
      )}

      {/* Name + mute label */}
      <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 px-2 py-0.5 rounded-lg bg-black/60 backdrop-blur-sm">
        {isMuted && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="2" y1="2" x2="22" y2="22" />
            <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
            <path d="M5 10v2a7 7 0 0 0 12 5.29" />
            <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
          </svg>
        )}
        <span className="text-[11px] text-white/80 truncate max-w-[80px]">
          {isScreenShare ? username : isLocal ? "You" : username || "User"}
        </span>
      </div>

      {/* Theater mode button for screenshares (top-right, before expand) */}
      {isScreenShare && onTheater && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onTheater();
          }}
          className="absolute top-1.5 right-10 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center h-7 w-7 rounded-lg bg-black/50 hover:bg-black/70 text-white/80 backdrop-blur-sm"
          title="Theater Mode"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="M2 8h20" />
          </svg>
        </button>
      )}

      {/* Expand button (top-right, visible on hover) -- enters app fullscreen, not OS fullscreen */}
      {onExpand && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
          className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center h-7 w-7 rounded-lg bg-black/50 hover:bg-black/70 text-white/80 backdrop-blur-sm"
          title="Expand"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
        </button>
      )}
    </div>
  );
}
