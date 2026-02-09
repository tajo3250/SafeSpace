// client/src/utils/webrtcManager.js
// Framework-agnostic WebRTC peer connection manager.
// Handles peer connections, media streams, ICE candidates, and screen sharing.
// Uses DTLS-SRTP (built into WebRTC) for end-to-end encryption.

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const RECONNECT_TIMEOUT = 15000;

export default class WebRTCManager {
  constructor({
    socket,
    currentUserId,
    conversationId,
    onRemoteStream,
    onRemoteStreamRemoved,
    onConnectionStateChange,
    onRemoteTrackUpdated,
  }) {
    this.socket = socket;
    this.currentUserId = currentUserId;
    this.conversationId = conversationId;
    this.peers = new Map(); // userId -> { pc, streams }
    this.localStream = null;
    this.screenStream = null;
    this.pendingCandidates = new Map(); // userId -> ICECandidate[]
    this.reconnectTimers = new Map();
    this.makingOffer = new Map(); // userId -> boolean (for perfect negotiation)
    this.screenAudioSenders = new Map(); // userId -> RTCRtpSender (for screen share audio cleanup)
    this._screenAudioMixer = null; // { ctx, mixedTrack, originalMicTrack } when mixing screen+mic audio

    this.onRemoteStream = onRemoteStream;
    this.onRemoteStreamRemoved = onRemoteStreamRemoved;
    this.onConnectionStateChange = onConnectionStateChange;
    this.onRemoteTrackUpdated = onRemoteTrackUpdated;
  }

  // --- Local media ---

