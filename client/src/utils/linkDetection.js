// URL detection, YouTube parsing, and text linkification utilities.

const URL_REGEX = /https?:\/\/[^\s<>"')\]},]+/gi;

/**
 * Extract unique URLs from text.
 */
export function extractUrls(text) {
    if (!text || typeof text !== "string") return [];
    const matches = text.match(URL_REGEX);
    if (!matches) return [];
    // Deduplicate preserving order
    const seen = new Set();
    const results = [];
    for (const raw of matches) {
        // Strip trailing punctuation that's likely not part of the URL
        const url = raw.replace(/[.,;:!?)]+$/, "");
        if (!url || seen.has(url)) continue;
        seen.add(url);
        results.push(url);
    }
    return results;
}

/**
 * Parse a YouTube URL and return the video ID, or null.
 * Handles youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, youtube.com/embed/
 */
export function parseYouTubeUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^www\./, "").toLowerCase();
        // youtube.com/watch?v=ID
        if ((host === "youtube.com" || host === "m.youtube.com") && u.pathname === "/watch") {
            const v = u.searchParams.get("v");
            if (v && /^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
        }
        // youtube.com/shorts/ID or youtube.com/embed/ID
        if (host === "youtube.com" || host === "m.youtube.com") {
            const match = u.pathname.match(/^\/(shorts|embed)\/([a-zA-Z0-9_-]{11})/);
            if (match) return match[2];
        }
        // youtu.be/ID
        if (host === "youtu.be") {
            const id = u.pathname.slice(1).split(/[/?&#]/)[0];
            if (id && /^[a-zA-Z0-9_-]{11}$/.test(id)) return id;
        }
    } catch {
        return null;
    }
    return null;
}

/**
 * Split text into segments of {type:"text", content} and {type:"link", content, url}.
 * Preserves whitespace and ordering.
 */
export function linkifyText(text) {
    if (!text || typeof text !== "string") return [{ type: "text", content: text || "" }];
    const segments = [];
    let lastIndex = 0;
    const regex = new RegExp(URL_REGEX.source, "gi");
    let match;
    while ((match = regex.exec(text)) !== null) {
        const url = match[0].replace(/[.,;:!?)]+$/, "");
        const matchEnd = match.index + url.length;
        // Adjust regex lastIndex in case we stripped trailing chars
        regex.lastIndex = matchEnd;
        if (match.index > lastIndex) {
            segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
        }
        segments.push({ type: "link", content: url, url });
        lastIndex = matchEnd;
    }
    if (lastIndex < text.length) {
        segments.push({ type: "text", content: text.slice(lastIndex) });
    }
    return segments.length > 0 ? segments : [{ type: "text", content: text }];
}
