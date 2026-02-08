// Auth storage helper - always uses localStorage for persistent sessions.

export function getToken() {
  return localStorage.getItem("token") || sessionStorage.getItem("token");
}

export function getUser() {
  const raw = localStorage.getItem("user") || sessionStorage.getItem("user");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function setAuth(token, user) {
  localStorage.setItem("token", token);
  localStorage.setItem("user", JSON.stringify(user));
  // Clean up any stale sessionStorage data from older versions
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("user");
}

export function clearAuth() {
  localStorage.removeItem("token");
  localStorage.removeItem("user");
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("user");
}