  async startLocalStream({ audio = true, video = false, audioDeviceId = "", videoDeviceId = "" }) {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    try {
      const audioConstraints = audio
        ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            ...(audioDeviceId ? { deviceId: { exact: audioDeviceId } } : {}),
          }
        : false;

      const videoConstraints = video
        ? {
            ...(isMobile
              ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
              : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "user" }
            ),
            ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
          }
        : false;

      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints,
      });
      return this.localStream;
    } catch (err) {
      // If exact device fails, fall back to default
      if ((audioDeviceId || videoDeviceId) && err.name === "OverconstrainedError") {
        console.warn("Saved device not available, falling back to default");
        this.localStream = await navigator.mediaDevices.getUserMedia({
          audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
          video: video ? (isMobile ? { facingMode: "user" } : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "user" }) : false,
        });
        return this.localStream;
      }
      // On mobile, if any constraint fails, retry with minimal constraints
      if (isMobile && video) {
        console.warn("Mobile video constraint failed, retrying with minimal constraints");
        try {
          this.localStream = await navigator.mediaDevices.getUserMedia({
            audio: audio ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : false,
            video: { facingMode: "user" },
          });
          return this.localStream;
        } catch (retryErr) {
          console.error("Mobile camera retry also failed:", retryErr);
          throw retryErr;
        }
      }
      console.error("Failed to get local media:", err);
      throw err;
    }
  }

  stopLocalStream() {
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
      this.localStream = null;
    }
  }

  getLocalStream() {
    return this.localStream;
  }

  getScreenStream() {
    return this.screenStream;
  }

  // --- Peer connections ---

  _createPeerConnection(userId) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Add local tracks to new connection
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => {
        pc.addTrack(track, this.localStream);
      });
    }

    // If screen sharing, add only the screen VIDEO track (not audio).
    // Screen audio is mixed into the mic track via Web Audio API.
    if (this.screenStream) {
      const screenVideoTrack = this.screenStream.getVideoTracks()[0];
      if (screenVideoTrack) {
        pc.addTrack(screenVideoTrack, this.screenStream);
      }
    }

    // Always ensure a video transceiver exists (even for voice-only calls).
    // This lets screen share use replaceTrack() which never triggers renegotiation,
    // preventing the mic-stops-on-screenshare bug.
    const hasVideoSender = pc.getSenders().some((s) => s.track?.kind === "video");
    if (!hasVideoSender) {
      pc.addTransceiver("video", { direction: "sendrecv" });
    }

    // If screen audio is currently being mixed, use the mixed track on this connection
    if (this._screenAudioMixer?.mixedTrack) {
      const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
      if (audioSender) {
        audioSender.replaceTrack(this._screenAudioMixer.mixedTrack).catch(() => {});
      }
    }

    // Renegotiation handler — handles addTrack during active call (screen share in voice-only)
    pc.onnegotiationneeded = async () => {
      // Only handle renegotiation for established connections
      // Initial offers are sent explicitly via createOffer()
      if (!pc.remoteDescription) return;

      try {
        this.makingOffer.set(userId, true);
        const offer = await pc.createOffer();
        if (pc.signalingState !== "stable") return;
        await pc.setLocalDescription(offer);

        this.socket.emit("call:offer", {
          conversationId: this.conversationId,
          targetUserId: userId,
          offer: pc.localDescription.toJSON(),
        });
      } catch (err) {
        console.error(`Renegotiation failed for ${userId}:`, err);
      } finally {
        this.makingOffer.set(userId, false);
      }
    };

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("call:ice-candidate", {
          conversationId: this.conversationId,
          targetUserId: userId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Remote tracks — fires when remote sends a track
    pc.ontrack = (event) => {
      let stream = event.streams[0];
      const peer = this.peers.get(userId);

      // Pre-allocated transceivers (video in voice-only calls) fire ontrack
      // with empty event.streams. Merge the track into the existing remote
      // stream so the UI can see it when replaceTrack() sends real media.
      if (!stream) {
        if (peer?.remoteStream) {
          stream = peer.remoteStream;
          if (!stream.getTrackById(event.track.id)) {
            stream.addTrack(event.track);
          }
        } else {
          stream = new MediaStream([event.track]);
        }
      }

      // Store remote stream reference on the peer
      if (peer) peer.remoteStream = stream;

      if (this.onRemoteStream) {
        this.onRemoteStream(userId, stream);
      }

      // Listen for track ended/muted events to notify UI of changes
      const track = event.track;
      if (track) {
        track.onended = () => {
          if (this.onRemoteTrackUpdated) this.onRemoteTrackUpdated(userId);
        };
        track.onmute = () => {
          if (this.onRemoteTrackUpdated) this.onRemoteTrackUpdated(userId);
        };
        track.onunmute = () => {
          // When replaceTrack() swaps in real media, the receiver track unmutes.
          // Re-emit the stream so the UI re-renders with the live video.
          if (this.onRemoteStream && peer?.remoteStream) {
            this.onRemoteStream(userId, peer.remoteStream);
          }
          if (this.onRemoteTrackUpdated) this.onRemoteTrackUpdated(userId);
        };
      }
    };

    // Connection state monitoring
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (this.onConnectionStateChange) {
        this.onConnectionStateChange(userId, state);
      }

      if (state === "failed") {
        this._handleConnectionFailure(userId);
      } else if (state === "connected") {
        this._clearReconnectTimer(userId);
      }
    };

    // ICE connection state — trigger restart on failure
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "failed") {
        pc.restartIce();
      } else if (state === "disconnected") {
        this._startReconnectTimer(userId);
      } else if (state === "connected" || state === "completed") {
        this._clearReconnectTimer(userId);
      }
    };

    this.peers.set(userId, { pc, streams: [], remoteStream: null });
    this.makingOffer.set(userId, false);
    return pc;
  }

  _getOrCreatePeer(userId) {
    const existing = this.peers.get(userId);
    if (existing) return existing.pc;
    return this._createPeerConnection(userId);
  }

  // --- Signaling ---

  async createOffer(targetUserId) {
    const pc = this._getOrCreatePeer(targetUserId);
    try {
      this.makingOffer.set(targetUserId, true);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      this.socket.emit("call:offer", {
        conversationId: this.conversationId,
        targetUserId,
        offer: pc.localDescription.toJSON(),
      });
    } catch (err) {
      console.error(`Failed to create offer for ${targetUserId}:`, err);
    } finally {
      this.makingOffer.set(targetUserId, false);
    }
  }

  async handleOffer(fromUserId, offer) {
    const pc = this._getOrCreatePeer(fromUserId);

    // Perfect negotiation: handle glare
    const offerCollision =
      pc.signalingState !== "stable" || this.makingOffer.get(fromUserId);

    // Polite peer: the one with the higher user ID yields
    const isPolite = this.currentUserId > fromUserId;

    if (offerCollision && !isPolite) {
      // Impolite peer ignores the offer
      return;
    }

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Flush pending ICE candidates
      await this._flushCandidates(fromUserId, pc);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.socket.emit("call:answer", {
        conversationId: this.conversationId,
        targetUserId: fromUserId,
        answer: pc.localDescription.toJSON(),
      });
    } catch (err) {
      console.error(`Failed to handle offer from ${fromUserId}:`, err);
    }
  }

  async handleAnswer(fromUserId, answer) {
    const peer = this.peers.get(fromUserId);
    if (!peer) return;

    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
      // Flush pending ICE candidates
      await this._flushCandidates(fromUserId, peer.pc);
    } catch (err) {
      console.error(`Failed to handle answer from ${fromUserId}:`, err);
    }
  }

  async handleIceCandidate(fromUserId, candidate) {
    const peer = this.peers.get(fromUserId);
    if (!peer || !candidate) return;

    // If remote description not set yet, queue the candidate
    if (!peer.pc.remoteDescription) {
      if (!this.pendingCandidates.has(fromUserId)) {
        this.pendingCandidates.set(fromUserId, []);
      }
      this.pendingCandidates.get(fromUserId).push(candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error(`Failed to add ICE candidate from ${fromUserId}:`, err);
    }
  }

  async _flushCandidates(userId, pc) {
    const pending = this.pendingCandidates.get(userId);
    if (!pending || pending.length === 0) return;

    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error("Failed to flush ICE candidate:", err);
      }
    }
    this.pendingCandidates.delete(userId);
  }

  // --- Media controls ---

  toggleAudio() {
    if (!this.localStream) return false;
    const audioTrack = this.localStream.getAudioTracks()[0];
    if (!audioTrack) return false;
    audioTrack.enabled = !audioTrack.enabled;
    return audioTrack.enabled;
  }

  toggleVideo() {
    if (!this.localStream) return false;
    const videoTrack = this.localStream.getVideoTracks()[0];
    if (!videoTrack) return false;

    // Always stop the track entirely to release camera hardware (LED off).
    // Re-enabling is handled by addVideoTrack() which creates a fresh track.
    videoTrack.stop();
    this.localStream.removeTrack(videoTrack);
    // Replace track with null on all peer connections (no renegotiation needed)
    for (const [, { pc }] of this.peers) {
      const sender = pc.getSenders().find((s) => s.track === videoTrack);
      if (sender) sender.replaceTrack(null).catch(() => {});
    }
    return false;
  }

  async addVideoTrack(videoDeviceId = "") {
    // Add video if we only started with audio
    if (!this.localStream) return null;
    const existingVideo = this.localStream.getVideoTracks()[0];
    if (existingVideo) return existingVideo;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    const acquireVideoTrack = async (constraints) => {
      const videoStream = await navigator.mediaDevices.getUserMedia(constraints);
      return videoStream.getVideoTracks()[0];
    };

    try {
      const constraints = {
        video: {
          ...(isMobile
            ? { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } }
            : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: "user" }
          ),
          ...(videoDeviceId ? { deviceId: { exact: videoDeviceId } } : {}),
        },
      };

      let videoTrack;
      try {
        videoTrack = await acquireVideoTrack(constraints);
      } catch (err) {
        if (isMobile) {
          videoTrack = await acquireVideoTrack({ video: { facingMode: "user" } });
        } else {
          throw err;
        }
      }

      this.localStream.addTrack(videoTrack);

      // Use replaceTrack on the pre-allocated video sender (avoids renegotiation).
      // The pre-allocated transceiver has a null track — swap it with the real camera track.
      for (const [, { pc }] of this.peers) {
        const senders = pc.getSenders();
        const nullSender = senders.find((s) => s.track === null);
        const existingSender = nullSender || senders.find((s) => s.track?.kind === "video");
        if (existingSender) {
          await existingSender.replaceTrack(videoTrack);
        } else {
          pc.addTrack(videoTrack, this.localStream);
        }
      }

      return videoTrack;
    } catch (err) {
      console.error("Failed to add video track:", err);
      return null;
    }
  }

  // --- Camera flip (toggle between front and rear cameras) ---

  async flipCamera() {
    if (!this.localStream) return null;

    try {
      const currentTrack = this.localStream.getVideoTracks()[0];
      const currentFacing = currentTrack?.getSettings?.()?.facingMode || "user";
      const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

      // On mobile: simply toggle between "user" (front) and "environment" (main rear)
      // This avoids cycling through ultrawide, telephoto, etc.
      if (isMobile) {
        const nextFacing = currentFacing === "user" ? "environment" : "user";

        // Stop current video track
        if (currentTrack) {
          currentTrack.stop();
          this.localStream.removeTrack(currentTrack);
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { exact: nextFacing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        });
        const newTrack = stream.getVideoTracks()[0];
        this.localStream.addTrack(newTrack);

        for (const [, { pc }] of this.peers) {
          const senders = pc.getSenders();
          const videoSender = senders.find((s) => s.track === null || s.track?.kind === "video");
          if (videoSender) {
            await videoSender.replaceTrack(newTrack);
          }
        }

        return newTrack;
      }

      // On desktop: cycle through all video input devices
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((d) => d.kind === "videoinput");
      if (videoDevices.length < 2) return null;

      const currentDeviceId = currentTrack?.getSettings?.()?.deviceId || "";
      const currentIdx = videoDevices.findIndex((d) => d.deviceId === currentDeviceId);
      const nextIdx = (currentIdx + 1) % videoDevices.length;
      const nextDeviceId = videoDevices[nextIdx].deviceId;

      if (currentTrack) {
        currentTrack.stop();
        this.localStream.removeTrack(currentTrack);
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: nextDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      const newTrack = stream.getVideoTracks()[0];
      this.localStream.addTrack(newTrack);

      for (const [, { pc }] of this.peers) {
        const senders = pc.getSenders();
        const videoSender = senders.find((s) => s.track === null || s.track?.kind === "video");
        if (videoSender) {
          await videoSender.replaceTrack(newTrack);
        }
      }

      return newTrack;
    } catch (err) {
      console.error("Camera flip failed:", err);
      return null;
    }
  }

  // --- Screen sharing ---

  async startScreenShare(settings) {
    try {
      const isElectron = navigator.userAgent.includes("SafeSpace-Desktop");

      // Save audio track state before getDisplayMedia (it can disrupt audio on some browsers)
      const audioTrack = this.localStream?.getAudioTracks()[0];
      const audioWasEnabled = audioTrack?.enabled;

      // Use provided settings or defaults
      const resWidth = settings?.width || 1920;
      const resHeight = settings?.height || 1080;
      const fps = settings?.fps != null ? settings.fps : (isElectron ? 60 : 30);
      const wantAudio = settings?.audio !== false;

      const constraints = {
        video: {
          cursor: "always",
          width: { ideal: resWidth, max: 3840 },
          height: { ideal: resHeight, max: 2160 },
          frameRate: { ideal: fps, max: Math.max(fps, 60) },
        },
        audio: wantAudio,
      };

      this.screenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      const screenTrack = this.screenStream.getVideoTracks()[0];
      const screenAudioTrack = this.screenStream.getAudioTracks()[0];

      // Immediately re-enable mic if getDisplayMedia disrupted it
      if (audioTrack && audioWasEnabled && !audioTrack.enabled) {
        audioTrack.enabled = true;
      }

      // Replace the video sender's track with the screen track for every peer.
      // Because we pre-allocate a video transceiver in _createPeerConnection,
      // there's always a video sender — replaceTrack never triggers renegotiation.
      for (const [, { pc }] of this.peers) {
        const senders = pc.getSenders();
        const videoSender = senders.find((s) => s.track?.kind === "video")
          || senders.find((s) => s.track === null);
        if (videoSender) {
          await videoSender.replaceTrack(screenTrack);
        }
      }

      // If screen has audio and user opted in, mix it with mic audio via Web Audio API.
      // This uses replaceTrack() instead of addTrack() to avoid renegotiation
      // which would break the video stream and cause mic issues.
      if (screenAudioTrack && audioTrack) {
        try {
          const mixCtx = new (window.AudioContext || window.webkitAudioContext)();
          if (mixCtx.state === "suspended") {
            await mixCtx.resume().catch(() => {});
          }

          const micSource = mixCtx.createMediaStreamSource(new MediaStream([audioTrack]));
          const screenSource = mixCtx.createMediaStreamSource(new MediaStream([screenAudioTrack]));
          const dest = mixCtx.createMediaStreamDestination();

          micSource.connect(dest);
          screenSource.connect(dest);

          const mixedTrack = dest.stream.getAudioTracks()[0];

          // Replace audio sender on all peers with the mixed track (no renegotiation)
          for (const [, { pc }] of this.peers) {
            const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
            if (audioSender) {
              await audioSender.replaceTrack(mixedTrack);
            }
          }

          this._screenAudioMixer = { ctx: mixCtx, mixedTrack, originalMicTrack: audioTrack };
        } catch (mixErr) {
          // If mixing fails, screenshare still works without audio
          console.warn("Screen audio mixing failed:", mixErr);
        }
      }

      // Re-enable audio track (belt & suspenders)
      if (audioTrack && audioWasEnabled) {
        audioTrack.enabled = true;
      }

      // Handle browser "Stop Sharing" button
      screenTrack.onended = () => {
        this.stopScreenShare();
      };

      return this.screenStream;
    } catch (err) {
      // Re-enable audio if it was disrupted by a failed getDisplayMedia
      const audioTrack = this.localStream?.getAudioTracks()[0];
      if (audioTrack) audioTrack.enabled = true;

      console.error("Screen share failed:", err);
      this.screenStream = null;
      throw err;
    }
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((t) => t.stop());

    // Restore original mic audio track if we were mixing screen audio
    if (this._screenAudioMixer) {
      const { ctx, originalMicTrack } = this._screenAudioMixer;

      for (const [, { pc }] of this.peers) {
        const audioSender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (audioSender) {
          audioSender.replaceTrack(originalMicTrack).catch(() => {});
        }
      }

      ctx.close().catch(() => {});
      this._screenAudioMixer = null;
    }

    // Restore camera track for peers that had their video sender replaced
    const cameraTrack = this.localStream?.getVideoTracks()[0];

    for (const [, { pc }] of this.peers) {
      const senders = pc.getSenders();
      const videoSender = senders.find((s) => s.track?.kind === "video")
        || senders.find((s) => s.track === null);
      if (videoSender) {
        videoSender.replaceTrack(cameraTrack || null).catch(() => {});
      }
    }

    // Ensure audio is still enabled after stopping screen share
    const audioTrack = this.localStream?.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = true;

    this.screenStream = null;
  }

  // --- Reconnection ---

  _startReconnectTimer(userId) {
    this._clearReconnectTimer(userId);
    const timer = setTimeout(() => {
      this._handleConnectionFailure(userId);
    }, RECONNECT_TIMEOUT);
    this.reconnectTimers.set(userId, timer);
  }

  _clearReconnectTimer(userId) {
    const timer = this.reconnectTimers.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.reconnectTimers.delete(userId);
    }
  }

  _handleConnectionFailure(userId) {
    this._clearReconnectTimer(userId);
    this.removePeer(userId);
    // Re-offer after a brief delay
    setTimeout(() => {
      if (!this.peers.has(userId)) {
        this.createOffer(userId);
      }
    }, 1000);
  }

  // --- Cleanup ---

  removePeer(userId) {
    const peer = this.peers.get(userId);
    if (peer) {
      peer.pc.close();
      this.peers.delete(userId);
    }
    this.pendingCandidates.delete(userId);
    this.makingOffer.delete(userId);
    this._clearReconnectTimer(userId);

    if (this.onRemoteStreamRemoved) {
      this.onRemoteStreamRemoved(userId);
    }
  }

  closeAll() {
    for (const [userId] of this.peers) {
      this.removePeer(userId);
    }
    this.stopLocalStream();
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((t) => t.stop());
      this.screenStream = null;
    }
    if (this._screenAudioMixer) {
      this._screenAudioMixer.ctx.close().catch(() => {});
      this._screenAudioMixer = null;
    }
    this.screenAudioSenders.clear();
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
  }
}
