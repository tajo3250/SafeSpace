import { API_BASE } from "../config";

const isUploadsPath = (path) => typeof path === "string" && path.startsWith("/uploads/");

const getApiBase = () => {
  if (API_BASE) return API_BASE;
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return "";
};

export const resolveAttachmentUrl = (url) => {
  if (!url || typeof url !== "string") return "";
  const trimmed = url.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return trimmed;

  const apiBase = getApiBase();

  if (trimmed.startsWith("/")) {
    if (apiBase && isUploadsPath(trimmed)) {
      return `${apiBase}${trimmed}`;
    }
    return trimmed;
  }

  try {
    const parsed = new URL(trimmed);
    if (!isUploadsPath(parsed.pathname) || !apiBase) {
      return trimmed;
    }
    const base = new URL(apiBase);
    parsed.protocol = base.protocol;
    parsed.host = base.host;
    return parsed.toString();
  } catch {
    return trimmed;
  }
};
