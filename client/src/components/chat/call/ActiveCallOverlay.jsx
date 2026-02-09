// client/src/components/chat/call/ActiveCallOverlay.jsx
// Discord-style call UI with focus support.
// - Click any tile to focus it (large view + strip of others)
// - Double-click or hover-button for app fullscreen (not OS fullscreen)
// - Supports multiple simultaneous screen shares
// - Desktop screenshare resolution/FPS picker
// - Per-user volume control via Web Audio API GainNode
// - Theater mode for screenshares (fills entire window, auto-hiding controls)

import React, { useState, useEffect, useRef, useCallback } from "react";
import CallControls from "./CallControls";
import VideoTile from "./VideoTile";
import VolumeControlPopup from "./VolumeControlPopup";

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

const VOLUMES_STORAGE_KEY = "ss_user_call_volumes";

// Per-user audio playback via Web Audio API GainNode
function HiddenAudio({ stream, volume = 1.0 }) {
  const audioCtxRef = useRef(null);
  const gainRef = useRef(null);
  const sourceRef = useRef(null);

  useEffect(() => {
    if (!stream) return;
    // Only connect audio tracks
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      audioCtx.resume().catch(() => {});
    }
    const source = audioCtx.createMediaStreamSource(stream);
    const gain = audioCtx.createGain();
    gain.gain.value = volume;
    source.connect(gain);
    gain.connect(audioCtx.destination);

    audioCtxRef.current = audioCtx;
    gainRef.current = gain;
    sourceRef.current = source;

    return () => {
      try { source.disconnect(); } catch (_) {}
      try { gain.disconnect(); } catch (_) {}
      audioCtx.close().catch(() => {});
      audioCtxRef.current = null;
      gainRef.current = null;
      sourceRef.current = null;
    };
  }, [stream]);

  // Update gain when volume prop changes
  useEffect(() => {
    if (gainRef.current) {
      gainRef.current.gain.value = volume;
    }
  }, [volume]);

  return null;
}

function HiddenAudioRenderer({ remoteStreams, userVolumes }) {
  return (
    <>
      {Object.entries(remoteStreams).map(([userId, stream]) => (
        <HiddenAudio key={userId} stream={stream} volume={userVolumes?.[userId] ?? 1.0} />
      ))}
    </>
  );
}

// Screen share resolution/FPS picker for desktop
const RESOLUTION_OPTIONS = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "Native", width: 3840, height: 2160 },
];

const FPS_OPTIONS = [
  { label: "30", value: 30 },
  { label: "60", value: 60 },
  { label: "90", value: 90 },
  { label: "Native", value: 0 },
];

