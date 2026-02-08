// Shared download/install banner - shown on ALL pages in browser, hidden in Electron & installed PWA.
// Captures beforeinstallprompt for one-tap install on Android/Chrome.
import React, { useState, useEffect, useRef } from "react";

const DISMISS_KEY = "ss-desktop-banner-dismissed";

function detectOS() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Android/i.test(ua)) return "android";
  if (/Win/i.test(platform) || /Windows/i.test(ua)) return "windows";
  if (/Mac/i.test(platform) || /Macintosh/i.test(ua)) return "mac";
  return "linux";
}

function isStandalone() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

const platformLabels = { windows: "Windows", mac: "macOS", linux: "Linux" };

export default function DesktopBanner() {
  const [visible, setVisible] = useState(false);
  const deferredPromptRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined" || window.electronAPI) return;
    if (isStandalone()) return;
    setVisible(true);

    const handler = (e) => {
      e.preventDefault();
      deferredPromptRef.current = e;
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

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

  const handleInstallClick = async () => {
    const prompt = deferredPromptRef.current;
    if (!prompt) return;
    prompt.prompt();
    const result = await prompt.userChoice;
    if (result.outcome === "accepted") {
      setVisible(false);
    }
    deferredPromptRef.current = null;
  };

  const isMac = os === "mac";
  const isMobile = os === "ios" || os === "android";

  return (
    <div className="shrink-0 bg-[rgb(var(--ss-accent-rgb))] text-slate-900 text-xs font-medium text-center py-2 px-4 flex items-center justify-center gap-2 relative z-[100]">
      <span>
        {isMobile ? (
          os === "ios" ? (
            <>Tap Share then "Add to Home Screen" to install SafeSpace</>
          ) : deferredPromptRef.current ? (
            <>
              Install SafeSpace as an app —{" "}
              <button
                type="button"
                onClick={handleInstallClick}
                className="underline font-bold"
              >
                Install now
              </button>
            </>
          ) : (
            <>Tap menu (⋮) then "Install app" to install SafeSpace</>
          )
        ) : isMac ? (
          <>Install SafeSpace as a web app — use your browser's "Add to Dock" option</>
        ) : (
          <>
            SafeSpace is available as a desktop app —{" "}
            <a href="/download" className="underline font-bold">
              Download for {platformLabels[os] || "your OS"}
            </a>
          </>
        )}
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
