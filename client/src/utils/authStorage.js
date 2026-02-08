// Thin auth storage helper — supports "remember me" by choosing
// between localStorage (persistent) and sessionStorage (tab-scoped).
// Desktop app always uses localStorage so sessions survive app restarts.

const isDesktop = typeof window !== "undefined" && !!window.electronAPI;

export function getToken() {
  return sessionStorage.getItem("token") || localStorage.getItem("token");
}

export function getUser() {
  const raw = sessionStorage.getItem("user") || localStorage.getItem("user");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setAuth(token, user, remember) {
  // Desktop app always persists — no session-only mode
  const persist = isDesktop || remember;
  const storage = persist ? localStorage : sessionStorage;
  storage.setItem("token", token);
  storage.setItem("user", JSON.stringify(user));
  // Clear the other storage to avoid stale data
  const other = persist ? sessionStorage : localStorage;
  other.removeItem("token");
  other.removeItem("user");
}

export function clearAuth() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("user");
}
