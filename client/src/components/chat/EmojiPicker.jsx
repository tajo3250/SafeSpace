import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { emojiCategories, searchEmojis } from "../../data/emojiData";

const RECENT_KEY = "ss-recent-emojis";
const MAX_RECENT = 32;

function loadRecent() {
    try {
        const raw = localStorage.getItem(RECENT_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr.slice(0, MAX_RECENT) : [];
    } catch {
        return [];
    }
}

function saveRecent(list) {
    try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
    } catch {
        // ignore
    }
}

export default function EmojiPicker({ isOpen, onClose, onSelectEmoji }) {
    const inputRef = useRef(null);
    const gridRef = useRef(null);
    const [query, setQuery] = useState("");
    const [activeCategory, setActiveCategory] = useState(null);
    const [recentEmojis, setRecentEmojis] = useState(loadRecent);

    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (event) => {
            if (event.key === "Escape") onClose();
        };
        window.addEventListener("keydown", handleKey);
        return () => window.removeEventListener("keydown", handleKey);
    }, [isOpen, onClose]);

    useEffect(() => {
        if (isOpen && inputRef.current) {
            inputRef.current.focus();
        }
        if (isOpen) {
            setQuery("");
            setActiveCategory(null);
            setRecentEmojis(loadRecent());
        }
    }, [isOpen]);

    const searchResults = useMemo(() => {
        const term = query.trim();
        if (!term || term.length < 2) return null;
        return searchEmojis(term);
    }, [query]);

    const handleSelect = useCallback(
        (emojiObj) => {
            if (!emojiObj) return;
            const char = typeof emojiObj === "string" ? emojiObj : emojiObj.emoji;
            if (!char) return;

            // Update recent
            setRecentEmojis((prev) => {
                const next = [char, ...prev.filter((e) => e !== char)].slice(0, MAX_RECENT);
                saveRecent(next);
                return next;
            });

            if (onSelectEmoji) onSelectEmoji(char);
        },
        [onSelectEmoji]
    );

    const scrollToCategory = useCallback((categoryName) => {
        setActiveCategory(categoryName);
        setQuery("");
        const el = document.getElementById(`emoji-cat-${categoryName}`);
        if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
    }, []);

    if (!isOpen) return null;

    const hasRecent = recentEmojis.length > 0;
    const isSearching = searchResults !== null;

    return (
        <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
            <button
                type="button"
                aria-label="Close emoji picker"
                onClick={onClose}
                className="absolute inset-0 bg-black/70"
            />
            <div className="relative w-full max-w-lg max-h-[85vh] rounded-2xl glass-panel overflow-hidden flex flex-col">
                {/* Header */}
                <div className="px-5 py-4 border-b border-white/10 space-y-3">
                    <div className="flex items-center gap-3">
                        <input
                            ref={inputRef}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder="Search emojis..."
                            className="flex-1 rounded-xl bg-white/5 border border-white/10 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)]"
                        />
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-sm text-slate-100"
                        >
                            Close
                        </button>
                    </div>

                    {/* Category bar */}
                    {!isSearching && (
                        <div className="flex items-center gap-1 overflow-x-auto pb-1 custom-scrollbar">
                            {hasRecent && (
                                <button
                                    type="button"
                                    onClick={() => scrollToCategory("Recent")}
                                    className={[
                                        "shrink-0 h-8 w-8 rounded-lg flex items-center justify-center text-base transition-colors",
                                        activeCategory === "Recent"
                                            ? "bg-white/10 border border-white/10"
                                            : "hover:bg-white/5",
                                    ].join(" ")}
                                    title="Recent"
                                >
                                    🕐
                                </button>
                            )}
                            {emojiCategories.map((cat) => (
                                <button
                                    key={cat.name}
                                    type="button"
                                    onClick={() => scrollToCategory(cat.name)}
                                    className={[
                                        "shrink-0 h-8 w-8 rounded-lg flex items-center justify-center text-base transition-colors",
                                        activeCategory === cat.name
                                            ? "bg-white/10 border border-white/10"
                                            : "hover:bg-white/5",
                                    ].join(" ")}
                                    title={cat.name}
                                >
                                    {cat.icon}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Grid */}
                <div ref={gridRef} className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                    {isSearching ? (
                        <>
                            {searchResults.length === 0 ? (
                                <div className="text-center text-sm text-slate-400 py-10">
                                    No emojis found.
                                </div>
                            ) : (
                                <div className="grid grid-cols-8 gap-1">
                                    {searchResults.map((item) => (
                                        <button
                                            key={item.emoji + item.name}
                                            type="button"
                                            onClick={() => handleSelect(item)}
                                            className="h-10 w-full rounded-lg hover:bg-white/10 flex items-center justify-center text-2xl transition-colors"
                                            title={item.name}
                                        >
                                            {item.emoji}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </>
                    ) : (
                        <>
                            {hasRecent && (
                                <div id="emoji-cat-Recent" className="mb-4">
                                    <div className="text-xs text-slate-400 font-semibold mb-2 px-1">
                                        Recently Used
                                    </div>
                                    <div className="grid grid-cols-8 gap-1">
                                        {recentEmojis.map((char, i) => (
                                            <button
                                                key={`recent-${char}-${i}`}
                                                type="button"
                                                onClick={() => handleSelect(char)}
                                                className="h-10 w-full rounded-lg hover:bg-white/10 flex items-center justify-center text-2xl transition-colors"
                                                title={char}
                                            >
                                                {char}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}

                            {emojiCategories.map((cat) => (
                                <div key={cat.name} id={`emoji-cat-${cat.name}`} className="mb-4">
                                    <div className="text-xs text-slate-400 font-semibold mb-2 px-1">
                                        {cat.name}
                                    </div>
                                    <div className="grid grid-cols-8 gap-1">
                                        {cat.emojis.map((item) => (
                                            <button
                                                key={item.emoji + item.name}
                                                type="button"
                                                onClick={() => handleSelect(item)}
                                                className="h-10 w-full rounded-lg hover:bg-white/10 flex items-center justify-center text-2xl transition-colors"
                                                title={item.name}
                                            >
                                                {item.emoji}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}
                </div>

                <div className="px-5 py-3 border-t border-white/10 text-[11px] text-slate-400">
                    Click an emoji to insert
                </div>
            </div>
        </div>
    );
}
