import React, { useLayoutEffect, useMemo, useRef } from "react";
import { parseMessagePayload } from "../../utils/messagePayload";
import {
    getGifFromMessageText,
    getGifFromPayload,
    gifKey,
    isGifAttachment,
} from "../../utils/gifHelpers";

function DayDivider({ label }) {
    return (
        <div className="flex items-center gap-3 py-5">
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
            <div className="px-3 py-1 rounded-full bg-white/5 border border-white/10 text-slate-200 text-[11px] font-semibold tracking-[0.18em] uppercase shrink-0 shadow-[0_10px_40px_-30px_rgba(0,0,0,0.8)]">
                {label}
            </div>
            <div className="h-px flex-1 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        </div>
    );
}

export default function MessageList({
    currentMessages,
    currentUser,
    allUsers,
    decryptedMessages,
    selectedConversationId,
    replyToId,
    setReplyToId,
    onReplyToMessage,
    flashHighlightId,
    editingMessageId,
    setEditingMessageId,
    setInput,
    handleDeleteMessage,
    isLoadingOlder,
    messagesEndRef,
    messagesContainerRef,
    topSentinelRef,
    setHasNewWhileScrolledUp,
    setIsUserAtBottom,
    scrollToBottom,
    jumpToLatest,
    jumpToMessage,
    isUserAtBottom,
    hasNewWhileScrolledUp,
    scrollToMessage,
    onContainerReady,
    onOpenImage,
    gifFavoriteKeys,
    onToggleGifFavorite,
    attachmentBlobUrls
}) {
    const didNotifyReadyRef = useRef(false);
    const resolvedUser = useMemo(() => {
        if (currentUser?.id || currentUser?.username) return currentUser;
        try {
            const raw = localStorage.getItem("user");
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }, [currentUser]);

    useLayoutEffect(() => {
        if (didNotifyReadyRef.current) return;
        if (!messagesContainerRef?.current) return;
        didNotifyReadyRef.current = true;
        if (onContainerReady) onContainerReady();
    }, [onContainerReady, messagesContainerRef]);

    // Auto-scroll effect handled by parent via refs, but we need to attach refs here
    // Actually, refs are attached to the container passed in or internal to this list?
    // In the original, the container was in Chat.jsx.
    // We can render the container here if we pass the ref.

    const renderedMessageItems = useMemo(() => {
        const items = [];
        let lastDayKey = null;
        let prevMsg = null;

        const safeDate = (v) => {
            if (!v) return null;
            const d = new Date(v);
            return Number.isNaN(d.getTime()) ? null : d;
        };

        const dayKey = (d) =>
            d
                ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
                    d.getDate()
                ).padStart(2, "0")}`
                : null;

        const dayLabel = (d) =>
            d
                ? d.toLocaleDateString(undefined, {
                    weekday: "short",
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                })
                : "";

        const timeLabel = (d) =>
            d
                ? d.toLocaleTimeString(undefined, {
                    hour: "numeric",
                    minute: "2-digit",
                })
                : "";

        const senderNameFor = (msg) => {
            const fallback = allUsers.find((u) => u.id === msg.senderId)?.username || "Unknown";
            return msg.senderName || fallback;
        };

        const textFor = (msg) => decryptedMessages[msg.id] ?? (msg.text || "");

        const truncateWithEllipsis = (text, max, forceEllipsis = false) => {
            const clean = String(text || "").replace(/\s+/g, " ").trim();
            if (!clean) return "";
            if (clean === "Encrypted message...") return clean;
            if (clean.length > max) {
                const sliceLen = Math.max(0, max - 3);
                return clean.slice(0, sliceLen).trimEnd() + "...";
            }
            if (forceEllipsis && !clean.endsWith("...")) return clean + "...";
            return clean;
        };

        const summarizePayload = (payload) => {
            if (!payload) return "";
            const text = String(payload.text || "").replace(/\s+/g, " ").trim();
            if (text) return text;
            const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
            const gifCount = attachments.filter(isGifAttachment).length;
            if (gifCount === 1) return "GIF";
            if (gifCount > 1) return `GIFs (${gifCount})`;
            const count = attachments.length;
            if (count === 1) return "Image";
            if (count > 1) return `Images (${count})`;
            return "";
        };

        currentMessages.forEach((msg) => {
            const created = msg.createdAt || msg.timestamp || msg.sentAt || msg.time || msg.date;
            const ts = safeDate(created);

            const dk = dayKey(ts);
            if (dk && dk !== lastDayKey) {
                items.push(<DayDivider key={`day-${dk}`} label={dayLabel(ts)} />);
                lastDayKey = dk;
            }

            const displayName = senderNameFor(msg);
            const initials = (displayName || "?").trim()?.[0]?.toUpperCase?.() || "?";

            const prevCreated = prevMsg
                ? prevMsg.createdAt || prevMsg.timestamp || prevMsg.sentAt || prevMsg.time || prevMsg.date
                : null;
            const prevTs = safeDate(prevCreated);

            const grouped =
                !!prevMsg &&
                prevMsg.senderId === msg.senderId &&
                ts &&
                prevTs &&
                Math.abs(ts.getTime() - prevTs.getTime()) < 5 * 60 * 1000;

            const showMeta = !grouped;
            const currentUserId = resolvedUser?.id;
            const currentUsername = resolvedUser?.username;
            const senderId = msg.senderId ?? msg.sender?.id;
            const senderNameRaw =
                msg.senderName || msg.username || msg.userName || msg.sender?.username || "";
            const isMe =
                (currentUserId != null && senderId != null && String(senderId) === String(currentUserId)) ||
                (currentUsername &&
                    senderNameRaw &&
                    senderNameRaw.toLowerCase() === String(currentUsername).toLowerCase());
            const isSystem = msg.type === "system" || msg.senderId === "system";
            const rawText = textFor(msg);
            const payload = parseMessagePayload(String(rawText));
            const attachments =
                payload && Array.isArray(payload.attachments) ? payload.attachments : [];
            const gifFromPayload = getGifFromPayload(payload);
            const messageText = payload ? payload.text : rawText;
            const gifFromText = gifFromPayload ? null : getGifFromMessageText(messageText);
            const gifMeta = gifFromPayload || gifFromText;
            const hasAttachments = attachments.length > 0;
            const canEdit = isMe && !isSystem && !hasAttachments;
            const canDelete = isMe && !isSystem;
            const gifKeyValue = gifMeta ? gifKey(gifMeta) : "";
            const isGifFavorited = gifKeyValue ? gifFavoriteKeys?.has(gifKeyValue) : false;

            if (isSystem) {
                items.push(
                    <div key={msg.id} className="flex justify-center my-6 animate-in fade-in zoom-in-95 duration-300">
                        <span className="px-4 py-1.5 text-xs text-slate-200 bg-white/5 border border-white/10 rounded-full shadow-[0_12px_40px_-30px_rgba(0,0,0,0.85)] backdrop-blur">
                            {msg.text}
                        </span>
                    </div>
                );
                return;
            }

            const bubbleBg = isMe
                ? "bubble-me bg-[rgb(var(--ss-accent-rgb))] text-white"
                : "bubble-other text-slate-200";

            const isHighlighted = msg.id === replyToId || msg.id === flashHighlightId;
            const isEdited = !!(msg.editedAt || msg.updatedAt || msg.updated);

            // Reply Target lookup
            let replyTarget = null;
            let replySender = "";
            let replySnippet = "";

            if (msg.replyToId) {
                const target = currentMessages.find((m) => m.id === msg.replyToId);
                if (target) {
                    replyTarget = target;
                    replySender = senderNameFor(target);
                    const raw = textFor(target);
                    const targetPayload = parseMessagePayload(String(raw));
                    let previewText = "";
                    if (targetPayload) {
                        previewText = summarizePayload(targetPayload);
                    } else {
                        previewText = String(raw || "");
                        try {
                            const p = JSON.parse(raw);
                            if (p && p.e2ee) previewText = "Encrypted message...";
                        } catch { }
                    }
                    replySnippet = truncateWithEllipsis(previewText, 90);
                } else if (msg.replyToPreview && typeof msg.replyToPreview === "object") {
                    const preview = msg.replyToPreview;
                    const fallbackName = preview.senderId
                        ? allUsers.find((u) => u.id === preview.senderId)?.username
                        : "";
                    replySender = preview.senderName || fallbackName || "";
                    const rawSnippet = String(preview.snippet || "").replace(/\s+/g, " ").trim();
                    if (rawSnippet && rawSnippet !== "Encrypted message...") {
                        replySnippet = truncateWithEllipsis(rawSnippet, 90, rawSnippet.length >= 90);
                    }
                }
            }
            if (msg.replyToId && !replyTarget && !replySender && !replySnippet) {
                replySender = "message";
            }

            const normalizedText = typeof messageText === "string" ? messageText : String(messageText || "");
            let safeDisplayText = normalizedText;
            let isEncryptedPlaceholder = false;
            if (!payload) {
                try {
                    const parsed = JSON.parse(rawText);
                    if (parsed && parsed.e2ee) {
                        safeDisplayText = "Encrypted message...";
                        isEncryptedPlaceholder = true;
                    }
                } catch { }
            }
            const sanitizedText = String(normalizedText || "").replace(/\s+/g, " ").trim();
            const trimmedMessageText = String(messageText || "").trim();
            const attachmentUrlSet = new Set(
                attachments.map((att) => att.url).filter(Boolean)
            );
            const replyPreviewText =
                (gifMeta ? "GIF" : "") ||
                summarizePayload(payload) ||
                (isEncryptedPlaceholder ? safeDisplayText : sanitizedText) ||
                safeDisplayText;
            const isGifOnlyText =
                !!gifFromText &&
                trimmedMessageText === String(gifFromText.originalUrl || gifFromText.url);
            const isGifOnlyAttachmentText = gifMeta && attachmentUrlSet.has(trimmedMessageText);
            const showText =
                Boolean(String(safeDisplayText || "").trim()) &&
                !isGifOnlyText &&
                !isGifOnlyAttachmentText;

            const isImageOnly = !showText && (attachments.length > 0 || gifFromText);

            items.push(
                <div
                    key={msg.id}
                    id={`msg-${msg.id}`}
                    data-msg-id={msg.id}
                    className={"mt-2 scroll-mt-24 group px-1"}
                >
                    <div className="flex items-start gap-3">
                        {showMeta ? (
                            <div
                                className={[
                                    "shrink-0 mt-0.5 h-9 w-9 rounded-xl border flex items-center justify-center font-semibold shadow-[0_12px_30px_-26px_rgba(0,0,0,0.8)] transition-transform hover:scale-105 backdrop-blur",
                                    isMe
                                        ? "bg-[radial-gradient(circle_at_40%_40%,rgb(var(--ss-accent-rgb)/0.35),rgba(12,18,30,0.9))] border-[rgb(var(--ss-accent-rgb)/0.45)] text-[rgb(var(--ss-accent-rgb))]"
                                        : "bg-gradient-to-br from-white/10 via-white/5 to-white/10 border-white/10 text-slate-200",
                                ].join(" ")}
                                title={displayName}
                            >
                                <span className="text-xs">{initials}</span>
                            </div>
                        ) : (
                            <div className="shrink-0 w-8" />
                        )}

                        <div className="min-w-0 flex-1 flex flex-col items-start">
                            {showMeta && (
                                <div className="flex items-baseline gap-2 min-w-0 mb-1 px-1">
                                    <div className="font-semibold text-sm text-slate-100 truncate">{displayName}</div>
                                    <div className="text-slate-400 text-[10px] shrink-0 font-medium">{timeLabel(ts)}</div>
                                </div>
                            )}

                            <div className="relative max-w-full min-w-0">
                                <div className="relative flex w-full min-w-0 flex-col items-start">
                                    {msg.replyToId && (replyTarget || replySender || replySnippet) && (
                                        <div
                                            className={[
                                                "flex items-center gap-2 mb-1 opacity-90 text-xs text-slate-300 transition-colors min-w-0",
                                                (replyTarget || jumpToMessage)
                                                    ? "cursor-pointer hover:text-[rgb(var(--ss-accent-rgb))]"
                                                    : "cursor-default"
                                            ].join(" ")}
                                            onClick={() => {
                                                if (replyTarget) {
                                                    scrollToMessage(msg.replyToId);
                                                    return;
                                                }
                                                if (jumpToMessage) jumpToMessage(msg.replyToId);
                                            }}
                                        >
                                            <div className="h-3 w-6 border-t border-l border-white/10 rounded-tl-md -mb-2.5 mx-1" />
                                            <span className="truncate max-w-full">
                                                Replying to{" "}
                                                <strong>{replySender || "message"}</strong>
                                                {replySnippet ? ` - "${replySnippet}"` : ""}
                                            </span>
                                        </div>
                                    )}

                                    <div className="flex items-center gap-2 max-w-full min-w-0">
                                        <div
                                            className={[
                                                "inline-block w-fit max-w-full min-w-0 break-words transition-all duration-200 backdrop-blur-sm",
                                                !isImageOnly ? "rounded-2xl border px-4 py-3" : "p-0 border-none bg-transparent shadow-none",
                                                !isImageOnly ? bubbleBg : "",
                                                !isImageOnly && isHighlighted
                                                    ? "ring-2 ring-[rgb(var(--ss-accent-rgb))] shadow-[0_0_0_2px_rgb(var(--ss-accent-rgb)/0.25)]"
                                                    : (!isImageOnly ? "shadow-[0_16px_50px_-42px_rgba(0,0,0,0.9)]" : ""),
                                                !isImageOnly ? (isMe ? "rounded-br-sm" : "rounded-tl-sm") : ""
                                            ].join(" ")}
                                            onDoubleClick={() => {
                                                if (onReplyToMessage) {
                                                    onReplyToMessage(msg, replyPreviewText);
                                                } else {
                                                    setReplyToId(msg.id);
                                                }
                                            }}
                                        >
                                            <div className="flex flex-col gap-2">
                                                {attachments.length > 0 && (
                                                    <div
                                                        className={[
                                                            "grid gap-2",
                                                            attachments.length > 1 ? "grid-cols-2" : "grid-cols-1",
                                                            "w-full max-w-[360px]"
                                                        ].join(" ")}
                                                    >
                                                        {attachments.map((attachment, index) => {
                                                            const cacheKey = attachment.id || attachment.url;
                                                            const blobUrl = attachmentBlobUrls ? attachmentBlobUrls[cacheKey] : null;

                                                            const previewSrc =
                                                                blobUrl || attachment.previewUrl || attachment.dataUrl || attachment.url;
                                                            const fullSrc = blobUrl || attachment.dataUrl || attachment.url || attachment.previewUrl;
                                                            if (!previewSrc) return null;
                                                            return (
                                                                <button
                                                                    key={attachment.id || `${msg.id}-${index}`}
                                                                    type="button"
                                                                    onClick={() => {
                                                                        if (!onOpenImage || !fullSrc) return;
                                                                        onOpenImage({
                                                                            id: attachment.id || `${msg.id}-${index}`,
                                                                            src: fullSrc,
                                                                            name: attachment.name,
                                                                            size: attachment.size,
                                                                            width: attachment.width,
                                                                            height: attachment.height,
                                                                            messageId: msg.id,
                                                                        });
                                                                    }}
                                                                    className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5"
                                                                >
                                                                    <img
                                                                        src={previewSrc}
                                                                        alt={attachment.name || "Image"}
                                                                        className="h-32 w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                                                                        loading="lazy"
                                                                        decoding="async"
                                                                    />
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                                {!hasAttachments && gifFromText && (
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            if (!onOpenImage) return;
                                                            const src = gifFromText.previewUrl || gifFromText.url;
                                                            if (!src) return;
                                                            onOpenImage({
                                                                id: `gif-${msg.id}`,
                                                                src,
                                                                name: "GIF",
                                                                size: null,
                                                                width: null,
                                                                height: null,
                                                                messageId: msg.id,
                                                            });
                                                        }}
                                                        className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5 max-w-[360px]"
                                                    >
                                                        <img
                                                            src={gifFromText.previewUrl || gifFromText.url}
                                                            alt="GIF"
                                                            className="h-32 w-full object-cover transition-transform duration-300 group-hover:scale-[1.02]"
                                                            loading="lazy"
                                                            decoding="async"
                                                        />
                                                    </button>
                                                )}
                                                {showText && (
                                                    <div className="whitespace-pre-wrap ss-text leading-relaxed">
                                                        {safeDisplayText}
                                                    </div>
                                                )}
                                            </div>
                                        </div>

                                        {/* ACTIONS */}
                                        <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity scale-90 group-hover:scale-100">
                                            <button
                                                onClick={() => {
                                                    if (onReplyToMessage) {
                                                        onReplyToMessage(msg, replyPreviewText);
                                                    } else {
                                                        setReplyToId(msg.id);
                                                    }
                                                }}
                                                className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-[rgb(var(--ss-accent-rgb))] transition-colors shadow-[0_10px_30px_-24px_rgba(0,0,0,0.8)]"
                                                title="Reply"
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>
                                            </button>
                                            {gifKeyValue && onToggleGifFavorite && (
                                                <button
                                                    onClick={() => onToggleGifFavorite(gifMeta)}
                                                    className={[
                                                        "p-1.5 rounded-full border transition-colors shadow-[0_10px_30px_-24px_rgba(0,0,0,0.8)]",
                                                        isGifFavorited
                                                            ? "bg-[rgb(var(--ss-accent-rgb)/0.25)] border-[rgb(var(--ss-accent-rgb)/0.5)] text-[rgb(var(--ss-accent-rgb))]"
                                                            : "bg-white/5 hover:bg-white/10 border-white/10 text-slate-400 hover:text-[rgb(var(--ss-accent-rgb))]"
                                                    ].join(" ")}
                                                    title={isGifFavorited ? "Unfavorite GIF" : "Favorite GIF"}
                                                >
                                                    <svg
                                                        width="14"
                                                        height="14"
                                                        viewBox="0 0 24 24"
                                                        fill={isGifFavorited ? "currentColor" : "none"}
                                                        stroke="currentColor"
                                                        strokeWidth="2"
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                    >
                                                        <polygon points="12 2 15 8.5 22 9.3 17 14 18.3 21 12 17.8 5.7 21 7 14 2 9.3 9 8.5 12 2"></polygon>
                                                    </svg>
                                                </button>
                                            )}
                                            {canEdit && (
                                                <button
                                                    onClick={() => {
                                                        setEditingMessageId(msg.id);
                                                        setInput(safeDisplayText);
                                                    }}
                                                    className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-[rgb(var(--ss-accent-rgb))] transition-colors shadow-[0_10px_30px_-24px_rgba(0,0,0,0.8)]"
                                                    title="Edit"
                                                >
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
                                                </button>
                                            )}
                                            {canDelete && (
                                                <button
                                                    onClick={() => handleDeleteMessage(msg.id)}
                                                    className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-red-400 transition-colors shadow-[0_10px_30px_-24px_rgba(0,0,0,0.8)]"
                                                    title="Delete"
                                                >
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {!showMeta && ts && (
                                        <div className="mt-1 ml-1 text-slate-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">
                                            {timeLabel(ts)} {isEdited && "(edited)"}
                                        </div>
                                    )}
                                    {showMeta && isEdited && (
                                        <div className="mt-1 ml-1 text-slate-600 text-[10px]">
                                            (edited)
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            );

            prevMsg = msg;
        });

        if (isLoadingOlder) {
            items.unshift(
                <div key="loading-more" className="flex justify-center py-6">
                    <div className="animate-spin h-5 w-5 border-2 border-[rgb(var(--ss-accent-rgb))] border-t-transparent rounded-full shadow-lg"></div>
                </div>
            );
        }

        return items;
    }, [
        currentMessages,
        resolvedUser,
        allUsers,
        decryptedMessages,
        selectedConversationId,
        replyToId,
        flashHighlightId,
        isLoadingOlder,
        scrollToMessage,
        jumpToMessage,
        setReplyToId,
        onReplyToMessage,
        setEditingMessageId,
        setInput,
        handleDeleteMessage,
        onOpenImage,
        gifFavoriteKeys,
        onToggleGifFavorite,
        attachmentBlobUrls
    ]);

    return (
        <div className="relative flex-1 min-h-0 flex flex-col">
            <div
                ref={messagesContainerRef}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 md:px-10 py-6 custom-scrollbar bg-[rgb(var(--ss-accent-rgb)/0.05)] focus:outline-none"
                style={{ WebkitOverflowScrolling: "touch" }}
                tabIndex={0}
                aria-label="Messages"
            // onScroll handled by useEffect in parent, or we can move it here if we pass the handler
            >
                <div
                    className={[
                        "w-full space-y-2 pb-6 min-h-full flex flex-col",
                        currentMessages.length > 0 ? "justify-end" : ""
                    ].join(" ")}
                >
                    <div ref={topSentinelRef} className="h-px w-full pointer-events-none" aria-hidden="true" />
                    {currentMessages.length === 0 ? (
                        isLoadingOlder ? (
                            <div className="h-[60vh] w-full flex items-center justify-center">
                                <div className="animate-spin h-7 w-7 border-2 border-[rgb(var(--ss-accent-rgb))] border-t-transparent rounded-full shadow-lg"></div>
                            </div>
                        ) : (
                            <div className="h-[60vh] w-full flex flex-col items-center justify-center gap-5 text-center">
                                <div className="h-16 w-16 rounded-2xl bg-[radial-gradient(circle_at_30%_30%,rgb(var(--ss-accent-rgb)/0.28),rgba(12,18,30,0.9))] border border-[rgb(var(--ss-accent-rgb)/0.35)] flex items-center justify-center shadow-[0_20px_60px_-40px_rgba(0,0,0,0.8)]">
                                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-[rgb(var(--ss-accent-rgb))]"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>
                                </div>
                                <div className="space-y-1">
                                    <div className="text-slate-100 font-semibold">No messages yet</div>
                                    <div className="text-sm text-slate-400">Start the conversation!</div>
                                </div>
                            </div>
                        )
                    ) : (
                        renderedMessageItems
                    )}

                    <div ref={messagesEndRef} />
                </div>
            </div>

            {/* Jump to bottom */}
            {(!isUserAtBottom || hasNewWhileScrolledUp) && (
                <div className="absolute bottom-6 right-6 z-10 animate-in fade-in slide-in-from-bottom-4 duration-300">
                    <button
                        onClick={() => {
                            if (jumpToLatest) {
                                jumpToLatest();
                                return;
                            }
                            setHasNewWhileScrolledUp(false);
                            setIsUserAtBottom(true);
                            scrollToBottom("auto");
                        }}
                        className="flex items-center gap-2 px-4 py-2.5 rounded-full pill-accent bg-[rgb(var(--ss-accent-rgb))] text-slate-900 text-xs font-semibold shadow-[0_14px_40px_-26px_rgba(0,0,0,0.8)] transition-all hover:scale-105 active:scale-95"
                    >
                        <span>Jump to latest</span>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                    </button>
                </div>
            )}
        </div>
    );
}
