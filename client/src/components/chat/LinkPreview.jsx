import React, { useEffect, useState } from "react";
import { parseYouTubeUrl } from "../../utils/linkDetection";
import { getToken } from "../../utils/authStorage";

// Module-level cache to avoid refetching on re-renders
const previewCache = new Map();

export default function LinkPreview({ url }) {
    const [preview, setPreview] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);

    const youtubeId = parseYouTubeUrl(url);

    useEffect(() => {
        if (youtubeId || !url) return;

        // Check cache first
        if (previewCache.has(url)) {
            const cached = previewCache.get(url);
            if (cached === "error") {
                setError(true);
            } else {
                setPreview(cached);
            }
            return;
        }

        let cancelled = false;
        setLoading(true);
        setError(false);
        setPreview(null);

        const token = getToken();
        fetch(`/api/link-preview?url=${encodeURIComponent(url)}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        })
            .then((res) => {
                if (!res.ok) throw new Error("fetch failed");
                return res.json();
            })
            .then((data) => {
                if (cancelled) return;
                if (data && (data.title || data.description || data.image)) {
                    previewCache.set(url, data);
                    setPreview(data);
                } else {
                    previewCache.set(url, "error");
                    setError(true);
                }
            })
            .catch(() => {
                if (cancelled) return;
                previewCache.set(url, "error");
                setError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [url, youtubeId]);

    // YouTube embed
    if (youtubeId) {
        const embedUrl = `https://www.youtube-nocookie.com/embed/${youtubeId}?origin=${encodeURIComponent(window.location.origin)}&rel=0`;
        const thumbUrl = `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`;
        const watchUrl = `https://www.youtube.com/watch?v=${youtubeId}`;

        if (error) {
            // Fallback: clickable thumbnail linking to YouTube
            return (
                <a
                    href={watchUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 block w-full max-w-[400px] rounded-xl overflow-hidden border border-white/10 bg-black/30 relative group"
                >
                    <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                        <img
                            src={thumbUrl}
                            alt="YouTube video thumbnail"
                            className="absolute inset-0 w-full h-full object-cover"
                            loading="lazy"
                        />
                        <div className="absolute inset-0 flex items-center justify-center bg-black/30 group-hover:bg-black/40 transition-colors">
                            <svg className="w-16 h-16 text-white/90" viewBox="0 0 68 48" fill="none">
                                <path d="M66.52 7.74c-.78-2.93-2.49-5.41-5.42-6.19C55.79.13 34 0 34 0S12.21.13 6.9 1.55C3.97 2.33 2.27 4.81 1.48 7.74.06 13.05 0 24 0 24s.06 10.95 1.48 16.26c.78 2.93 2.49 5.41 5.42 6.19C12.21 47.87 34 48 34 48s21.79-.13 27.1-1.55c2.93-.78 4.64-3.26 5.42-6.19C67.94 34.95 68 24 68 24s-.06-10.95-1.48-16.26z" fill="red"/>
                                <path d="M45 24L27 14v20" fill="white"/>
                            </svg>
                        </div>
                    </div>
                </a>
            );
        }

        return (
            <div className="mt-2 w-full max-w-[400px] rounded-xl overflow-hidden border border-white/10 bg-black/30">
                <div className="relative w-full" style={{ paddingBottom: "56.25%" }}>
                    <iframe
                        className="absolute inset-0 w-full h-full"
                        src={embedUrl}
                        title="YouTube video"
                        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                        loading="lazy"
                        onError={() => setError(true)}
                        referrerPolicy="origin"
                    />
                </div>
            </div>
        );
    }

    if (loading) {
        return (
            <div className="mt-2 w-full max-w-[400px] rounded-xl border border-white/10 bg-white/5 px-4 py-3">
                <div className="h-3 w-32 rounded bg-white/10 animate-pulse" />
                <div className="h-2 w-48 rounded bg-white/10 animate-pulse mt-2" />
            </div>
        );
    }

    if (error || !preview) return null;

    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 flex w-full max-w-[400px] rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 overflow-hidden transition-colors no-underline group"
        >
            {preview.image && (
                <div className="shrink-0 w-24 h-24 bg-black/20">
                    <img
                        src={preview.image}
                        alt=""
                        className="w-full h-full object-cover"
                        loading="lazy"
                        decoding="async"
                        onError={(e) => {
                            e.target.style.display = "none";
                        }}
                    />
                </div>
            )}
            <div className="flex-1 min-w-0 px-3 py-2.5">
                {preview.siteName && (
                    <div className="text-[10px] text-[rgb(var(--ss-accent-rgb))] font-semibold uppercase tracking-wider truncate">
                        {preview.siteName}
                    </div>
                )}
                {preview.title && (
                    <div className="text-sm text-slate-200 font-medium truncate group-hover:text-white transition-colors">
                        {preview.title}
                    </div>
                )}
                {preview.description && (
                    <div className="text-xs text-slate-400 mt-0.5 line-clamp-2">
                        {preview.description}
                    </div>
                )}
            </div>
        </a>
    );
}
