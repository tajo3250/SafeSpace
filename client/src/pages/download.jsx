import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import BrandHeader from "../components/brand/BrandHeader";
import { API_BASE } from "../config";

function detectOS() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac";
  return "linux";
}

const platforms = {
  windows: { label: "Windows", ext: ".exe" },
  mac: { label: "macOS", ext: ".dmg" },
  linux: { label: "Linux", ext: ".AppImage" },
};

export default function Download() {
  const os = detectOS();
  const [version, setVersion] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/desktop-version`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.version) setVersion(data.version);
      })
      .catch(() => {});
  }, []);

  const others = Object.keys(platforms).filter((p) => p !== os);

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px))] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl glass-panel p-6 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)]">
        <BrandHeader
          title="Get SafeSpace"
          subtitle="Encrypted messaging, on every device."
        />

        <div className="mt-6 space-y-3">
          {/* Primary download button */}
          <a
            href={`${API_BASE}/api/download/${os}`}
            className="block w-full py-3 rounded-xl bg-[rgb(var(--ss-accent-rgb))] text-slate-900 font-semibold text-center shadow hover:brightness-110 active:scale-[0.99] transition"
          >
            Download for {platforms[os].label}
            {version && (
              <span className="ml-1 text-xs opacity-70">v{version}</span>
            )}
          </a>

          {/* Other platforms */}
          <div className="pt-2 border-t border-white/10">
            <div className="text-xs text-slate-400 mb-2">Other platforms</div>
            <div className="flex gap-2">
              {others.map((p) => (
                <a
                  key={p}
                  href={`${API_BASE}/api/download/${p}`}
                  className="flex-1 py-2 rounded-xl bg-white/5 border border-white/10 text-slate-200 text-sm font-medium text-center hover:bg-white/10 transition"
                >
                  {platforms[p].label}
                </a>
              ))}
            </div>
          </div>

          <p className="text-xs text-slate-500 text-center pt-1">
            Or use SafeSpace directly in your browser &mdash; no install needed.
          </p>
        </div>

        <div className="mt-4 text-center text-sm">
          <Link
            className="text-[rgb(var(--ss-accent-rgb))] hover:underline"
            to="/"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
