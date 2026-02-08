// client/src/components/chat/call/IncomingCallModal.jsx
// Full-screen overlay for incoming call notification with accept/reject.
// Plays ringtone from /sounds/ringtone.mp3 (replaceable with custom MP3).

import React, { useEffect, useRef } from "react";

export default function IncomingCallModal({
  incomingCall,
  onAccept,
  onReject,
  allUsers,
}) {
  const audioRef = useRef(null);

  useEffect(() => {
    if (!incomingCall) return;

    // Play the ringtone MP3 file (user can replace with their own)
    const audio = new Audio("/sounds/ringtone.mp3");
    audio.loop = true;
    audio.volume = 0.7;
    audio.play().catch(() => {});
    audioRef.current = audio;

    // Vibration pattern for mobile
    let vibrationInterval;
    if ("vibrate" in navigator) {
      const vibrate = () => navigator.vibrate([200, 100, 200, 100, 200]);
      vibrate();
      vibrationInterval = setInterval(vibrate, 2000);
    }

    // Request notification permission and show
    if ("Notification" in window && Notification.permission === "granted") {
      try {
        new Notification("SafeSpace", {
          body: `Incoming ${incomingCall.type} call from ${incomingCall.callerName}`,
          tag: "incoming-call",
          requireInteraction: true,
        });
      } catch {
        // ignore
      }
    } else if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
        audioRef.current = null;
      }
      if (vibrationInterval) clearInterval(vibrationInterval);
      if ("vibrate" in navigator) navigator.vibrate(0);
    };
  }, [incomingCall]);

  if (!incomingCall) return null;

  const { callerName, type } = incomingCall;
  const initial = callerName ? callerName[0].toUpperCase() : "?";

  return (
    <div className="fixed inset-0 z-[55] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-[#0c111d]/95 border border-white/10 overflow-hidden shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)] backdrop-blur-2xl">
        <div className="flex flex-col items-center py-8 px-6">
          {/* Pulsing avatar */}
          <div className="relative mb-5">
            <div className="call-pulse h-20 w-20 rounded-full bg-[rgb(var(--ss-accent-rgb)/0.2)] border-2 border-[rgb(var(--ss-accent-rgb)/0.4)] flex items-center justify-center text-2xl font-bold text-white">
              {initial}
            </div>
          </div>

          <div className="text-lg font-semibold text-white mb-1">{callerName}</div>
          <div className="text-sm text-slate-400 mb-6">
            Incoming {type === "video" ? "video" : "voice"} call
          </div>

          <div className="flex items-center gap-8">
            <button onClick={onReject} className="flex flex-col items-center gap-1.5">
              <span className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-red-500/80 hover:bg-red-500 border border-red-400/40 text-white transition-all">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                  <line x1="23" y1="1" x2="1" y2="23" />
                </svg>
              </span>
              <span className="text-xs text-slate-500">Decline</span>
            </button>

            <button onClick={onAccept} className="flex flex-col items-center gap-1.5">
              <span className="inline-flex items-center justify-center h-14 w-14 rounded-full bg-green-500/80 hover:bg-green-500 border border-green-400/40 text-white transition-all">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
                </svg>
              </span>
              <span className="text-xs text-slate-500">Accept</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
