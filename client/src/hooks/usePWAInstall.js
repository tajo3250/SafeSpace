import { useState, useEffect, useRef, useCallback } from "react";

export function usePWAInstall() {
  const [canInstall, setCanInstall] = useState(false);
  const [isIOS, setIsIOS] = useState(false);
  const deferredPrompt = useRef(null);

  useEffect(() => {
    // Detect iOS Safari (no beforeinstallprompt on iOS)
    const ua = navigator.userAgent || "";
    const iOS =
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|Chrome/i.test(ua);

    if (
      iOS &&
      isSafari &&
      !window.matchMedia("(display-mode: standalone)").matches
    ) {
      setIsIOS(true);
    }

    const handler = (e) => {
      e.preventDefault();
      deferredPrompt.current = e;
      setCanInstall(true);
    };

    window.addEventListener("beforeinstallprompt", handler);

    // If already installed as PWA, hide install option
    if (window.matchMedia("(display-mode: standalone)").matches) {
      setCanInstall(false);
      setIsIOS(false);
    }

    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt.current) return false;
    deferredPrompt.current.prompt();
    const { outcome } = await deferredPrompt.current.userChoice;
    deferredPrompt.current = null;
    setCanInstall(false);
    return outcome === "accepted";
  }, []);

  return { canInstall, isIOS, promptInstall };
}
