// Shared desktop download banner — shown on ALL pages in browser, hidden in Electron.
// Closeable with 7-day localStorage persistence.
import React, { useState, useEffect } from "react";

const DISMISS_KEY = "ss-desktop-banner-dismissed";
const DISMISS_DAYS = 7;

function detectOS() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac";
  return "linux";
}

const platformLabels = { windows: "Windows", mac: "macOS", linux: "Linux" };

export default function DesktopBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Never show in Electron
    if (typeof window === "undefined" || window.electronAPI) return;
    // Always show in browser — no dismiss check
    setVisible(true);
  }, []);

  // Set CSS variable so pages can account for banner height
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--ss-banner-h",
      visible ? "36px" : "0px"
    );
    return () =>
      document.documentElement.style.setProperty("--ss-banner-h", "0px");
  }, [visible]);

  if (!visible) return null;

  const os = detectOS();

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // ignore
    }
    setVisible(false);
  };

  return (
    <div className="shrink-0 bg-[rgb(var(--ss-accent-rgb))] text-slate-900 text-xs font-medium text-center py-2 px-4 flex items-center justify-center gap-2 relative z-[100]">
      <span>
        SafeSpace is available as a desktop app &mdash;{" "}
        <a href="/download" className="underline font-bold">
          Download for {platformLabels[os] || "your OS"}
        </a>
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-900/60 hover:text-slate-900 text-sm px-1.5 py-0.5 rounded hover:bg-black/10 transition-colors"
        aria-label="Dismiss"
      >
        &#x2715;
      </button>
    </div>
  );
}
