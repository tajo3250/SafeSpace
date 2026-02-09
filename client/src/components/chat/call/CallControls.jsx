// client/src/components/chat/call/CallControls.jsx
// Bottom control bar for active calls: Mute, Camera, Flip Camera, Screen Share, Expand, End Call.

import React from "react";

export default function CallControls({
  localAudioEnabled,
  localVideoEnabled,
  isScreenSharing,
  isExpanded,
  onToggleMute,
  onToggleVideo,
  onFlipCamera,
  onToggleScreenShare,
  onToggleExpand,
  onLeaveCall,
  isFullscreen,
  hasMultipleCameras,
}) {
  return (
    <div className="flex items-center justify-center gap-3 py-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
      {/* Mute / Unmute */}
      <button
        onClick={onToggleMute}
        title={localAudioEnabled ? "Mute" : "Unmute"}
        className={`inline-flex items-center justify-center h-12 w-12 rounded-full border transition-all
          ${localAudioEnabled
            ? "bg-white/10 hover:bg-white/20 border-white/10 text-slate-100"
            : "bg-red-500/30 hover:bg-red-500/40 border-red-500/40 text-red-200"
          }`}
      >
        {localAudioEnabled ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="2" y1="2" x2="22" y2="22" />
            <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
            <path d="M5 10v2a7 7 0 0 0 12 5.29" />
            <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
            <path d="M9 9v3a3 3 0 0 0 5.12 2.12" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
        )}
      </button>

      {/* Camera toggle */}
      <button
        onClick={onToggleVideo}
        title={localVideoEnabled ? "Turn off camera" : "Turn on camera"}
        className={`inline-flex items-center justify-center h-12 w-12 rounded-full border transition-all
          ${localVideoEnabled
            ? "bg-white/10 hover:bg-white/20 border-white/10 text-slate-100"
            : "bg-white/5 hover:bg-white/10 border-white/10 text-slate-400"
          }`}
      >
        {localVideoEnabled ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5" />
            <rect x="2" y="6" width="14" height="12" rx="2" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.66 5H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 6.87v10.19" />
            <path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        )}
      </button>

      {/* Flip Camera — only visible when video is on and device has multiple cameras */}
      {localVideoEnabled && hasMultipleCameras && (
        <button
          onClick={onFlipCamera}
          title="Flip camera"
          className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-slate-100 transition-all"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
            <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
            <polyline points="16 3 19 6 16 9" />
            <polyline points="8 21 5 18 8 15" />
          </svg>
        </button>
      )}

      {/* Screen Share */}
      <button
        onClick={onToggleScreenShare}
        title={isScreenSharing ? "Stop sharing" : "Share screen"}
        className={`inline-flex items-center justify-center h-12 w-12 rounded-full border transition-all
          ${isScreenSharing
            ? "bg-[rgb(var(--ss-accent-rgb)/0.3)] hover:bg-[rgb(var(--ss-accent-rgb)/0.4)] border-[rgb(var(--ss-accent-rgb)/0.5)] text-white"
            : "bg-white/10 hover:bg-white/20 border-white/10 text-slate-100"
          }`}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      </button>

      {/* Expand / Minimize */}
      <button
        onClick={onToggleExpand}
        title={isFullscreen ? "Exit fullscreen" : isExpanded ? "Fullscreen" : "Expand"}
        className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-white/10 hover:bg-white/20 border border-white/10 text-slate-100 transition-all"
      >
        {isFullscreen ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3v3a2 2 0 0 1-2 2H3" />
            <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
            <path d="M3 16h3a2 2 0 0 1 2 2v3" />
            <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
          </svg>
        ) : isExpanded ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6" />
            <path d="M9 21H3v-6" />
            <path d="M21 3l-7 7" />
            <path d="M3 21l7-7" />
          </svg>
        )}
      </button>

      {/* End Call */}
      <button
        onClick={onLeaveCall}
        title="End call"
        className="inline-flex items-center justify-center h-12 w-12 rounded-full bg-red-500/80 hover:bg-red-500 border border-red-400/50 text-white transition-all"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
          <line x1="23" y1="1" x2="1" y2="23" />
        </svg>
      </button>
    </div>
  );
}
