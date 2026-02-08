import React from "react";

export default function ReactionDisplay({ reactions, currentUserId, allUsers, onToggleReaction }) {
    if (!reactions || typeof reactions !== "object") return null;
    const entries = Object.entries(reactions).filter(
        ([, userIds]) => Array.isArray(userIds) && userIds.length > 0
    );
    if (entries.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-1 mt-1.5">
            {entries.map(([emoji, userIds]) => {
                const isMine = currentUserId && userIds.includes(String(currentUserId));
                const names = userIds
                    .map((uid) => {
                        if (String(uid) === String(currentUserId)) return "You";
                        const user = allUsers?.find((u) => String(u.id) === String(uid));
                        return user?.username || "Unknown";
                    })
                    .join(", ");
                return (
                    <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                            if (onToggleReaction) onToggleReaction(emoji);
                        }}
                        className={[
                            "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors border",
                            isMine
                                ? "bg-[rgb(var(--ss-accent-rgb)/0.2)] border-[rgb(var(--ss-accent-rgb)/0.4)] text-[rgb(var(--ss-accent-rgb))]"
                                : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10",
                        ].join(" ")}
                        title={names}
                    >
                        <span className="text-sm leading-none">{emoji}</span>
                        <span className="font-medium">{userIds.length}</span>
                    </button>
                );
            })}
        </div>
    );
}