function ScreenSharePicker({ onStart, onCancel }) {
  const [resIdx, setResIdx] = useState(1); // default 1080p
  const [fpsIdx, setFpsIdx] = useState(0); // default 30

  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-10 w-72 rounded-2xl border border-white/10 bg-[#0c1425]/95 backdrop-blur-xl shadow-2xl p-4">
      <div className="text-sm font-semibold text-slate-200 mb-3">Screen Share Settings</div>

      {/* Resolution */}
      <div className="mb-3">
        <div className="text-xs text-slate-400 mb-1.5">Resolution</div>
        <div className="flex gap-1.5">
          {RESOLUTION_OPTIONS.map((opt, i) => (
            <button
              key={opt.label}
              onClick={() => setResIdx(i)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all
                ${i === resIdx
                  ? "bg-[rgb(var(--ss-accent-rgb)/0.3)] border border-[rgb(var(--ss-accent-rgb)/0.5)] text-white"
                  : "bg-white/5 border border-white/8 text-slate-400 hover:bg-white/10"
                }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* FPS */}
      <div className="mb-4">
        <div className="text-xs text-slate-400 mb-1.5">Frame Rate</div>
        <div className="flex gap-1.5">
          {FPS_OPTIONS.map((opt, i) => (
            <button
              key={opt.label}
              onClick={() => setFpsIdx(i)}
              className={`flex-1 py-1.5 rounded-lg text-xs font-medium transition-all
                ${i === fpsIdx
                  ? "bg-[rgb(var(--ss-accent-rgb)/0.3)] border border-[rgb(var(--ss-accent-rgb)/0.5)] text-white"
                  : "bg-white/5 border border-white/8 text-slate-400 hover:bg-white/10"
                }`}
            >
              {opt.label === "Native" ? "Native" : `${opt.label} fps`}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 py-2 rounded-lg bg-white/5 border border-white/10 text-slate-300 text-sm hover:bg-white/10 transition-all"
        >
          Cancel
        </button>
        <button
          onClick={() => {
            const res = RESOLUTION_OPTIONS[resIdx];
            const fps = FPS_OPTIONS[fpsIdx];
            onStart({
              width: res.width,
              height: res.height,
              fps: fps.value || undefined,
            });
          }}
          className="flex-1 py-2 rounded-lg bg-[rgb(var(--ss-accent-rgb)/0.6)] hover:bg-[rgb(var(--ss-accent-rgb)/0.8)] border border-[rgb(var(--ss-accent-rgb)/0.5)] text-white text-sm font-semibold transition-all"
        >
          Share Screen
        </button>
      </div>
    </div>
  );
}

export default function ActiveCallOverlay({
  callState,
  localStream,
  screenStream,
  remoteStreams,
  remoteMediaState,
  streamUpdateTick,
  onToggleMute,
  onToggleVideo,
  onFlipCamera,
  onToggleScreenShare,
  onLeaveCall,
  allUsers,
  conversationLabel,
  hasMultipleCameras,
}) {
  const [fullscreen, setFullscreen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [focusedTileId, setFocusedTileId] = useState(null);
  const [showScreenSharePicker, setShowScreenSharePicker] = useState(false);

  // Theater mode state
  const [theaterMode, setTheaterMode] = useState(false);
  const [theaterControlsVisible, setTheaterControlsVisible] = useState(true);
  const theaterTimeoutRef = useRef(null);
  const theaterVideoRef = useRef(null);

  // Per-user volume control
  const [userVolumes, setUserVolumes] = useState(() => {
    try {
      const raw = localStorage.getItem(VOLUMES_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  });

  // Volume control popup
  const [volumePopup, setVolumePopup] = useState(null); // { x, y, userId, username, profilePicture }

  // Persist volumes
  useEffect(() => {
    try { localStorage.setItem(VOLUMES_STORAGE_KEY, JSON.stringify(userVolumes)); } catch {}
  }, [userVolumes]);

  useEffect(() => {
    if (!callState?.startedAt) return;
    const interval = setInterval(() => {
      setElapsed(Date.now() - callState.startedAt);
    }, 1000);
    return () => clearInterval(interval);
  }, [callState?.startedAt]);

  if (!callState) return null;

  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  const getUserName = (uid) => {
    const u = allUsers?.find((x) => x.id === uid);
    return u?.username || "User";
  };

  const getUserPic = (uid) => {
    const u = allUsers?.find((x) => x.id === uid);
    return u?.profilePictureThumbnail || u?.profilePicture || null;
  };

  const remoteUserIds = Object.keys(remoteStreams);
  const isLocalScreenSharing = callState.isScreenSharing;

  // Build list of all tiles
  const tiles = [];

  // Local camera tile
  const currentUserPic = allUsers?.find(x => x.id === callState.userId)?.profilePictureThumbnail ||
                          allUsers?.find(x => x.id === callState.userId)?.profilePicture || null;
  tiles.push({
    id: "local",
    stream: localStream,
    username: "You",
    isMuted: !callState.localAudioEnabled,
    isVideoOff: !callState.localVideoEnabled,
    isScreenShare: false,
    isLocal: true,
    profilePicture: currentUserPic,
  });

  // Local screen share tile
  if (isLocalScreenSharing && screenStream) {
    tiles.push({
      id: "local-screen",
      stream: screenStream,
      username: "Your Screen",
      isMuted: false,
      isVideoOff: false,
      isScreenShare: true,
      isLocal: true,
      profilePicture: null,
    });
  }

  // Remote user tiles
  for (const uid of remoteUserIds) {
    const ms = remoteMediaState[uid];
    const isRemoteScreenShare = ms?.screen === true;

    tiles.push({
      id: uid,
      stream: remoteStreams[uid],
      username: isRemoteScreenShare ? `${getUserName(uid)}'s Screen` : getUserName(uid),
      isMuted: ms && !ms.audio,
      isVideoOff: !isRemoteScreenShare && ms && !ms.video,
      isScreenShare: isRemoteScreenShare,
      isLocal: false,
      profilePicture: isRemoteScreenShare ? null : getUserPic(uid),
    });
  }

  const participantCount = tiles.filter((t) => !t.isScreenShare).length;

  // Auto-focus screen shares when they start
  const screenShareTileIds = tiles.filter((t) => t.isScreenShare).map((t) => t.id);
  const prevScreenSharesRef = useRef([]);
  useEffect(() => {
    const prev = prevScreenSharesRef.current;
    const newScreenShares = screenShareTileIds.filter((id) => !prev.includes(id));
    if (newScreenShares.length > 0) {
      setFocusedTileId(newScreenShares[0]);
    }
    prevScreenSharesRef.current = screenShareTileIds;
  }, [screenShareTileIds.join(",")]);

  // Clear focus if the focused tile no longer exists; also exit theater
  useEffect(() => {
    if (focusedTileId && !tiles.some((t) => t.id === focusedTileId)) {
      setFocusedTileId(null);
      setTheaterMode(false);
    }
  }, [focusedTileId, tiles.length]);

  const handleFocus = useCallback((tileId) => {
    setFocusedTileId((prev) => (prev === tileId ? null : tileId));
  }, []);

  // App fullscreen: focus the tile and enter fullscreen mode within the app
  const handleExpand = useCallback((tileId) => {
    setFocusedTileId(tileId);
    setFullscreen(true);
  }, []);

  // Theater mode: for screenshares, fills entire window
  const handleTheater = useCallback((tileId) => {
    setFocusedTileId(tileId);
    setTheaterMode(true);
    setTheaterControlsVisible(true);
    // Start auto-hide timer
    if (theaterTimeoutRef.current) clearTimeout(theaterTimeoutRef.current);
    theaterTimeoutRef.current = setTimeout(() => setTheaterControlsVisible(false), 3000);
  }, []);

  const handleTheaterMouseMove = useCallback(() => {
    setTheaterControlsVisible(true);
    if (theaterTimeoutRef.current) clearTimeout(theaterTimeoutRef.current);
    theaterTimeoutRef.current = setTimeout(() => setTheaterControlsVisible(false), 3000);
  }, []);

  // Cleanup theater timeout
  useEffect(() => {
    return () => {
      if (theaterTimeoutRef.current) clearTimeout(theaterTimeoutRef.current);
    };
  }, []);

  // Escape key exits theater mode
  useEffect(() => {
    if (!theaterMode) return;
    const handleKey = (e) => {
      if (e.key === "Escape") {
        setTheaterMode(false);
        if (theaterTimeoutRef.current) clearTimeout(theaterTimeoutRef.current);
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [theaterMode]);

  // Attach theater video stream
  useEffect(() => {
    const el = theaterVideoRef.current;
    if (!el || !theaterMode) return;
    const theaterTile = tiles.find(t => t.id === focusedTileId);
    if (theaterTile?.stream) {
      el.srcObject = theaterTile.stream;
      el.play().catch(() => {});
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [theaterMode, focusedTileId, tiles, streamUpdateTick]);

  // Screen share handler: show picker on desktop, start directly on mobile
  const handleScreenShareClick = useCallback(() => {
    if (callState.isScreenSharing) {
      onToggleScreenShare();
      return;
    }
    if (isMobile) {
      onToggleScreenShare();
    } else {
      setShowScreenSharePicker(true);
    }
  }, [callState.isScreenSharing, isMobile, onToggleScreenShare]);

  const handleScreenShareStart = useCallback((settings) => {
    setShowScreenSharePicker(false);
    onToggleScreenShare(settings);
  }, [onToggleScreenShare]);

  // Volume control handlers
  const handleVolumeControl = useCallback((tileId, username, profilePicture, x, y) => {
    setVolumePopup({ x, y, userId: tileId, username, profilePicture });
  }, []);

  const handleVolumeChange = useCallback((userId, volume) => {
    setUserVolumes(prev => ({ ...prev, [userId]: volume }));
  }, []);

  // Grid class for video tiles
  const getGridClass = (count) => {
    if (count <= 1) return "grid-cols-1";
    if (count <= 4) return "grid-cols-2";
    return "grid-cols-3";
  };

  // Helper to render tile props
  const tileProps = (tile, isSmall, isFocused, inFullscreen) => ({
    stream: tile.stream,
    userId: tile.id,
    username: tile.username,
    isMuted: tile.isMuted,
    isVideoOff: tile.isVideoOff,
    isScreenShare: tile.isScreenShare,
    isLocal: tile.isLocal,
    isSmall,
    isFocused,
    streamUpdateTick,
    profilePicture: tile.profilePicture,
    onFocus: () => handleFocus(tile.id),
    onExpand: !inFullscreen ? () => handleExpand(tile.id) : undefined,
    onTheater: tile.isScreenShare ? () => handleTheater(tile.id) : undefined,
    onVolumeControl: tile.isLocal ? undefined : (x, y) =>
      handleVolumeControl(tile.id, tile.username, tile.profilePicture, x, y),
  });

  // --- Outgoing call state ---
  if (callState.status === "outgoing") {
    return (
      <>
        <HiddenAudioRenderer remoteStreams={remoteStreams} userVolumes={userVolumes} />
        <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-white/8 bg-[rgb(var(--ss-accent-rgb)/0.08)]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="h-2 w-2 rounded-full bg-[rgb(var(--ss-accent-rgb))] animate-pulse shrink-0" />
            <span className="text-sm text-slate-200 shrink-0">
              Calling{callState.type === "video" ? " (video)" : ""}...
            </span>
            <span className="text-xs text-slate-400 truncate">{conversationLabel}</span>
          </div>
          <button
            onClick={onLeaveCall}
            className="shrink-0 inline-flex items-center justify-center h-8 w-8 rounded-full bg-red-500/80 hover:bg-red-500 text-white transition-all"
            title="Cancel"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
              <line x1="23" y1="1" x2="1" y2="23" />
            </svg>
          </button>
        </div>
      </>
    );
  }

  // --- Video grid rendering ---
  const renderVideoGrid = (heightClass, inFullscreen) => {
    const focusedTile = focusedTileId ? tiles.find((t) => t.id === focusedTileId) : null;

    // Focused layout: one big tile + strip of others at bottom
    if (focusedTile) {
      const otherTiles = tiles.filter((t) => t.id !== focusedTileId);
      return (
        <div className={`flex flex-col gap-2 ${heightClass}`}>
          <div className="flex-1 min-h-0">
            <VideoTile {...tileProps(focusedTile, false, true, inFullscreen)} />
          </div>
          {otherTiles.length > 0 && (
            <div className="shrink-0 flex gap-2 overflow-x-auto py-1">
              {otherTiles.map((tile) => (
                <VideoTile key={tile.id} {...tileProps(tile, true, false, inFullscreen)} />
              ))}
            </div>
          )}
        </div>
      );
    }

    // Grid layout: no focused tile
    return (
      <div className={`grid ${getGridClass(tiles.length)} gap-2 ${heightClass}`}>
        {tiles.map((tile) => (
          <VideoTile key={tile.id} {...tileProps(tile, false, false, inFullscreen)} />
        ))}
      </div>
    );
  };

  // Shared call controls props
  const controlsProps = {
    localAudioEnabled: callState.localAudioEnabled,
    localVideoEnabled: callState.localVideoEnabled,
    isScreenSharing: callState.isScreenSharing,
    isExpanded: true,
    onToggleMute,
    onToggleVideo,
    onFlipCamera,
    onToggleScreenShare: handleScreenShareClick,
    onLeaveCall,
    hasMultipleCameras,
  };

  // --- Theater mode (screenshare fills entire window) ---
  if (theaterMode && focusedTileId) {
    const theaterTile = tiles.find(t => t.id === focusedTileId);
    if (!theaterTile) {
      setTheaterMode(false);
    } else {
      return (
        <>
          <HiddenAudioRenderer remoteStreams={remoteStreams} userVolumes={userVolumes} />
          <div
            className="fixed inset-0 z-[56] bg-black flex flex-col"
            onMouseMove={handleTheaterMouseMove}
            onTouchStart={handleTheaterMouseMove}
            style={{ cursor: theaterControlsVisible ? "default" : "none" }}
          >
            {/* Screenshare fills entire viewport */}
            <div className="flex-1 min-h-0 relative">
              <video
                ref={theaterVideoRef}
                autoPlay
                playsInline
                muted
                className="absolute inset-0 h-full w-full object-contain bg-black"
              />
            </div>

            {/* Auto-hiding controls overlay */}
            <div className={`absolute bottom-0 left-0 right-0 transition-all duration-300 ${
              theaterControlsVisible
                ? "opacity-100 translate-y-0"
                : "opacity-0 translate-y-4 pointer-events-none"
            }`}>
              <div className="bg-gradient-to-t from-black/90 to-transparent pt-16 pb-4 px-4">
                {/* Info bar */}
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse" />
                    <span className="text-sm text-white/80">{theaterTile.username}</span>
                    <span className="text-xs text-slate-500 font-mono">{formatDuration(elapsed)}</span>
                    <span className="text-xs text-slate-500">{participantCount}p</span>
                  </div>
                  <button
                    onClick={() => {
                      setTheaterMode(false);
                      if (theaterTimeoutRef.current) clearTimeout(theaterTimeoutRef.current);
                    }}
                    className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-all"
                  >
                    Exit Theater
                  </button>
                </div>
                {/* Call controls */}
                <div className="relative">
                  {showScreenSharePicker && (
                    <ScreenSharePicker
                      onStart={handleScreenShareStart}
                      onCancel={() => setShowScreenSharePicker(false)}
                    />
                  )}
                  <CallControls
                    {...controlsProps}
                    onToggleExpand={() => {
                      setTheaterMode(false);
                      if (theaterTimeoutRef.current) clearTimeout(theaterTimeoutRef.current);
                    }}
                    isFullscreen={true}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Volume popup */}
          {volumePopup && (
            <VolumeControlPopup
              x={volumePopup.x}
              y={volumePopup.y}
              userId={volumePopup.userId}
              username={volumePopup.username}
              profilePicture={volumePopup.profilePicture}
              volume={userVolumes[volumePopup.userId] ?? 1.0}
              onVolumeChange={(v) => handleVolumeChange(volumePopup.userId, v)}
              onClose={() => setVolumePopup(null)}
            />
          )}
        </>
      );
    }
  }

  // --- Fullscreen overlay (within app, not OS fullscreen) ---
  if (fullscreen) {
    return (
      <>
        <HiddenAudioRenderer remoteStreams={remoteStreams} userVolumes={userVolumes} />
        <div className="fixed inset-0 z-[54] bg-[#060a14]/98 flex flex-col">
          {/* Header */}
          <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-white/8">
            <div className="flex items-center gap-3 min-w-0">
              <div className="h-2.5 w-2.5 rounded-full bg-green-400 animate-pulse shrink-0" />
              <span className="text-sm font-medium text-slate-200 truncate">{conversationLabel}</span>
              <span className="text-xs text-slate-500 shrink-0">{participantCount} participant{participantCount !== 1 ? "s" : ""}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-sm text-slate-400 font-mono">{formatDuration(elapsed)}</span>
              <button
                onClick={() => setFullscreen(false)}
                className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-white/8 hover:bg-white/14 text-slate-200 transition-all"
                title="Exit fullscreen"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 3v3a2 2 0 0 1-2 2H3" />
                  <path d="M21 8h-3a2 2 0 0 1-2-2V3" />
                  <path d="M3 16h3a2 2 0 0 1 2 2v3" />
                  <path d="M16 21v-3a2 2 0 0 1 2-2h3" />
                </svg>
              </button>
            </div>
          </div>

          {/* Video grid */}
          <div className="flex-1 min-h-0 p-3">
            {renderVideoGrid("h-full", true)}
          </div>

          {/* Controls */}
          <div className="shrink-0 border-t border-white/8 bg-[#0a1220]/80 backdrop-blur-xl relative">
            {showScreenSharePicker && (
              <ScreenSharePicker
                onStart={handleScreenShareStart}
                onCancel={() => setShowScreenSharePicker(false)}
              />
            )}
            <CallControls
              {...controlsProps}
              onToggleExpand={() => setFullscreen(false)}
              isFullscreen={true}
            />
          </div>
        </div>

        {/* Volume popup */}
        {volumePopup && (
          <VolumeControlPopup
            x={volumePopup.x}
            y={volumePopup.y}
            userId={volumePopup.userId}
            username={volumePopup.username}
            profilePicture={volumePopup.profilePicture}
            volume={userVolumes[volumePopup.userId] ?? 1.0}
            onVolumeChange={(v) => handleVolumeChange(volumePopup.userId, v)}
            onClose={() => setVolumePopup(null)}
          />
        )}
      </>
    );
  }

  // --- Active call: always-visible inline panel ---
  return (
    <>
      <HiddenAudioRenderer remoteStreams={remoteStreams} userVolumes={userVolumes} />

      {callState.status === "active" && (
        <div className="shrink-0 border-b border-white/8 bg-[#060a14]/95 backdrop-blur-xl">
          {/* Call info header */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/8 bg-gradient-to-r from-green-500/10 to-[rgb(var(--ss-accent-rgb)/0.06)]">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden">
              <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse shrink-0" />
              <span className="text-sm font-medium text-slate-200 truncate">{conversationLabel}</span>
              <span className="hidden sm:inline text-xs text-slate-500 font-mono shrink-0">{formatDuration(elapsed)}</span>
              <span className="text-xs text-slate-500 shrink-0">{participantCount}p</span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0 ml-2">
              {/* Quick mute toggle */}
              <button
                onClick={onToggleMute}
                className={`inline-flex items-center justify-center h-7 w-7 rounded-full transition-all
                  ${callState.localAudioEnabled
                    ? "bg-white/8 hover:bg-white/14 text-slate-200"
                    : "bg-red-500/25 hover:bg-red-500/35 text-red-300"
                  }`}
                title={callState.localAudioEnabled ? "Mute" : "Unmute"}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {callState.localAudioEnabled ? (
                    <>
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    </>
                  ) : (
                    <>
                      <line x1="2" y1="2" x2="22" y2="22" />
                      <path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2" />
                      <path d="M5 10v2a7 7 0 0 0 12 5.29" />
                      <path d="M15 9.34V5a3 3 0 0 0-5.68-1.33" />
                    </>
                  )}
                </svg>
              </button>

              {/* Timer (visible on mobile too, in the button area) */}
              <span className="sm:hidden text-xs text-slate-500 font-mono">{formatDuration(elapsed)}</span>

              {/* Fullscreen toggle */}
              <button
                onClick={() => setFullscreen(true)}
                className="inline-flex items-center justify-center h-7 w-7 rounded-full bg-white/8 hover:bg-white/14 text-slate-200 transition-all"
                title="Fullscreen"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 3h6v6" />
                  <path d="M9 21H3v-6" />
                  <path d="M21 3l-7 7" />
                  <path d="M3 21l7-7" />
                </svg>
              </button>

              {/* End call */}
              <button
                onClick={onLeaveCall}
                className="inline-flex items-center justify-center h-7 px-2.5 rounded-full bg-red-500/80 hover:bg-red-500 text-white text-xs font-medium transition-all"
              >
                Leave
              </button>
            </div>
          </div>

          {/* Video grid -- always visible */}
          <div className="p-3" style={{ height: "28vh", minHeight: "160px" }}>
            {renderVideoGrid("h-full", false)}
          </div>

          {/* Controls */}
          <div className="relative">
            {showScreenSharePicker && (
              <ScreenSharePicker
                onStart={handleScreenShareStart}
                onCancel={() => setShowScreenSharePicker(false)}
              />
            )}
            <CallControls
              {...controlsProps}
              onToggleExpand={() => setFullscreen(true)}
            />
          </div>
        </div>
      )}

      {/* Volume popup */}
      {volumePopup && (
        <VolumeControlPopup
          x={volumePopup.x}
          y={volumePopup.y}
          userId={volumePopup.userId}
          username={volumePopup.username}
          profilePicture={volumePopup.profilePicture}
          volume={userVolumes[volumePopup.userId] ?? 1.0}
          onVolumeChange={(v) => handleVolumeChange(volumePopup.userId, v)}
          onClose={() => setVolumePopup(null)}
        />
      )}
    </>
  );
}
