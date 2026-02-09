// client/src/hooks/useCallManager.js
// React hook for managing WebRTC call state.
// Bridges WebRTCManager (framework-agnostic) to React state + Socket.IO events.

import { useState, useRef, useCallback, useEffect } from "react";
import WebRTCManager from "../utils/webrtcManager";
import { useSettings } from "../context/settings";

export function useCallManager(socket, currentUser) {
  const { audioInputDeviceId, videoInputDeviceId } = useSettings();

  // Call state
  const [callState, setCallState] = useState(null);
  // callState shape: {
  //   conversationId, type: 'voice'|'video',
  //   status: 'outgoing'|'active',
  //   participants: [userId, ...],
  //   startedAt: number,
  //   localAudioEnabled: boolean,
  //   localVideoEnabled: boolean,
  //   isScreenSharing: boolean,
  // }

  const [incomingCall, setIncomingCall] = useState(null);
  // incomingCall shape: { conversationId, callerId, callerName, type, participants }

  const [localStream, setLocalStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({}); // userId -> MediaStream
  const [remoteMediaState, setRemoteMediaState] = useState({}); // userId -> { audio, video, screen }
  // Counter to force re-render when remote tracks change (mute/unmute/ended)
  const [streamUpdateTick, setStreamUpdateTick] = useState(0);

  // Active calls across all conversations (for presence indicators)
  // Shape: { conversationId -> { participants: [userId, ...], type, startedAt } }
  const [activeCallMap, setActiveCallMap] = useState({});

  const webrtcRef = useRef(null);
  const callStateRef = useRef(null);
  callStateRef.current = callState;

  // --- Callbacks for WebRTCManager ---

  const handleRemoteStream = useCallback((userId, stream) => {
    setRemoteStreams((prev) => {
      // Force new object reference even if stream is the same object
      const next = { ...prev };
      next[userId] = stream;
      return next;
    });
    setStreamUpdateTick((t) => t + 1);
  }, []);

  const handleRemoteStreamRemoved = useCallback((userId) => {
    setRemoteStreams((prev) => {
      const copy = { ...prev };
      delete copy[userId];
      return copy;
    });
    setRemoteMediaState((prev) => {
      const copy = { ...prev };
      delete copy[userId];
      return copy;
    });
  }, []);

  const handleConnectionStateChange = useCallback((userId, state) => {
    if (state === "failed" || state === "closed") {
      // WebRTCManager handles reconnection internally
    }
  }, []);

  const handleRemoteTrackUpdated = useCallback((userId) => {
    // Force a re-render tick so VideoTile picks up track state changes
    setStreamUpdateTick((t) => t + 1);
  }, []);

  // --- Cleanup ---

  const cleanupCall = useCallback(() => {
    if (webrtcRef.current) {
      webrtcRef.current.closeAll();
      webrtcRef.current = null;
    }
    setCallState(null);
    setLocalStream(null);
    setScreenStream(null);
    setRemoteStreams({});
    setRemoteMediaState({});
    setStreamUpdateTick(0);
  }, []);

  // --- Actions ---

  const startCall = useCallback(
    async (conversationId, type) => {
      if (!socket || !currentUser) return;
      if (callStateRef.current) {
        // Already in a call
        return;
      }

      try {
        const mgr = new WebRTCManager({
          socket,
          currentUserId: currentUser.id,
          conversationId,
          onRemoteStream: handleRemoteStream,
          onRemoteStreamRemoved: handleRemoteStreamRemoved,
          onConnectionStateChange: handleConnectionStateChange,
          onRemoteTrackUpdated: handleRemoteTrackUpdated,
        });
        webrtcRef.current = mgr;

        const stream = await mgr.startLocalStream({
          audio: true,
          video: type === "video",
          audioDeviceId: audioInputDeviceId,
          videoDeviceId: videoInputDeviceId,
        });
        setLocalStream(stream);

        setCallState({
          conversationId,
          type,
          status: "outgoing",
          participants: [currentUser.id],
          startedAt: Date.now(),
          localAudioEnabled: true,
          localVideoEnabled: type === "video",
          isScreenSharing: false,
        });

        // Emit to server
        socket.emit("call:initiate", { conversationId, type });
      } catch (err) {
        console.error("Failed to start call:", err);
        cleanupCall();
      }
    },
    [socket, currentUser, audioInputDeviceId, videoInputDeviceId, handleRemoteStream, handleRemoteStreamRemoved, handleConnectionStateChange, handleRemoteTrackUpdated, cleanupCall]
  );

  const acceptCall = useCallback(async () => {
    if (!incomingCall || !socket || !currentUser) return;

    const { conversationId, type } = incomingCall;
    setIncomingCall(null);

    try {
      const mgr = new WebRTCManager({
        socket,
        currentUserId: currentUser.id,
        conversationId,
        onRemoteStream: handleRemoteStream,
        onRemoteStreamRemoved: handleRemoteStreamRemoved,
        onConnectionStateChange: handleConnectionStateChange,
        onRemoteTrackUpdated: handleRemoteTrackUpdated,
      });
      webrtcRef.current = mgr;

      const stream = await mgr.startLocalStream({
        audio: true,
        video: type === "video",
        audioDeviceId: audioInputDeviceId,
        videoDeviceId: videoInputDeviceId,
      });
      setLocalStream(stream);

      setCallState({
        conversationId,
        type,
        status: "active",
        participants: [currentUser.id],
        startedAt: Date.now(),
        localAudioEnabled: true,
        localVideoEnabled: type === "video",
        isScreenSharing: false,
      });

      // Join the call on the server
      socket.emit("call:join", { conversationId });
    } catch (err) {
      console.error("Failed to accept call:", err);
      cleanupCall();
    }
  }, [incomingCall, socket, currentUser, audioInputDeviceId, videoInputDeviceId, handleRemoteStream, handleRemoteStreamRemoved, handleConnectionStateChange, handleRemoteTrackUpdated, cleanupCall]);

  const rejectCall = useCallback(() => {
    if (!incomingCall || !socket) return;
    socket.emit("call:reject", { conversationId: incomingCall.conversationId });
    setIncomingCall(null);
  }, [incomingCall, socket]);

  const leaveCall = useCallback(() => {
    if (!callStateRef.current || !socket) return;
    socket.emit("call:leave", { conversationId: callStateRef.current.conversationId });
    cleanupCall();
  }, [socket, cleanupCall]);

  const toggleMute = useCallback(() => {
    if (!webrtcRef.current || !callStateRef.current) return;
    const enabled = webrtcRef.current.toggleAudio();
    setCallState((prev) => (prev ? { ...prev, localAudioEnabled: enabled } : null));

    if (socket && callStateRef.current) {
      socket.emit("call:toggle-media", {
        conversationId: callStateRef.current.conversationId,
        kind: "audio",
        enabled,
      });
    }
  }, [socket]);

  const toggleVideo = useCallback(async () => {
    if (!webrtcRef.current || !callStateRef.current) return;

    const localVid = webrtcRef.current.getLocalStream()?.getVideoTracks()[0];
    if (!localVid) {
      const track = await webrtcRef.current.addVideoTrack(videoInputDeviceId);
      if (track) {
        setLocalStream(webrtcRef.current.getLocalStream());
        setCallState((prev) => (prev ? { ...prev, localVideoEnabled: true, type: "video" } : null));
        if (socket && callStateRef.current) {
          socket.emit("call:toggle-media", {
            conversationId: callStateRef.current.conversationId,
            kind: "video",
            enabled: true,
          });
        }
      }
      return;
    }

    const enabled = webrtcRef.current.toggleVideo();
    setCallState((prev) => (prev ? { ...prev, localVideoEnabled: enabled } : null));
    // Force re-render with updated stream (mobile removes the track entirely)
    setLocalStream(webrtcRef.current.getLocalStream());

    if (socket && callStateRef.current) {
      socket.emit("call:toggle-media", {
        conversationId: callStateRef.current.conversationId,
        kind: "video",
        enabled,
      });
    }
  }, [socket, videoInputDeviceId]);

  const flipCamera = useCallback(async () => {
    if (!webrtcRef.current || !callStateRef.current) return;
    const track = await webrtcRef.current.flipCamera();
    if (track) {
      setLocalStream(webrtcRef.current.getLocalStream());
    }
  }, []);

  const toggleScreenShare = useCallback(async (settings) => {
    if (!webrtcRef.current || !callStateRef.current) return;

    if (callStateRef.current.isScreenSharing) {
      webrtcRef.current.stopScreenShare();
      setScreenStream(null);
      setCallState((prev) => (prev ? { ...prev, isScreenSharing: false } : null));

      if (socket && callStateRef.current) {
        socket.emit("call:toggle-media", {
          conversationId: callStateRef.current.conversationId,
          kind: "screen",
          enabled: false,
        });
      }
    } else {
      try {
        const stream = await webrtcRef.current.startScreenShare(settings);
        setScreenStream(stream);
        setCallState((prev) => (prev ? { ...prev, isScreenSharing: true } : null));

        // Handle browser stop button
        stream.getVideoTracks()[0].onended = () => {
          setScreenStream(null);
          setCallState((prev) => (prev ? { ...prev, isScreenSharing: false } : null));
          if (socket && callStateRef.current) {
            socket.emit("call:toggle-media", {
              conversationId: callStateRef.current.conversationId,
              kind: "screen",
              enabled: false,
            });
          }
        };

        if (socket && callStateRef.current) {
          socket.emit("call:toggle-media", {
            conversationId: callStateRef.current.conversationId,
            kind: "screen",
            enabled: true,
          });
        }
      } catch (err) {
        // User cancelled screen share picker
        console.log("Screen share cancelled");
      }
    }
  }, [socket]);

  // --- Socket event listeners ---

  useEffect(() => {
    if (!socket || !currentUser) return;

    const onIncoming = ({ conversationId, callerId, callerName, type, participants }) => {
      if (callerId === currentUser.id) return;
      // If already in an outgoing call to the SAME conversation, server merged — skip
      if (callStateRef.current && callStateRef.current.conversationId === conversationId) return;
      // If already in a call to a different conversation, ignore
      if (callStateRef.current) return;

      setIncomingCall({ conversationId, callerId, callerName, type, participants });

      // Vibrate on mobile (if supported)
      if ("vibrate" in navigator) {
        navigator.vibrate([200, 100, 200, 100, 200, 100, 200]);
      }
    };

    const onJoined = ({ conversationId, type, participants }) => {
      setCallState((prev) => {
        if (!prev) return prev;
        return { ...prev, status: "active", participants };
      });

      if (webrtcRef.current) {
        for (const pid of participants) {
          if (pid !== currentUser.id) {
            webrtcRef.current.createOffer(pid);
          }
        }
      }
    };

    const onParticipantJoined = ({ conversationId, userId, username, participants }) => {
      if (!callStateRef.current || callStateRef.current.conversationId !== conversationId) return;
      setCallState((prev) => (prev ? { ...prev, participants } : null));

      if (webrtcRef.current && userId !== currentUser.id) {
        webrtcRef.current.createOffer(userId);
      }
    };

    const onParticipantLeft = ({ conversationId, userId, participants }) => {
      if (!callStateRef.current || callStateRef.current.conversationId !== conversationId) return;
      setCallState((prev) => (prev ? { ...prev, participants } : null));

      if (webrtcRef.current) {
        webrtcRef.current.removePeer(userId);
      }
    };

    const onEnded = ({ conversationId, reason }) => {
      setIncomingCall((prev) => (prev?.conversationId === conversationId ? null : prev));
      if (callStateRef.current && callStateRef.current.conversationId === conversationId) {
        cleanupCall();
      }
    };

    const onRejected = ({ conversationId, userId, username }) => {
      // Could show a toast
    };

    const onOffer = ({ conversationId, fromUserId, offer }) => {
      if (!callStateRef.current || callStateRef.current.conversationId !== conversationId) return;
      if (webrtcRef.current) {
        webrtcRef.current.handleOffer(fromUserId, offer);
      }
    };

    const onAnswer = ({ conversationId, fromUserId, answer }) => {
      if (!callStateRef.current || callStateRef.current.conversationId !== conversationId) return;
      if (webrtcRef.current) {
        webrtcRef.current.handleAnswer(fromUserId, answer);
      }
    };

    const onIceCandidate = ({ conversationId, fromUserId, candidate }) => {
      if (!callStateRef.current || callStateRef.current.conversationId !== conversationId) return;
      if (webrtcRef.current) {
        webrtcRef.current.handleIceCandidate(fromUserId, candidate);
      }
    };

    const onMediaToggled = ({ conversationId, userId, kind, enabled }) => {
      if (!callStateRef.current || callStateRef.current.conversationId !== conversationId) return;
      setRemoteMediaState((prev) => ({
        ...prev,
        [userId]: { ...(prev[userId] || { audio: true, video: true, screen: false }), [kind]: enabled },
      }));
    };

    const onError = ({ message }) => {
      console.error("Call error:", message);
    };

    // Call presence: update active call map for sidebar indicators
    const onCallStatus = ({ conversationId, participants, type, startedAt }) => {
      setActiveCallMap((prev) => {
        if (!participants || participants.length === 0) {
          const copy = { ...prev };
          delete copy[conversationId];
          return copy;
        }
        return { ...prev, [conversationId]: { participants, type, startedAt } };
      });
    };

    const onActiveCalls = (calls) => {
      const map = {};
      for (const c of calls) {
        if (c.participants && c.participants.length > 0) {
          map[c.conversationId] = { participants: c.participants, type: c.type, startedAt: c.startedAt };
        }
      }
      setActiveCallMap(map);
    };

    socket.on("call:incoming", onIncoming);
    socket.on("call:joined", onJoined);
    socket.on("call:participant-joined", onParticipantJoined);
    socket.on("call:participant-left", onParticipantLeft);
    socket.on("call:ended", onEnded);
    socket.on("call:rejected", onRejected);
    socket.on("call:offer", onOffer);
    socket.on("call:answer", onAnswer);
    socket.on("call:ice-candidate", onIceCandidate);
    socket.on("call:media-toggled", onMediaToggled);
    socket.on("call:error", onError);
    socket.on("call:status", onCallStatus);
    socket.on("call:active-calls", onActiveCalls);

    // Request active calls on connect
    socket.emit("call:get-active-calls");

    return () => {
      socket.off("call:incoming", onIncoming);
      socket.off("call:joined", onJoined);
      socket.off("call:participant-joined", onParticipantJoined);
      socket.off("call:participant-left", onParticipantLeft);
      socket.off("call:ended", onEnded);
      socket.off("call:rejected", onRejected);
      socket.off("call:offer", onOffer);
      socket.off("call:answer", onAnswer);
      socket.off("call:ice-candidate", onIceCandidate);
      socket.off("call:media-toggled", onMediaToggled);
      socket.off("call:error", onError);
      socket.off("call:status", onCallStatus);
      socket.off("call:active-calls", onActiveCalls);
    };
  }, [socket, currentUser, cleanupCall]);

  // Socket reconnection: rejoin call + refresh active calls
  useEffect(() => {
    if (!socket) return;

    const onReconnect = () => {
      // Refresh active call map on every reconnect
      socket.emit("call:get-active-calls");

      if (callStateRef.current && callStateRef.current.status === "active") {
        socket.emit("call:join", { conversationId: callStateRef.current.conversationId });
      }
    };

    socket.on("connect", onReconnect);
    return () => socket.off("connect", onReconnect);
  }, [socket]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (callStateRef.current && socket) {
        socket.emit("call:leave", { conversationId: callStateRef.current.conversationId });
      }
      if (webrtcRef.current) {
        webrtcRef.current.closeAll();
      }
    };
  }, [socket]);

  // beforeunload: leave call on tab close
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (callStateRef.current && socket) {
        socket.emit("call:leave", { conversationId: callStateRef.current.conversationId });
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [socket]);

  return {
    callState,
    incomingCall,
    localStream,
    screenStream,
    remoteStreams,
    remoteMediaState,
    streamUpdateTick,
    activeCallMap,
    startCall,
    acceptCall,
    rejectCall,
    leaveCall,
    toggleMute,
    toggleVideo,
    flipCamera,
    toggleScreenShare,
  };
}
