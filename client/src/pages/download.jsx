import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import BrandHeader from "../components/brand/BrandHeader";
import { API_BASE } from "../config";

function detectOS() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac";
  return "linux";
}

const desktopPlatforms = {
  windows: { label: "Windows", ext: ".exe" },
  linux: { label: "Linux", ext: ".AppImage" },
};

function MacPWAInstall() {
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300 font-medium text-center">
        Install for macOS
      </p>
      <p className="text-xs text-slate-400 text-center leading-relaxed">
        In Safari or Chrome, click the <strong>Share</strong> button (or the install icon in the address bar)
        and choose <strong>"Add to Dock"</strong> to install SafeSpace as an app.
      </p>
      <p className="text-xs text-slate-500 text-center">
        Works just like a native app — no download needed.
      </p>
    </div>
  );
}

function MobilePWAInstall({ os }) {
  const isIOS = os === "ios";
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-300 font-medium text-center">
        Install for {isIOS ? "iPhone / iPad" : "Android"}
      </p>
      {isIOS ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-400 text-center leading-relaxed">
            In <strong>Safari</strong>, tap the{" "}
            <strong className="inline-flex items-center gap-1">
              Share
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="inline -mt-0.5"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            </strong>{" "}
            button, then choose <strong>"Add to Home Screen"</strong>.
          </p>
          <p className="text-[11px] text-slate-500 text-center">
            Must use Safari — other browsers on iOS don't support installing web apps.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-slate-400 text-center leading-relaxed">
            Tap the <strong>"Install"</strong> banner at the bottom of your screen,
            or tap the <strong>menu (⋮)</strong> and choose <strong>"Install app"</strong> or <strong>"Add to Home screen"</strong>.
          </p>
        </div>
      )}
      <p className="text-xs text-slate-500 text-center">
        Opens full-screen, just like a native app.
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

  const isMobile = os === "ios" || os === "android";
  const isDesktop = os === "windows" || os === "linux";
  const isMac = os === "mac";

  // For desktop: show the other desktop platform as an alternate download
  const otherDesktop = isDesktop
    ? ["windows", "linux"].filter((p) => p !== os)
    : ["windows", "linux"];

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px))] flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl glass-panel p-6 shadow-[0_30px_120px_-70px_rgba(0,0,0,0.9)]">
        <BrandHeader
          title="Get SafeSpace"
          subtitle="Encrypted messaging, on every device."
        />

        <div className="mt-6 space-y-3">
          {/* Primary action based on OS */}
          {isMobile && <MobilePWAInstall os={os} />}
          {isMac && <MacPWAInstall />}
          {isDesktop && (
            <>
              <a
                href={`${API_BASE}/api/download/${os}`}
                className="block w-full py-3 rounded-xl bg-[rgb(var(--ss-accent-rgb))] text-slate-900 font-semibold text-center shadow hover:brightness-110 active:scale-[0.99] transition"
              >
                Download for {desktopPlatforms[os]?.label || os}
                {version && (
                  <span className="ml-1 text-xs opacity-70">v{version}</span>
                )}
              </a>
              <p className="text-xs text-slate-500 text-center">
                The desktop app is the recommended way to use SafeSpace on {desktopPlatforms[os]?.label || os}.
                <br />
                The web app is only available for macOS.
              </p>
            </>
          )}

          {/* Other platforms section — only for desktop and Mac */}
          {!isMobile && (
            <div className="pt-2 border-t border-white/10">
              <div className="text-xs text-slate-400 mb-2">Other platforms</div>
              <div className="flex gap-2">
                {otherDesktop.map((p) => (
                  <a
                    key={p}
                    href={`${API_BASE}/api/download/${p}`}
                    className="flex-1 py-2 rounded-xl bg-white/5 border border-white/10 text-slate-200 text-sm font-medium text-center hover:bg-white/10 transition"
                  >
                    {desktopPlatforms[p]?.label || p}
                  </a>
                ))}
              </div>
            </div>
          )}
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
