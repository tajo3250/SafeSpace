import React, { useEffect, useRef } from "react";

const QUICK_EMOJIS = [
    { emoji: "\u{1F44D}", name: "thumbs up" },
    { emoji: "\u2764\uFE0F", name: "red heart" },
    { emoji: "\u{1F602}", name: "joy" },
    { emoji: "\u{1F62E}", name: "surprised" },
    { emoji: "\u{1F622}", name: "crying" },
    { emoji: "\u{1F525}", name: "fire" },
    { emoji: "\u{1F389}", name: "party" },
    { emoji: "\u{1F440}", name: "eyes" },
];

export default function ReactionPicker({ isOpen, rect, onSelect, onClose }) {
    const ref = useRef(null);

    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e) => {
            if (ref.current && !ref.current.contains(e.target)) {
                onClose();
            }
        };
        const handleKey = (e) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("mousedown", handleClick);
        document.addEventListener("touchstart", handleClick);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleClick);
            document.removeEventListener("touchstart", handleClick);
            document.removeEventListener("keydown", handleKey);
        };
    }, [isOpen, onClose]);

    if (!isOpen || !rect) return null;

    // Position the popover centered on the trigger button, clamped to viewport
    const pickerWidth = 296;
    const centerLeft = rect.left + rect.width / 2 - pickerWidth / 2;
    const clampedLeft = Math.max(8, Math.min(centerLeft, window.innerWidth - pickerWidth - 8));
    const style = {
        position: "fixed",
        zIndex: 80,
        left: clampedLeft,
        top: rect.top - 48,
    };
    // If too close to top, show below
    if (style.top < 8) {
        style.top = rect.bottom + 4;
    }

    return (
        <div ref={ref} style={style} className="animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-0.5 px-2 py-1.5 rounded-xl glass-panel border border-white/10 shadow-[0_16px_50px_-30px_rgba(0,0,0,0.9)]">
                {QUICK_EMOJIS.map((item) => (
                    <button
                        key={item.emoji}
                        type="button"
                        onClick={() => onSelect(item.emoji)}
                        className="h-9 w-9 rounded-lg hover:bg-white/10 flex items-center justify-center text-xl transition-all hover:scale-110"
                        title={item.name}
                    >
                        {item.emoji}
                    </button>
                ))}
            </div>
        </div>
    );
}
