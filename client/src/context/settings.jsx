// src/context/settings.jsx
import React, { createContext, useContext, useEffect, useMemo, useState, useCallback, useRef } from "react";
import { API_BASE } from "../config";
import { getToken, getUser } from "../utils/authStorage";

const SettingsContext = createContext(null);

const STORAGE_KEY_PREFIX = "ss_settings_";

const VALID_THEMES = ["dark", "light", "amoled"];
const VALID_ACCENTS = ["teal", "blue", "purple", "rose", "amber", "lime"];

const DEFAULT_SETTINGS = {
  textSize: "md", // sm | md | lg
  accent: "teal", // teal | blue | purple | rose | amber | lime
  theme: "dark", // dark | light | amoled
  audioInputDeviceId: "", // microphone device ID (empty = system default)
  videoInputDeviceId: "", // camera device ID (empty = system default)
};

function getStorageKey() {
  const user = getUser();
  const userId = user?.id || "anonymous";
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

function readStoredSettings() {
  try {
    // Try per-user key first
    const key = getStorageKey();
    let raw = localStorage.getItem(key);

    // Fall back to legacy shared key and migrate
    if (!raw) {
      raw = localStorage.getItem("ss_settings_v1");
      if (raw) {
        localStorage.setItem(key, raw);
        localStorage.removeItem("ss_settings_v1");
      }
    }

    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);

    return {
      textSize:
        parsed?.textSize === "sm" || parsed?.textSize === "lg" ? parsed.textSize : "md",
      accent:
        VALID_ACCENTS.includes(parsed?.accent)
          ? parsed.accent
          : "teal",
      theme:
        VALID_THEMES.includes(parsed?.theme)
          ? parsed.theme
          : "dark",
      audioInputDeviceId:
        typeof parsed?.audioInputDeviceId === "string" ? parsed.audioInputDeviceId : "",
      videoInputDeviceId:
        typeof parsed?.videoInputDeviceId === "string" ? parsed.videoInputDeviceId : "",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function applyToDom(settings) {
  const root = document.documentElement;
  root.dataset.ssFont = settings.textSize;
  root.dataset.ssAccent = settings.accent;
  root.dataset.ssTheme = settings.theme || "dark";
}

// Sync-able keys (these get saved to the server)
const SYNC_KEYS = ["textSize", "accent", "theme"];

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(() => {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    return readStoredSettings();
  });
  const [synced, setSynced] = useState(false);
  const syncTimeoutRef = useRef(null);
  const lastFetchedUserRef = useRef(null);

  // Persist to per-user localStorage
  useEffect(() => {
    try {
      const key = getStorageKey();
      localStorage.setItem(key, JSON.stringify(settings));
    } catch {
      // ignore
    }
    applyToDom(settings);
  }, [settings]);

  // apply once on mount
  useEffect(() => {
    applyToDom(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch settings from server on mount and whenever the logged-in user changes
  useEffect(() => {
    const token = getToken();
    if (!token) return;

    const user = getUser();
    const userId = user?.id || null;

    // Only re-fetch if the user changed since last fetch
    if (lastFetchedUserRef.current === userId) return;
    lastFetchedUserRef.current = userId;

    // Read per-user local settings first (in case switching accounts)
    const localSettings = readStoredSettings();
    setSettings(localSettings);

    fetch(`${API_BASE}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.settings && typeof data.settings === "object") {
          const s = data.settings;
          setSettings((prev) => {
            const merged = { ...prev };
            // Server settings take priority for synced keys
            if (s.textSize === "sm" || s.textSize === "md" || s.textSize === "lg") merged.textSize = s.textSize;
            if (VALID_ACCENTS.includes(s.accent)) merged.accent = s.accent;
            if (VALID_THEMES.includes(s.theme)) merged.theme = s.theme;
            return merged;
          });
          setSynced(true);
        }
      })
      .catch(() => {});
  }, []);

  // Also re-fetch when storage changes (e.g., login in another tab)
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === "token" || e.key === "user") {
        const token = getToken();
        const user = getUser();
        const userId = user?.id || null;
        if (token && userId !== lastFetchedUserRef.current) {
          lastFetchedUserRef.current = userId;
          const localSettings = readStoredSettings();
          setSettings(localSettings);

          fetch(`${API_BASE}/api/settings`, {
            headers: { Authorization: `Bearer ${token}` },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data?.settings && typeof data.settings === "object") {
                const s = data.settings;
                setSettings((prev) => {
                  const merged = { ...prev };
                  if (s.textSize === "sm" || s.textSize === "md" || s.textSize === "lg") merged.textSize = s.textSize;
                  if (VALID_ACCENTS.includes(s.accent)) merged.accent = s.accent;
                  if (VALID_THEMES.includes(s.theme)) merged.theme = s.theme;
                  return merged;
                });
                setSynced(true);
              }
            })
            .catch(() => {});
        }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Push settings to server (debounced)
  const pushToServer = useCallback((newSettings) => {
    if (syncTimeoutRef.current) clearTimeout(syncTimeoutRef.current);
    syncTimeoutRef.current = setTimeout(() => {
      const token = getToken();
      if (!token) return;
      const payload = {};
      for (const k of SYNC_KEYS) {
        if (newSettings[k] !== undefined) payload[k] = newSettings[k];
      }
      fetch(`${API_BASE}/api/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      })
        .then((r) => { if (r.ok) setSynced(true); })
        .catch(() => {});
    }, 600);
  }, []);

  // Expose a refreshFromServer method for use after login
  const refreshFromServer = useCallback(() => {
    const token = getToken();
    if (!token) return;
    const user = getUser();
    lastFetchedUserRef.current = user?.id || null;
    const localSettings = readStoredSettings();
    setSettings(localSettings);

    fetch(`${API_BASE}/api/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data?.settings && typeof data.settings === "object") {
          const s = data.settings;
          setSettings((prev) => {
            const merged = { ...prev };
            if (s.textSize === "sm" || s.textSize === "md" || s.textSize === "lg") merged.textSize = s.textSize;
            if (VALID_ACCENTS.includes(s.accent)) merged.accent = s.accent;
            if (VALID_THEMES.includes(s.theme)) merged.theme = s.theme;
            return merged;
          });
          setSynced(true);
        }
      })
      .catch(() => {});
  }, []);

  const value = useMemo(
    () => ({
      textSize: settings.textSize,
      accent: settings.accent,
      theme: settings.theme,
      audioInputDeviceId: settings.audioInputDeviceId,
      videoInputDeviceId: settings.videoInputDeviceId,
      synced,
      refreshFromServer,
      setTextSize: (textSize) => {
        const v = textSize === "sm" || textSize === "lg" ? textSize : "md";
        setSettings((prev) => {
          const next = { ...prev, textSize: v };
          pushToServer(next);
          return next;
        });
      },
      setAccent: (accent) => {
        const v = VALID_ACCENTS.includes(accent) ? accent : "teal";
        setSettings((prev) => {
          const next = { ...prev, accent: v };
          pushToServer(next);
          return next;
        });
      },
      setTheme: (theme) => {
        const v = VALID_THEMES.includes(theme) ? theme : "dark";
        setSettings((prev) => {
          const next = { ...prev, theme: v };
          pushToServer(next);
          return next;
        });
      },
      setAudioInputDeviceId: (deviceId) =>
        setSettings((prev) => ({
          ...prev,
          audioInputDeviceId: typeof deviceId === "string" ? deviceId : "",
        })),
      setVideoInputDeviceId: (deviceId) =>
        setSettings((prev) => ({
          ...prev,
          videoInputDeviceId: typeof deviceId === "string" ? deviceId : "",
        })),
      reset: () => {
        setSettings(DEFAULT_SETTINGS);
        pushToServer(DEFAULT_SETTINGS);
      },
    }),
    [settings, synced, pushToServer, refreshFromServer]
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const ctx = useContext(SettingsContext);
  if (!ctx) {
    return {
      ...DEFAULT_SETTINGS,
      synced: false,
      refreshFromServer: () => {},
      setTextSize: () => {},
      setAccent: () => {},
      setTheme: () => {},
      setAudioInputDeviceId: () => {},
      setVideoInputDeviceId: () => {},
      reset: () => {},
    };
  }
  return ctx;
}
