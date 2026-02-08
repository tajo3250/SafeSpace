// src/pages/settings.jsx
import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../context/settings.jsx";
import logoWordmark from "../assets/brand/logo-wordmark.svg";

const ACCENTS = [
  { key: "teal", label: "Teal", rgb: "45 212 191" },
  { key: "blue", label: "Blue", rgb: "59 130 246" },
  { key: "purple", label: "Purple", rgb: "168 85 247" },
  { key: "rose", label: "Rose", rgb: "244 63 94" },
  { key: "amber", label: "Amber", rgb: "245 158 11" },
  { key: "lime", label: "Lime", rgb: "132 204 22" },
];

function ChoiceButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-2 rounded-xl border text-sm font-semibold transition-colors",
        active
          ? "bg-[rgb(var(--ss-accent-rgb)/0.18)] border-[rgb(var(--ss-accent-rgb)/0.45)] text-white"
          : "bg-white/5 border-white/10 text-slate-200 hover:bg-white/10",
      ].join(" ")}
      type="button"
    >
      {children}
    </button>
  );
}

function MicCameraTest({ audioInputDeviceId, videoInputDeviceId }) {
  const [micTesting, setMicTesting] = useState(false);
  const [camTesting, setCamTesting] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const micStreamRef = useRef(null);
  const micAnimRef = useRef(null);
  const analyserRef = useRef(null);
  const camStreamRef = useRef(null);
  const videoRef = useRef(null);

  const startMicTest = useCallback(async () => {
    try {
      const constraints = { audio: audioInputDeviceId ? { deviceId: { exact: audioInputDeviceId } } : true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      micStreamRef.current = stream;

      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      source.connect(analyser);
      analyserRef.current = { ctx, analyser };

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((sum, v) => sum + v, 0) / dataArray.length;
        setMicLevel(Math.min(100, (avg / 128) * 100));
        micAnimRef.current = requestAnimationFrame(tick);
      };
      tick();
      setMicTesting(true);
    } catch {
      setMicTesting(false);
    }
  }, [audioInputDeviceId]);

  const stopMicTest = useCallback(() => {
    if (micAnimRef.current) cancelAnimationFrame(micAnimRef.current);
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
    if (analyserRef.current?.ctx) analyserRef.current.ctx.close().catch(() => {});
    micStreamRef.current = null;
    analyserRef.current = null;
    setMicLevel(0);
    setMicTesting(false);
  }, []);

  const startCamTest = useCallback(async () => {
    try {
      const constraints = { video: videoInputDeviceId ? { deviceId: { exact: videoInputDeviceId } } : true };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      camStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      setCamTesting(true);
    } catch {
      setCamTesting(false);
    }
  }, [videoInputDeviceId]);

  const stopCamTest = useCallback(() => {
    if (camStreamRef.current) camStreamRef.current.getTracks().forEach((t) => t.stop());
    if (videoRef.current) videoRef.current.srcObject = null;
    camStreamRef.current = null;
    setCamTesting(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (micAnimRef.current) cancelAnimationFrame(micAnimRef.current);
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
      if (analyserRef.current?.ctx) analyserRef.current.ctx.close().catch(() => {});
      if (camStreamRef.current) camStreamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <section className="rounded-2xl glass-panel p-5">
      <div className="font-semibold mb-1">Test Devices</div>
      <div className="text-slate-300/80 text-sm mb-4">
        Test your microphone and camera before joining a call.
      </div>

      <div className="space-y-4">
        {/* Mic test */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-slate-200">Microphone Test</label>
            <button
              onClick={micTesting ? stopMicTest : startMicTest}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                micTesting
                  ? "bg-red-500/20 border-red-500/40 text-red-200 hover:bg-red-500/30"
                  : "bg-white/10 border-white/10 text-slate-100 hover:bg-white/20"
              }`}
              type="button"
            >
              {micTesting ? "Stop" : "Test Mic"}
            </button>
          </div>
          <div className="h-3 rounded-full bg-white/5 border border-white/10 overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-75"
              style={{
                width: `${micLevel}%`,
                background: micLevel > 60
                  ? "linear-gradient(90deg, rgb(var(--ss-accent-rgb)), #ef4444)"
                  : `rgb(var(--ss-accent-rgb))`,
              }}
            />
          </div>
          {micTesting && (
            <div className="mt-1.5 text-xs text-slate-400">
              {micLevel < 5 ? "No audio detected — try speaking" : "Mic is working"}
            </div>
          )}
        </div>

        {/* Camera test */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-slate-200">Camera Test</label>
            <button
              onClick={camTesting ? stopCamTest : startCamTest}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all ${
                camTesting
                  ? "bg-red-500/20 border-red-500/40 text-red-200 hover:bg-red-500/30"
                  : "bg-white/10 border-white/10 text-slate-100 hover:bg-white/20"
              }`}
              type="button"
            >
              {camTesting ? "Stop" : "Test Camera"}
            </button>
          </div>
          <div className={`rounded-xl overflow-hidden border border-white/10 bg-black/40 ${camTesting ? "" : "hidden"}`}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full max-h-[240px] object-cover scale-x-[-1]"
            />
          </div>
          {!camTesting && (
            <div className="text-xs text-slate-400">
              Click "Test Camera" to see a live preview.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const {
    textSize, accent, audioInputDeviceId, videoInputDeviceId,
    setTextSize, setAccent, setAudioInputDeviceId, setVideoInputDeviceId, reset,
  } = useSettings();

  const [audioDevices, setAudioDevices] = useState([]);
  const [videoDevices, setVideoDevices] = useState([]);
  const [deviceError, setDeviceError] = useState("");

  const enumerateDevices = useCallback(async () => {
    try {
      // Request permission first so labels are available
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true }).catch(() =>
        navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null)
      );

      const devices = await navigator.mediaDevices.enumerateDevices();

      setAudioDevices(
        devices.filter((d) => d.kind === "audioinput").map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Microphone ${d.deviceId.slice(0, 6)}`,
        }))
      );
      setVideoDevices(
        devices.filter((d) => d.kind === "videoinput").map((d) => ({
          deviceId: d.deviceId,
          label: d.label || `Camera ${d.deviceId.slice(0, 6)}`,
        }))
      );
      setDeviceError("");

      // Stop the test stream
      if (stream) stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      setDeviceError("Could not access media devices. Check browser permissions.");
    }
  }, []);

  useEffect(() => {
    enumerateDevices();
    // Listen for device changes (plugging/unplugging devices)
    navigator.mediaDevices?.addEventListener?.("devicechange", enumerateDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", enumerateDevices);
  }, [enumerateDevices]);

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px))] text-slate-100">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-white/10 backdrop-blur-xl">
        <div className="h-16 px-4 flex items-center gap-3">
          <button
            onClick={() => navigate("/chat")}
            className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
            type="button"
          >
            Back
          </button>

          <img src={logoWordmark} alt="SafeSpace" className="h-8 w-auto rounded-xl" />

          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold truncate text-white">Settings</div>
            <div className="text-xs text-slate-300/80 truncate">
              Readability and appearance (local-only)
            </div>
          </div>

          <button
            onClick={reset}
            className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
            type="button"
          >
            Reset
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 space-y-4">
        <section className="rounded-2xl glass-panel p-5">
          <div className="font-semibold mb-1">Readability</div>
          <div className="text-slate-300/80 text-sm mb-3">
            Adjust text size across the UI (messages + inputs).
          </div>

          <div className="flex flex-wrap gap-2">
            <ChoiceButton active={textSize === "sm"} onClick={() => setTextSize("sm")}>
              Small
            </ChoiceButton>
            <ChoiceButton active={textSize === "md"} onClick={() => setTextSize("md")}>
              Medium
            </ChoiceButton>
            <ChoiceButton active={textSize === "lg"} onClick={() => setTextSize("lg")}>
              Large
            </ChoiceButton>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-slate-300/80 ss-text-sm">Preview</div>
            <div className="mt-1 ss-text">
              This is what message text looks like with your selected size.
            </div>
          </div>
        </section>

        <section className="rounded-2xl glass-panel p-5">
          <div className="font-semibold mb-1">Accent color</div>
          <div className="text-slate-300/80 text-sm mb-3">
            Changes highlights, buttons, and unread indicators. Default remains SafeSpace teal.
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.key}
                onClick={() => setAccent(a.key)}
                className={[
                  "flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors",
                  accent === a.key
                    ? "bg-[rgb(var(--ss-accent-rgb)/0.18)] border-[rgb(var(--ss-accent-rgb)/0.45)]"
                    : "bg-white/5 border-white/10 hover:bg-white/10",
                ].join(" ")}
                type="button"
              >
                <span
                  className="h-3 w-3 rounded-full border border-white/20"
                  style={{ backgroundColor: `rgb(${a.rgb})` }}
                />
                <span className="font-semibold">{a.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl glass-panel p-5">
          <div className="font-semibold mb-1">Message limits</div>
          <div className="text-slate-300/80 text-sm">
            Current max message length: <span className="font-semibold">4000 characters</span>.
          </div>
        </section>

        <section className="rounded-2xl glass-panel p-5">
          <div className="font-semibold mb-1">Audio & Video Devices</div>
          <div className="text-slate-300/80 text-sm mb-3">
            Select which microphone and camera to use for calls. Your choice is saved locally.
          </div>

          {deviceError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/30 text-sm text-red-200">
              {deviceError}
            </div>
          )}

          <div className="space-y-4">
            {/* Microphone */}
            <div>
              <label className="block text-sm font-medium mb-1.5 text-slate-200">Microphone</label>
              <select
                value={audioInputDeviceId}
                onChange={(e) => setAudioInputDeviceId(e.target.value)}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)] transition-shadow"
              >
                <option value="" className="bg-[#0c111d] text-slate-100">System default</option>
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId} className="bg-[#0c111d] text-slate-100">
                    {d.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Camera */}
            <div>
              <label className="block text-sm font-medium mb-1.5 text-slate-200">Camera</label>
              <select
                value={videoInputDeviceId}
                onChange={(e) => setVideoInputDeviceId(e.target.value)}
                className="w-full rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 text-sm text-slate-100 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)] transition-shadow"
              >
                <option value="" className="bg-[#0c111d] text-slate-100">System default</option>
                {videoDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId} className="bg-[#0c111d] text-slate-100">
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {(audioDevices.length === 0 && videoDevices.length === 0 && !deviceError) && (
            <div className="mt-3 text-sm text-slate-400">
              No devices found. Grant microphone/camera permission to see available devices.
            </div>
          )}
        </section>

        {/* Mic & Camera Test */}
        <MicCameraTest
          audioInputDeviceId={audioInputDeviceId}
          videoInputDeviceId={videoInputDeviceId}
        />
      </main>
    </div>
  );
}
