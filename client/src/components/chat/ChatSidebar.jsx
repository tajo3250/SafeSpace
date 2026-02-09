import React, { useState, useRef, useEffect } from "react";
import logoWordmark from "../../assets/brand/logo-wordmark.svg";

export default function ChatSidebar({
    isSidebarOpen,
    setIsSidebarOpen,
    currentUser,
    handleLogout,
    userSearchTerm,
    setUserSearchTerm,
    filteredUsers,
    startDmWith,
    conversations,
    unreadCounts,
    lastActive,
    selectedConversationId,
    joinConversation,
    setIsCreatingGroup,
    conversationLabel,
    navigate,
    mutedConversations,
    toggleMuteConversation,
    activeCallMap,
    allUsers,
    markConversationRead,
}) {
    const [contextMenu, setContextMenu] = useState(null); // { x, y, convId }
    const contextRef = useRef(null);

    // Close context menu on outside click
    useEffect(() => {
        if (!contextMenu) return;
        const handler = () => setContextMenu(null);
        document.addEventListener("click", handler);
        document.addEventListener("contextmenu", handler);
        return () => {
            document.removeEventListener("click", handler);
            document.removeEventListener("contextmenu", handler);
        };
    }, [contextMenu]);

    const getUserName = (uid) => {
        const u = allUsers?.find((x) => x.id === uid);
        return u?.username || "User";
    };

    return (
        <aside
            className={[
                "z-50 h-full w-72 lg:w-80 max-w-[88vw] shrink-0 border-r border-[var(--ss-brand-outline)] ss-surface flex flex-col",
                "fixed inset-y-0 left-0 transform transition-transform duration-200 ease-out md:static md:translate-x-0",
                isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
            ].join(" ")}
            style={{
                paddingTop: "env(safe-area-inset-top, 0px)",
                paddingBottom: "env(safe-area-inset-bottom, 0px)",
            }}
        >
            <div className="px-4 py-4 border-b border-[var(--ss-brand-outline)] flex items-center justify-between gap-3">
                <div className="flex flex-1 flex-col items-start gap-2 min-w-0">
                    <img
                        src={logoWordmark}
                        alt="SafeSpace"
                        className="w-full max-w-[220px] sm:max-w-[240px] h-auto rounded-2xl"
                    />
                    <div className="text-xs text-slate-300/80 truncate">
                        {currentUser?.username ? `Signed in as ${currentUser.username}` : ""}
                    </div>
                </div>

                <button
                    onClick={handleLogout}
                    className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-[var(--ss-brand-outline)] hover:opacity-80 text-[var(--ss-brand-ink)] transition-all"
                >
                    Logout
                </button>
            </div>

            {/* Search users (DMs) */}
            <div className="p-4 border-b border-[var(--ss-brand-outline)]">
                <div className="flex items-center text-[11px] uppercase tracking-[0.22em] text-slate-400 font-semibold mb-2">
                    <span>Direct Messages</span>
                </div>

                <input
                    placeholder="Search usernames to DM"
                    value={userSearchTerm}
                    onChange={(e) => setUserSearchTerm(e.target.value)}
                    className="w-full rounded-lg bg-[var(--ss-brand-outline)] border border-[var(--ss-brand-outline)] px-3 py-2.5 text-sm text-[var(--ss-brand-ink)] placeholder:text-[var(--ss-brand-muted)] outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)] transition-all"
                />

                <div className="mt-3 max-h-48 overflow-y-auto space-y-1 pr-1 custom-scrollbar">
                    {filteredUsers.length === 0 && userSearchTerm.trim().length >= 2 ? (
                        <div className="px-3 py-2 text-slate-500 ss-text-sm">No matches.</div>
                    ) : null}
                    {filteredUsers.map((u) => (
                        <button
                            key={u.id}
                            onClick={() => startDmWith(u.username)}
                            className="w-full text-left px-3 py-2 rounded-lg bg-white/[0.02] hover:bg-white/[0.07] border border-white/5 hover:border-white/10 text-sm text-slate-100 transition-colors"
                        >
                            {u.username}
                        </button>
                    ))}

                    {userSearchTerm.trim() && filteredUsers.length === 0 && (
                        <div className="text-xs text-slate-500 px-1">No users found.</div>
                    )}
                </div>
            </div>

            {/* Conversations */}
            <div className="p-4 flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-semibold text-slate-200 uppercase tracking-[0.22em]">Conversations</span>
                    <button
                        onClick={() => setIsCreatingGroup(true)}
                        className="px-2.5 py-1.5 rounded-lg bg-[var(--ss-brand-outline)] hover:opacity-80 text-[var(--ss-brand-ink)] transition-all"
                        title="Create group"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
                </div>

                <div className="space-y-1.5">
                    {conversations
                        .slice()
                        .sort((a, b) => {
                            if (a.id === "global") return -1;
                            if (b.id === "global") return 1;

                            const unreadA = unreadCounts[a.id] || 0;
                            const unreadB = unreadCounts[b.id] || 0;
                            if (unreadA !== unreadB) return unreadB - unreadA;

                            const la = lastActive[a.id] || 0;
                            const lb = lastActive[b.id] || 0;
                            return lb - la;
                        })
                        .map((conv) => {
                            const unread = unreadCounts[conv.id] || 0;
                            const active = conv.id === selectedConversationId;
                            const callInfo = activeCallMap?.[conv.id];

                            // DM: find the other user's profile picture
                            let dmPic = null;
                            if (conv.type === "dm" && currentUser) {
                                const otherId = conv.memberIds?.find((id) => id !== currentUser.id);
                                const otherUser = allUsers?.find((u) => u.id === otherId);
                                dmPic = otherUser?.profilePictureThumbnail || otherUser?.profilePicture || null;
                            }

                            const base =
                                "w-full flex items-center gap-3 px-3.5 py-3 rounded-lg text-sm transition-all duration-200 group overflow-hidden relative";
                            const activeCls = active
                                ? "bg-[rgb(var(--ss-accent-rgb)/0.12)] text-[var(--ss-brand-ink)] font-medium"
                                : "hover:bg-[var(--ss-brand-outline)] text-[var(--ss-brand-muted)]";
                            const unreadCls = unread > 0 ? "ring-1 ring-[rgb(var(--ss-accent-rgb)/0.4)]" : "";

                            const isMuted = mutedConversations?.has?.(conv.id);

                            return (
                                <div key={conv.id}>
                                    <button
                                        onClick={() => joinConversation(conv.id)}
                                        onContextMenu={(e) => {
                                            if (conv.id === "global") return;
                                            e.preventDefault();
                                            e.stopPropagation();
                                            setContextMenu({ x: e.clientX, y: e.clientY, convId: conv.id });
                                        }}
                                        className={`${base} ${activeCls} ${unreadCls}`}
                                    >
                                        {dmPic ? (
                                            <img src={dmPic} alt="" className="h-6 w-6 rounded-full object-cover shrink-0 border border-white/10" draggable={false} />
                                        ) : conv.type === "dm" ? (
                                            <div className="h-6 w-6 rounded-full bg-[rgb(var(--ss-accent-rgb)/0.15)] border border-[rgb(var(--ss-accent-rgb)/0.25)] flex items-center justify-center shrink-0">
                                                <span className="text-[10px] font-semibold text-[rgb(var(--ss-accent-rgb))]">
                                                    {conversationLabel(conv).replace(/^DM:\s*/, "")[0]?.toUpperCase() || "?"}
                                                </span>
                                            </div>
                                        ) : null}
                                        <span className={`truncate flex-1 text-left ${active ? "text-white font-medium" : "text-slate-200 group-hover:text-white"}`}>
                                            {isMuted && (
                                                <svg className="inline-block mr-1.5 -mt-0.5 opacity-50" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                                    <line x1="23" y1="9" x2="17" y2="15" />
                                                    <line x1="17" y1="9" x2="23" y2="15" />
                                                </svg>
                                            )}
                                            {conversationLabel(conv)}
                                        </span>
                                        <div className="flex items-center gap-1.5 shrink-0">
                                            {callInfo && (
                                                <span className="flex items-center gap-1 text-[10px] text-green-400 bg-green-500/15 border border-green-500/20 px-1.5 py-0.5 rounded-full">
                                                    <span className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse" />
                                                    {callInfo.participants.length}
                                                </span>
                                            )}
                                            {unread > 0 && (
                                                <span className="text-[11px] px-2.5 py-0.5 rounded-full pill-accent font-semibold">
                                                    {unread}
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                    {/* Active call indicator below conversation */}
                                    {callInfo && (
                                        <div className="ml-3 mt-0.5 mb-1 flex items-center gap-1.5 text-[10px] text-green-300/80">
                                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92Z" />
                                            </svg>
                                            <span className="truncate">
                                                {callInfo.participants.map((uid) => getUserName(uid)).join(", ")} in call
                                            </span>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                </div>
            </div>

            {/* Sidebar actions */}
            <div className="p-4 border-t border-[var(--ss-brand-outline)] space-y-2">
                <button
                    onClick={() => {
                        navigate("/settings");
                        setIsSidebarOpen(false);
                    }}
                    className="w-full px-4 py-2 rounded-lg bg-[var(--ss-brand-outline)] hover:opacity-80 text-sm text-center text-[var(--ss-brand-ink)] transition-all"
                >
                    Settings
                </button>

                <button
                    onClick={() => setIsSidebarOpen(false)}
                    className="w-full px-4 py-2 rounded-lg bg-[var(--ss-brand-outline)] hover:opacity-80 text-sm md:hidden text-[var(--ss-brand-ink)]"
                >
                    Close
                </button>
            </div>
            {/* Right-click context menu */}
            {contextMenu && (
                <div
                    ref={contextRef}
                    className="fixed z-[60] min-w-[180px] rounded-xl bg-[var(--ss-brand-panel)] border border-[var(--ss-brand-outline)] shadow-[0_16px_48px_-12px_rgba(0,0,0,0.6)] overflow-hidden py-1"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    {/* Mark as Read */}
                    {unreadCounts[contextMenu.convId] > 0 && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                if (markConversationRead) markConversationRead(contextMenu.convId);
                                setContextMenu(null);
                            }}
                            className="w-full text-left px-4 py-2.5 text-sm text-[var(--ss-brand-ink)] hover:bg-[rgb(var(--ss-accent-rgb)/0.1)] transition-colors flex items-center gap-2.5"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                            Mark as Read
                        </button>
                    )}
                    {/* Mute / Unmute */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleMuteConversation(contextMenu.convId);
                            setContextMenu(null);
                        }}
                        className="w-full text-left px-4 py-2.5 text-sm text-[var(--ss-brand-ink)] hover:bg-[rgb(var(--ss-accent-rgb)/0.1)] transition-colors flex items-center gap-2.5"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            {mutedConversations?.has?.(contextMenu.convId) ? (
                                <>
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                                </>
                            ) : (
                                <>
                                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                                    <line x1="23" y1="9" x2="17" y2="15" />
                                    <line x1="17" y1="9" x2="23" y2="15" />
                                </>
                            )}
                        </svg>
                        {mutedConversations?.has?.(contextMenu.convId) ? "Unmute" : "Mute"}
                    </button>
                </div>
            )}
        </aside>
    );
}
