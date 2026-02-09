// src/pages/settings.jsx
import React, { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../context/settings.jsx";
import { API_BASE } from "../config";
import { getToken, getUser } from "../utils/authStorage";
import ProfilePictureEditor from "../components/settings/ProfilePictureEditor";
import logoWordmark from "../assets/brand/logo-wordmark.svg";

const ACCENTS = [
  { key: "teal", label: "Teal", rgb: "45 212 191" },
  { key: "blue", label: "Blue", rgb: "59 130 246" },
  { key: "purple", label: "Purple", rgb: "168 85 247" },
  { key: "rose", label: "Rose", rgb: "244 63 94" },
  { key: "amber", label: "Amber", rgb: "245 158 11" },
  { key: "lime", label: "Lime", rgb: "132 204 22" },
];

const THEMES = [
  { key: "dark", label: "Dark" },
  { key: "light", label: "Light" },
  { key: "amoled", label: "AMOLED" },
];

function ChoiceButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-2 rounded-lg text-sm font-semibold transition-colors",
        active
          ? "bg-[rgb(var(--ss-accent-rgb)/0.18)] ring-1 ring-[rgb(var(--ss-accent-rgb)/0.45)] text-[var(--ss-brand-ink)]"
          : "bg-[var(--ss-brand-outline)] text-[var(--ss-brand-muted)] hover:opacity-80",
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

  useEffect(() => {
    return () => {
      if (micAnimRef.current) cancelAnimationFrame(micAnimRef.current);
      if (micStreamRef.current) micStreamRef.current.getTracks().forEach((t) => t.stop());
      if (analyserRef.current?.ctx) analyserRef.current.ctx.close().catch(() => {});
      if (camStreamRef.current) camStreamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <section className="rounded-lg glass-panel p-5">
      <div className="font-semibold mb-1 text-[var(--ss-brand-ink)]">Test Devices</div>
      <div className="text-[var(--ss-brand-muted)] text-sm mb-4">
        Test your microphone and camera before joining a call.
      </div>

      <div className="space-y-4">
        {/* Mic test */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-[var(--ss-brand-ink)]">Microphone Test</label>
            <button
              onClick={micTesting ? stopMicTest : startMicTest}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                micTesting
                  ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                  : "bg-[var(--ss-brand-outline)] text-[var(--ss-brand-ink)] hover:opacity-80"
              }`}
              type="button"
            >
              {micTesting ? "Stop" : "Test Mic"}
            </button>
          </div>
          <div className="h-3 rounded-full bg-[var(--ss-brand-outline)] overflow-hidden">
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
            <div className="mt-1.5 text-xs text-[var(--ss-brand-muted)]">
              {micLevel < 5 ? "No audio detected \u2014 try speaking" : "Mic is working"}
            </div>
          )}
        </div>

        {/* Camera test */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-sm font-medium text-[var(--ss-brand-ink)]">Camera Test</label>
            <button
              onClick={camTesting ? stopCamTest : startCamTest}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg transition-all ${
                camTesting
                  ? "bg-red-500/20 text-red-300 hover:bg-red-500/30"
                  : "bg-[var(--ss-brand-outline)] text-[var(--ss-brand-ink)] hover:opacity-80"
              }`}
              type="button"
            >
              {camTesting ? "Stop" : "Test Camera"}
            </button>
          </div>
          <div className={`rounded-lg overflow-hidden border border-[var(--ss-brand-outline)] bg-black/40 ${camTesting ? "" : "hidden"}`}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="w-full max-h-[240px] object-cover scale-x-[-1]"
            />
          </div>
          {!camTesting && (
            <div className="text-xs text-[var(--ss-brand-muted)]">
              Click "Test Camera" to see a live preview.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function ProfileSection() {
  const user = getUser();
  const token = getToken();
  const [profilePicture, setProfilePicture] = useState(user?.profilePicture || null);
  const [aboutMe, setAboutMe] = useState(user?.aboutMe || "");
  const [aboutMeSaved, setAboutMeSaved] = useState(user?.aboutMe || "");
  const [savingAbout, setSavingAbout] = useState(false);
  const [aboutMeError, setAboutMeError] = useState("");

  const handlePictureSaved = useCallback((pic, thumb) => {
    setProfilePicture(pic);
    // Update the stored user object so it reflects immediately
    const stored = getUser();
    if (stored) {
      stored.profilePicture = pic;
      stored.profilePictureThumbnail = thumb;
      localStorage.setItem("user", JSON.stringify(stored));
    }
  }, []);

  const handleSaveAboutMe = useCallback(async () => {
    setSavingAbout(true);
    setAboutMeError("");
    try {
      const res = await fetch(`${API_BASE}/api/users/me/profile`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ aboutMe }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Save failed (${res.status})`);
      }
      setAboutMeSaved(aboutMe);
      const stored = getUser();
      if (stored) {
        stored.aboutMe = aboutMe;
        localStorage.setItem("user", JSON.stringify(stored));
      }
    } catch (err) {
      console.error("Save about me error:", err);
      setAboutMeError(err.message || "Failed to save. Please try again.");
    } finally {
      setSavingAbout(false);
    }
  }, [aboutMe, token]);

  return (
    <section className="rounded-lg glass-panel p-5">
      <div className="font-semibold mb-1 text-[var(--ss-brand-ink)]">Profile</div>
      <div className="text-[var(--ss-brand-muted)] text-sm mb-4">
        Customize your profile picture and about me. Visible to all users.
      </div>

      <ProfilePictureEditor
        currentPicture={profilePicture}
        apiBase={API_BASE}
        token={token}
        onSaved={handlePictureSaved}
      />

      <div className="mt-5 pt-4 border-t border-[var(--ss-brand-outline)]">
        <label className="block text-sm font-medium text-[var(--ss-brand-ink)] mb-1.5">About Me</label>
        <textarea
          value={aboutMe}
          onChange={(e) => setAboutMe(e.target.value.slice(0, 200))}
          placeholder="Tell people a little about yourself..."
          rows={3}
          className="w-full rounded-lg bg-[var(--ss-brand-outline)] border border-[var(--ss-brand-outline)] px-3 py-2.5 text-sm text-[var(--ss-brand-ink)] outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)] transition-shadow resize-none placeholder:text-[var(--ss-brand-muted)]"
        />
        <div className="flex items-center justify-between mt-1.5">
          <span className="text-xs text-[var(--ss-brand-muted)]">{aboutMe.length}/200</span>
          {aboutMe !== aboutMeSaved && (
            <button
              onClick={handleSaveAboutMe}
              disabled={savingAbout}
              className="px-4 py-1.5 rounded-lg bg-[rgb(var(--ss-accent-rgb)/0.15)] hover:bg-[rgb(var(--ss-accent-rgb)/0.25)] border border-[rgb(var(--ss-accent-rgb)/0.3)] text-[rgb(var(--ss-accent-rgb))] text-sm font-medium transition-all disabled:opacity-50"
            >
              {savingAbout ? "Saving..." : "Save"}
            </button>
          )}
        </div>
        {aboutMeError && (
          <div className="mt-2 px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/20 text-sm text-red-300">
            {aboutMeError}
          </div>
        )}
      </div>
    </section>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const {
    textSize, accent, theme, audioInputDeviceId, videoInputDeviceId, synced,
    setTextSize, setAccent, setTheme, setAudioInputDeviceId, setVideoInputDeviceId, reset,
  } = useSettings();

  const [audioDevices, setAudioDevices] = useState([]);
  const [videoDevices, setVideoDevices] = useState([]);
  const [deviceError, setDeviceError] = useState("");

  const enumerateDevices = useCallback(async () => {
    try {
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

      if (stream) stream.getTracks().forEach((t) => t.stop());
    } catch (err) {
      setDeviceError("Could not access media devices. Check browser permissions.");
    }
  }, []);

  useEffect(() => {
    enumerateDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", enumerateDevices);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", enumerateDevices);
  }, [enumerateDevices]);

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px)-env(safe-area-inset-top,0px)-env(safe-area-inset-bottom,0px))] text-[var(--ss-brand-ink)]" style={{ backgroundColor: "var(--ss-brand-bg)" }}>
      <header className="sticky top-0 z-10 border-b border-[var(--ss-brand-outline)] bg-[var(--ss-brand-panel)]">
        <div className="h-14 px-4 flex items-center gap-3">
          <button
            onClick={() => navigate("/chat")}
            className="text-sm px-3 py-1.5 rounded-lg bg-[var(--ss-brand-outline)] hover:opacity-80 text-[var(--ss-brand-ink)]"
            type="button"
          >
            Back
          </button>

          <img src={logoWordmark} alt="SafeSpace" className="h-8 w-auto rounded-xl" />

          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold truncate">Settings</div>
            <div className="text-xs text-[var(--ss-brand-muted)] truncate">
              {synced ? "Synced to your account" : "Appearance & preferences"}
            </div>
          </div>

          <button
            onClick={reset}
            className="text-sm px-3 py-1.5 rounded-lg bg-[var(--ss-brand-outline)] hover:opacity-80 text-[var(--ss-brand-ink)]"
            type="button"
          >
            Reset
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Profile */}
        <ProfileSection />

        {/* Theme */}
        <section className="rounded-lg glass-panel p-5">
          <div className="font-semibold mb-1">Theme</div>
          <div className="text-[var(--ss-brand-muted)] text-sm mb-3">
            Choose between dark, light, or AMOLED black.
          </div>

          <div className="flex flex-wrap gap-2">
            {THEMES.map((t) => (
              <ChoiceButton key={t.key} active={theme === t.key} onClick={() => setTheme(t.key)}>
                {t.label}
              </ChoiceButton>
            ))}
          </div>
        </section>

        {/* Readability */}
        <section className="rounded-lg glass-panel p-5">
          <div className="font-semibold mb-1">Readability</div>
          <div className="text-[var(--ss-brand-muted)] text-sm mb-3">
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

          <div className="mt-4 rounded-lg border border-[var(--ss-brand-outline)] bg-[var(--ss-brand-outline)] p-3">
            <div className="text-[var(--ss-brand-muted)] ss-text-sm">Preview</div>
            <div className="mt-1 ss-text">
              This is what message text looks like with your selected size.
            </div>
          </div>
        </section>

        {/* Accent color */}
        <section className="rounded-lg glass-panel p-5">
          <div className="font-semibold mb-1">Accent color</div>
          <div className="text-[var(--ss-brand-muted)] text-sm mb-3">
            Changes highlights, buttons, and unread indicators.
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.key}
                onClick={() => setAccent(a.key)}
                className={[
                  "flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors",
                  accent === a.key
                    ? "bg-[rgb(var(--ss-accent-rgb)/0.15)] ring-1 ring-[rgb(var(--ss-accent-rgb)/0.45)]"
                    : "bg-[var(--ss-brand-outline)] hover:opacity-80",
                ].join(" ")}
                type="button"
              >
                <span
                  className="h-3 w-3 rounded-full"
                  style={{ backgroundColor: `rgb(${a.rgb})` }}
                />
                <span className="font-semibold">{a.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Message limits */}
        <section className="rounded-lg glass-panel p-5">
          <div className="font-semibold mb-1">Message limits</div>
          <div className="text-[var(--ss-brand-muted)] text-sm">
            Current max message length: <span className="font-semibold">4000 characters</span>.
          </div>
        </section>

        {/* Audio & Video Devices */}
        <section className="rounded-lg glass-panel p-5">
          <div className="font-semibold mb-1">Audio & Video Devices</div>
          <div className="text-[var(--ss-brand-muted)] text-sm mb-3">
            Select which microphone and camera to use for calls.
          </div>

          {deviceError && (
            <div className="mb-3 px-3 py-2 rounded-lg bg-red-500/15 text-sm text-red-300">
              {deviceError}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-1.5">Microphone</label>
              <select
                value={audioInputDeviceId}
                onChange={(e) => setAudioInputDeviceId(e.target.value)}
                className="w-full rounded-lg bg-[var(--ss-brand-outline)] border border-[var(--ss-brand-outline)] px-3 py-2.5 text-sm text-[var(--ss-brand-ink)] outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)] transition-shadow"
              >
                <option value="">System default</option>
                {audioDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1.5">Camera</label>
              <select
                value={videoInputDeviceId}
                onChange={(e) => setVideoInputDeviceId(e.target.value)}
                className="w-full rounded-lg bg-[var(--ss-brand-outline)] border border-[var(--ss-brand-outline)] px-3 py-2.5 text-sm text-[var(--ss-brand-ink)] outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)] transition-shadow"
              >
                <option value="">System default</option>
                {videoDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {(audioDevices.length === 0 && videoDevices.length === 0 && !deviceError) && (
            <div className="mt-3 text-sm text-[var(--ss-brand-muted)]">
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
