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
  mac: { label: "macOS", ext: ".zip" },
  linux: { label: "Linux", ext: ".AppImage" },
};

function MacInstall({ version }) {
  const [copied, setCopied] = useState(false);
  const cmd = `curl -sL ${API_BASE}/api/install-mac | bash`;

  const copy = () => {
    navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300 font-medium text-center">
        Install for macOS
        {version && <span className="ml-1 text-xs text-slate-500">v{version}</span>}
      </p>
      <p className="text-xs text-slate-400 text-center">
        Open Terminal and paste this command:
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 block text-xs bg-black/40 rounded-lg px-3 py-2.5 text-slate-200 font-mono select-all overflow-x-auto">
          {cmd}
        </code>
        <button
          onClick={copy}
          className="shrink-0 px-3 py-2.5 rounded-lg bg-[rgb(var(--ss-accent-rgb))] text-slate-900 text-xs font-semibold hover:brightness-110 transition"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="text-xs text-slate-500 text-center">
        Downloads, installs, and opens SafeSpace automatically.
      </p>
    </div>
  );
}

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
          {/* macOS uses install command, other platforms use direct download */}
          {os === "mac" ? (
            <MacInstall version={version} />
          ) : (
            <a
              href={`${API_BASE}/api/download/${os}`}
              className="block w-full py-3 rounded-xl bg-[rgb(var(--ss-accent-rgb))] text-slate-900 font-semibold text-center shadow hover:brightness-110 active:scale-[0.99] transition"
            >
              Download for {platforms[os].label}
              {version && (
                <span className="ml-1 text-xs opacity-70">v{version}</span>
              )}
            </a>
          )}

          {/* Other platforms */}
          <div className="pt-2 border-t border-white/10">
            <div className="text-xs text-slate-400 mb-2">Other platforms</div>
            <div className="flex gap-2">
              {others.map((p) => (
                <a
                  key={p}
                  href={p === "mac" ? "#" : `${API_BASE}/api/download/${p}`}
                  onClick={p === "mac" ? (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); } : undefined}
                  className="flex-1 py-2 rounded-xl bg-white/5 border border-white/10 text-slate-200 text-sm font-medium text-center hover:bg-white/10 transition"
                >
                  {platforms[p].label}
                </a>
              ))}
            </div>
          </div>

          <p className="text-xs text-slate-500 text-center pt-1">
            Or use SafeSpace directly in your browser - no install needed.
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
