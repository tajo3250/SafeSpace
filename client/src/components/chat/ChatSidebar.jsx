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
                "z-50 h-full w-72 lg:w-80 max-w-[88vw] shrink-0 border-r border-white/10 ss-surface backdrop-blur-xl flex flex-col shadow-[0_24px_80px_-60px_rgba(0,0,0,0.85)]",
                "fixed inset-y-0 left-0 transform transition-transform duration-200 ease-out md:static md:translate-x-0",
                isSidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
            ].join(" ")}
        >
            <div className="px-4 py-4 border-b border-white/10 bg-white/5 flex items-center justify-between gap-3">
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
                    className="text-xs font-semibold px-3.5 py-2 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 hover:border-[rgb(var(--ss-accent-rgb)/0.4)] text-slate-50 transition-all shadow-[0_12px_40px_-30px_rgba(0,0,0,0.9)]"
                >
                    Logout
                </button>
            </div>

            {/* Search users (DMs) */}
            <div className="p-4 border-b border-white/10 bg-white/[0.03]">
                <div className="flex items-center text-[11px] uppercase tracking-[0.22em] text-slate-400 font-semibold mb-2">
                    <span>Direct Messages</span>
                </div>

                <input
                    placeholder="Search usernames to DM"
                    value={userSearchTerm}
                    onChange={(e) => setUserSearchTerm(e.target.value)}
                    className="w-full rounded-xl bg-white/[0.05] border border-white/10 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus:ring-2 focus:ring-[rgb(var(--ss-accent-rgb)/0.40)] transition-all shadow-[0_12px_48px_-34px_rgba(0,0,0,0.85)]"
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
                        className="px-2.5 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 border border-white/10 hover:border-[rgb(var(--ss-accent-rgb)/0.4)] text-slate-100 transition-all shadow-[0_12px_40px_-30px_rgba(0,0,0,0.85)]"
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

                            const base =
                                "w-full flex items-center justify-between gap-3 px-3.5 py-3 rounded-xl border text-sm transition-all duration-200 group overflow-hidden relative";
                            const activeCls = active
                                ? "bg-[radial-gradient(circle_at_10%_20%,rgb(var(--ss-accent-rgb)/0.20),rgba(13,18,30,0.95))] border-[rgb(var(--ss-accent-rgb)/0.45)] text-white shadow-[0_18px_60px_-48px_rgb(var(--ss-accent-rgb)/0.9)]"
                                : "bg-white/[0.02] border-white/5 hover:border-white/10 hover:bg-white/[0.06]";
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
                                        <span className={`truncate ${active ? "text-white font-medium" : "text-slate-200 group-hover:text-white"}`}>
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
            <div className="p-4 border-t border-white/10 bg-white/5 space-y-2">
                <button
                    onClick={() => {
                        navigate("/settings");
                        setIsSidebarOpen(false);
                    }}
                    className="w-full px-4 py-2 rounded-xl bg-white/[0.06] hover:bg-white/[0.12] border border-white/10 text-sm text-center text-slate-100 transition-all shadow-[0_14px_48px_-36px_rgba(0,0,0,0.9)]"
                >
                    Settings
                </button>

                <button
                    onClick={() => setIsSidebarOpen(false)}
                    className="w-full px-4 py-2 rounded-xl bg-white/10 hover:bg-white/16 border border-white/10 text-sm md:hidden text-slate-100"
                >
                    Close
                </button>
            </div>
            {/* Right-click context menu */}
            {contextMenu && (
                <div
                    ref={contextRef}
                    className="fixed z-[60] min-w-[140px] rounded-xl bg-[#0c111d]/95 border border-white/12 shadow-[0_20px_60px_-30px_rgba(0,0,0,0.9)] backdrop-blur-2xl overflow-hidden py-1"
                    style={{ top: contextMenu.y, left: contextMenu.x }}
                >
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleMuteConversation(contextMenu.convId);
                            setContextMenu(null);
                        }}
                        className="w-full text-left px-4 py-2.5 text-sm text-slate-100 hover:bg-white/10 transition-colors flex items-center gap-2"
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
