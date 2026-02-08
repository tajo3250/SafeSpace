import React, { useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { parseMessagePayload } from "../../utils/messagePayload";
import { resolveAttachmentUrl } from "../../utils/attachmentUrls";
import {
    getGifFromMessageText,
    getGifFromPayload,
    gifKey,
    isGifAttachment,
} from "../../utils/gifHelpers";
import { extractUrls, linkifyText } from "../../utils/linkDetection";
import { getUser as getStoredUser } from "../../utils/authStorage";
import LinkPreview from "./LinkPreview";
import ReactionDisplay from "./ReactionDisplay";
import ReactionPicker from "./ReactionPicker";

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
    attachmentBlobUrls,
    onReactToMessage
}) {
    const didNotifyReadyRef = useRef(false);
    const [reactionPicker, setReactionPicker] = useState({ open: false, messageId: null, rect: null });

    const openReactionPicker = useCallback((messageId, event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setReactionPicker({ open: true, messageId, rect });
    }, []);

    const closeReactionPicker = useCallback(() => {
        setReactionPicker({ open: false, messageId: null, rect: null });
    }, []);

    const handlePickReaction = useCallback((emoji) => {
        if (reactionPicker.messageId && onReactToMessage) {
            onReactToMessage(reactionPicker.messageId, emoji);
        }
        closeReactionPicker();
    }, [reactionPicker.messageId, onReactToMessage, closeReactionPicker]);

    const resolvedUser = useMemo(() => {
        if (currentUser?.id || currentUser?.username) return currentUser;
        return getStoredUser();
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
            const fileCount = attachments.filter(a => a.type === "file").length;
            const imgCount = attachments.filter(a => a.type === "image").length;
            const parts = [];
            if (imgCount === 1) parts.push("Image");
            else if (imgCount > 1) parts.push(`Images (${imgCount})`);
            if (fileCount === 1) parts.push(attachments.find(a => a.type === "file")?.name || "File");
            else if (fileCount > 1) parts.push(`Files (${fileCount})`);
            if (parts.length > 0) return parts.join(", ");
            const count = attachments.length;
            if (count === 1) return "Attachment";
            if (count > 1) return `Attachments (${count})`;
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

            const isImageOnly = !showText && (attachments.length > 0 || gifFromText) && attachments.every(a => a.type !== "file");

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
                                                {attachments.length > 0 && (() => {
                                                    const imageAtts = attachments.filter(a => a.type !== "file");
                                                    const fileAtts = attachments.filter(a => a.type === "file");

                                                    const formatSize = (bytes) => {
                                                        if (!Number.isFinite(bytes) || bytes === 0) return "";
                                                        const units = ["B", "KB", "MB", "GB"];
                                                        let size = bytes;
                                                        let idx = 0;
                                                        while (size >= 1024 && idx < units.length - 1) {
                                                            size /= 1024;
                                                            idx += 1;
                                                        }
                                                        const decimals = size >= 10 || idx === 0 ? 0 : 1;
                                                        return `${size.toFixed(decimals)} ${units[idx]}`;
                                                    };

                                                    const getFileIconType = (mime) => {
                                                        if (!mime) return "file";
                                                        if (mime.startsWith("video/")) return "video";
                                                        if (mime.startsWith("audio/")) return "audio";
                                                        if (mime === "application/pdf") return "pdf";
                                                        if (mime.includes("zip") || mime.includes("compressed") || mime.includes("archive") || mime.includes("tar") || mime.includes("7z") || mime.includes("rar")) return "archive";
                                                        if (mime.startsWith("text/") || mime.includes("document") || mime.includes("word") || mime.includes("sheet") || mime.includes("presentation") || mime.includes("csv")) return "document";
                                                        return "file";
                                                    };

                                                    const fileIconColors = {
                                                        video: "text-purple-400",
                                                        audio: "text-green-400",
                                                        pdf: "text-red-400",
                                                        archive: "text-yellow-400",
                                                        document: "text-blue-400",
                                                        file: "text-slate-400",
                                                    };

                                                    const renderFileIcon = (mime) => {
                                                        const type = getFileIconType(mime);
                                                        const color = fileIconColors[type] || "text-slate-400";
                                                        const svgs = {
                                                            video: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>,
                                                            audio: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>,
                                                            pdf: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>,
                                                            archive: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>,
                                                            document: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>,
                                                            file: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>,
                                                        };
                                                        return <span className={color}>{svgs[type] || svgs.file}</span>;
                                                    };

                                                    const getFileExt = (name) => {
                                                        if (!name) return "";
                                                        const dot = name.lastIndexOf(".");
                                                        if (dot < 0 || dot === name.length - 1) return "";
                                                        return name.slice(dot + 1).toUpperCase();
                                                    };

                                                    return (
                                                        <>
                                                            {imageAtts.length > 0 && (
                                                                <div
                                                                    className={[
                                                                        "grid gap-2",
                                                                        imageAtts.length > 1 ? "grid-cols-2" : "grid-cols-1",
                                                                        "w-full max-w-[360px]"
                                                                    ].join(" ")}
                                                                >
                                                                    {imageAtts.map((attachment, index) => {
                                                                        const cacheKey = attachment.id || attachment.url;
                                                                        const blobUrl = attachmentBlobUrls ? attachmentBlobUrls[cacheKey] : null;
                                                                        const resolvedPreview = resolveAttachmentUrl(attachment.previewUrl);
                                                                        const resolvedUrl = resolveAttachmentUrl(attachment.processedUrl || attachment.url);
                                                                        const previewSrc = blobUrl || resolvedPreview || attachment.dataUrl || resolvedUrl;
                                                                        const fullSrc = blobUrl || attachment.dataUrl || resolvedUrl || resolvedPreview;
                                                                        if (!previewSrc) return null;
                                                                        return (
                                                                            <button
                                                                                key={attachment.id || `${msg.id}-img-${index}`}
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
                                                            {fileAtts.length > 0 && (
                                                                <div className="flex flex-col gap-1.5 w-full max-w-[360px]">
                                                                    {fileAtts.map((attachment, index) => {
                                                                        const cacheKey = attachment.id || attachment.url;
                                                                        const blobUrl = attachmentBlobUrls ? attachmentBlobUrls[cacheKey] : null;
                                                                        const resolvedUrl = resolveAttachmentUrl(attachment.url);
                                                                        const downloadUrl = blobUrl || resolvedUrl;
                                                                        const ext = getFileExt(attachment.name);

                                                                        const fileType = getFileIconType(attachment.mime);

                                                                        // Video: inline player with controls
                                                                        if (fileType === "video" && downloadUrl) {
                                                                            return (
                                                                                <div key={attachment.id || `${msg.id}-file-${index}`} className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
                                                                                    <video
                                                                                        controls
                                                                                        preload="metadata"
                                                                                        className="w-full max-h-[300px] bg-black/40"
                                                                                        src={downloadUrl}
                                                                                    />
                                                                                    <a
                                                                                        href={downloadUrl}
                                                                                        download={attachment.name || "video"}
                                                                                        className="flex items-center gap-3 px-3.5 py-2 border-t border-white/10 hover:bg-white/5 transition-colors no-underline group"
                                                                                    >
                                                                                        <div className="shrink-0 h-8 w-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                                                                                            {renderFileIcon(attachment.mime)}
                                                                                        </div>
                                                                                        <div className="min-w-0 flex-1">
                                                                                            <div className="text-xs text-slate-300 truncate">{attachment.name || "Video"}</div>
                                                                                            <div className="text-[11px] text-slate-500">
                                                                                                {ext && <span className="uppercase">{ext}</span>}
                                                                                                {ext && attachment.size ? <span> · </span> : null}
                                                                                                {attachment.size ? <span>{formatSize(attachment.size)}</span> : null}
                                                                                            </div>
                                                                                        </div>
                                                                                        <div className="shrink-0 text-slate-400 group-hover:text-[rgb(var(--ss-accent-rgb))] transition-colors">
                                                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                                                        </div>
                                                                                    </a>
                                                                                </div>
                                                                            );
                                                                        }

                                                                        // Audio: compact card with inline player
                                                                        if (fileType === "audio" && downloadUrl) {
                                                                            return (
                                                                                <div key={attachment.id || `${msg.id}-file-${index}`} className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
                                                                                    <div className="flex items-center gap-3 px-3.5 py-2.5">
                                                                                        <div className="shrink-0 h-10 w-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                                                                                            {renderFileIcon(attachment.mime)}
                                                                                        </div>
                                                                                        <div className="min-w-0 flex-1">
                                                                                            <div className="text-sm text-slate-200 truncate font-medium">{attachment.name || "Audio"}</div>
                                                                                            <div className="flex items-center gap-2 text-[11px] text-slate-500">
                                                                                                {ext && <span className="uppercase">{ext}</span>}
                                                                                                {ext && attachment.size ? <span>·</span> : null}
                                                                                                {attachment.size ? <span>{formatSize(attachment.size)}</span> : null}
                                                                                            </div>
                                                                                        </div>
                                                                                        <a href={downloadUrl} download={attachment.name || "audio"} className="shrink-0 text-slate-400 hover:text-[rgb(var(--ss-accent-rgb))] transition-colors">
                                                                                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                                                        </a>
                                                                                    </div>
                                                                                    <div className="px-3.5 pb-2.5">
                                                                                        <audio controls preload="metadata" className="w-full h-8" style={{ colorScheme: "dark" }} src={downloadUrl} />
                                                                                    </div>
                                                                                </div>
                                                                            );
                                                                        }

                                                                        // PDF: preview link opens in new tab
                                                                        if (fileType === "pdf" && downloadUrl) {
                                                                            return (
                                                                                <a
                                                                                    key={attachment.id || `${msg.id}-file-${index}`}
                                                                                    href={downloadUrl}
                                                                                    target="_blank"
                                                                                    rel="noopener noreferrer"
                                                                                    className="group flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-3.5 py-2.5 transition-colors no-underline"
                                                                                >
                                                                                    <div className="shrink-0 h-10 w-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                                                                                        {renderFileIcon(attachment.mime)}
                                                                                    </div>
                                                                                    <div className="min-w-0 flex-1">
                                                                                        <div className="text-sm text-slate-200 truncate font-medium group-hover:text-white transition-colors">
                                                                                            {attachment.name || "PDF"}
                                                                                        </div>
                                                                                        <div className="flex items-center gap-2 text-[11px] text-slate-500">
                                                                                            <span className="text-[rgb(var(--ss-accent-rgb)/0.8)]">Click to preview</span>
                                                                                            {attachment.size ? <span>· {formatSize(attachment.size)}</span> : null}
                                                                                        </div>
                                                                                    </div>
                                                                                    <div className="shrink-0 text-slate-400 group-hover:text-[rgb(var(--ss-accent-rgb))] transition-colors">
                                                                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                                                                                    </div>
                                                                                </a>
                                                                            );
                                                                        }

                                                                        // Default: download card (existing behavior)
                                                                        return (
                                                                            <a
                                                                                key={attachment.id || `${msg.id}-file-${index}`}
                                                                                href={downloadUrl || "#"}
                                                                                download={attachment.name || "file"}
                                                                                target="_blank"
                                                                                rel="noopener noreferrer"
                                                                                className="group flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-3.5 py-2.5 transition-colors no-underline"
                                                                                onClick={(e) => {
                                                                                    if (!downloadUrl) e.preventDefault();
                                                                                }}
                                                                            >
                                                                                <div className="shrink-0 h-10 w-10 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                                                                                    {renderFileIcon(attachment.mime)}
                                                                                </div>
                                                                                <div className="min-w-0 flex-1">
                                                                                    <div className="text-sm text-slate-200 truncate font-medium group-hover:text-white transition-colors">
                                                                                        {attachment.name || "File"}
                                                                                    </div>
                                                                                    <div className="flex items-center gap-2 text-[11px] text-slate-500">
                                                                                        {ext && <span className="uppercase">{ext}</span>}
                                                                                        {ext && attachment.size ? <span>·</span> : null}
                                                                                        {attachment.size ? <span>{formatSize(attachment.size)}</span> : null}
                                                                                    </div>
                                                                                </div>
                                                                                <div className="shrink-0 text-slate-400 group-hover:text-[rgb(var(--ss-accent-rgb))] transition-colors">
                                                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                                                                                </div>
                                                                            </a>
                                                                        );
                                                                    })}
                                                                </div>
                                                            )}
                                                        </>
                                                    );
                                                })()}
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
                                                {showText && (() => {
                                                    const segments = linkifyText(safeDisplayText);
                                                    const urls = extractUrls(safeDisplayText);
                                                    const firstUrl = urls.length > 0 ? urls[0] : null;
                                                    return (
                                                        <>
                                                            <div className="whitespace-pre-wrap ss-text leading-relaxed [overflow-wrap:anywhere]">
                                                                {segments.map((seg, i) =>
                                                                    seg.type === "link" ? (
                                                                        <a
                                                                            key={i}
                                                                            href={seg.url}
                                                                            target="_blank"
                                                                            rel="noopener noreferrer"
                                                                            className="text-[rgb(var(--ss-accent-rgb))] hover:underline break-all"
                                                                            onClick={(e) => e.stopPropagation()}
                                                                        >
                                                                            {seg.content}
                                                                        </a>
                                                                    ) : (
                                                                        <React.Fragment key={i}>{seg.content}</React.Fragment>
                                                                    )
                                                                )}
                                                            </div>
                                                            {firstUrl && <LinkPreview url={firstUrl} />}
                                                        </>
                                                    );
                                                })()}
                                            </div>
                                        </div>

                                        {/* ACTIONS */}
                                        <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity scale-90 group-hover:scale-100">
                                            {onReactToMessage && (
                                                <button
                                                    onClick={(e) => openReactionPicker(msg.id, e)}
                                                    className="p-1.5 rounded-full bg-white/5 hover:bg-white/10 border border-white/10 text-slate-400 hover:text-[rgb(var(--ss-accent-rgb))] transition-colors shadow-[0_10px_30px_-24px_rgba(0,0,0,0.8)]"
                                                    title="React"
                                                >
                                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
                                                </button>
                                            )}
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

                                    {msg.reactions && (
                                        <ReactionDisplay
                                            reactions={msg.reactions}
                                            currentUserId={currentUserId}
                                            allUsers={allUsers}
                                            onToggleReaction={(emoji) => {
                                                if (onReactToMessage) onReactToMessage(msg.id, emoji);
                                            }}
                                        />
                                    )}

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
        attachmentBlobUrls,
        onReactToMessage,
        openReactionPicker
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
            <ReactionPicker
                isOpen={reactionPicker.open}
                rect={reactionPicker.rect}
                onSelect={handlePickReaction}
                onClose={closeReactionPicker}
            />
        </div>
    );
}
