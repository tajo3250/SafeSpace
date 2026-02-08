import React, { useEffect, useRef, useState } from "react";

const MAX_MESSAGE_CHARS = 4000;

function getFileIcon(mime) {
    if (!mime) return "file";
    if (mime.startsWith("video/")) return "video";
    if (mime.startsWith("audio/")) return "audio";
    if (mime === "application/pdf") return "pdf";
    if (mime.startsWith("application/zip") || mime.includes("compressed") || mime.includes("archive") || mime.includes("tar") || mime.includes("7z") || mime.includes("rar")) return "archive";
    if (mime.startsWith("text/") || mime.includes("document") || mime.includes("word") || mime.includes("sheet") || mime.includes("presentation") || mime.includes("csv")) return "document";
    return "file";
}

function FileTypeIcon({ mime, className = "w-6 h-6" }) {
    const type = getFileIcon(mime);
    const iconColor = {
        video: "text-purple-400",
        audio: "text-green-400",
        pdf: "text-red-400",
        archive: "text-yellow-400",
        document: "text-blue-400",
        file: "text-slate-400",
    }[type];

    return (
        <div className={`${className} ${iconColor} flex items-center justify-center`}>
            {type === "video" && (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
            )}
            {type === "audio" && (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg>
            )}
            {type === "pdf" && (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>
            )}
            {type === "archive" && (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8v13H3V8"></path><path d="M1 3h22v5H1z"></path><path d="M10 12h4"></path></svg>
            )}
            {type === "document" && (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>
            )}
            {type === "file" && (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
            )}
        </div>
    );
}

function formatFileSize(bytes) {
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
}

export default function MessageInput({
    input,
    setInput,
    sendMessage,
    editingMessageId,
    setEditingMessageId,
    replyToId,
    setReplyToId,
    scrollToMessage,
    cancelEdit,
    cancelReply,
    editTargetMsg,
    replyTargetMsg,
    replyPreview,
    getSenderNameForMsg,
    getPlaintextForMsg,
    jumpToMessage,
    pendingImages,
    onAddImages,
    removePendingImage,
    clearPendingImages,
    retryPendingUpload,
    maxImageBytes,
    formatBytes,
    onOpenGifPicker,
    onOpenEmojiPicker
}) {
    const textareaRef = useRef(null);
    const fileInputRef = useRef(null);
    const [isDragActive, setIsDragActive] = useState(false);

    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        // Sync height when input changes programmatically (send/edit/reply).
        el.style.height = "auto";
        const nextHeight = Math.min(el.scrollHeight, 128);
        el.style.height = Math.max(nextHeight, 44) + "px";
    }, [input]);

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

    const replyName =
        replyTargetMsg ? getSenderNameForMsg(replyTargetMsg) : replyPreview?.senderName || "message";
    const replySnippetSource =
        replyTargetMsg ? getPlaintextForMsg(replyTargetMsg) : replyPreview?.snippet || "";
    const replySnippet = truncateWithEllipsis(
        replySnippetSource,
        140,
        !replyTargetMsg && Boolean(replyPreview?.truncated)
    );

    const hasImages = Array.isArray(pendingImages) && pendingImages.length > 0;
    const hasProcessingImages = Array.isArray(pendingImages)
        ? pendingImages.some((img) => img.status === "loading")
        : false;
    const canSend = editingMessageId
        ? Boolean(input.trim())
        : Boolean(input.trim() || hasImages);
    const sendDisabled = !canSend || hasProcessingImages;
    const attachmentsDisabled = Boolean(editingMessageId);
    const fileLimitLabel = formatBytes && maxImageBytes ? formatBytes(maxImageBytes) : "1 GB";

    const handleFiles = (files) => {
        if (attachmentsDisabled) return;
        if (!files || !onAddImages) return;
        onAddImages(files);
    };

    const handlePaste = (e) => {
        if (attachmentsDisabled) return;
        const items = e.clipboardData?.items;
        if (!items || items.length === 0) return;
        const files = [];
        for (const item of items) {
            if (item.kind === "file") {
                const file = item.getAsFile();
                if (file) {
                    files.push(file);
                }
            }
        }
        if (files.length > 0) {
            e.preventDefault();
            handleFiles(files);
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        setIsDragActive(false);
        if (attachmentsDisabled) return;
        const files = Array.from(e.dataTransfer?.files || []);
        if (files.length > 0) handleFiles(files);
    };

    const handleDragOver = (e) => {
        e.preventDefault();
        if (attachmentsDisabled) return;
        setIsDragActive(true);
    };

    const handleDragLeave = () => {
        setIsDragActive(false);
    };

    return (
        <footer className="shrink-0 bg-transparent pb-[calc(env(safe-area-inset-bottom,0px)+4px)] pt-3 px-4 md:px-6">
            <div
                className="w-full relative"
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                onDragEnter={handleDragOver}
                onDragLeave={handleDragLeave}
            >
                {isDragActive && !attachmentsDisabled && (
                    <div className="absolute inset-0 z-10 rounded-2xl border-2 border-dashed border-[rgb(var(--ss-accent-rgb)/0.6)] bg-[rgb(var(--ss-accent-rgb)/0.08)] flex items-center justify-center text-sm text-slate-100 pointer-events-none">
                        Drop files to upload
                    </div>
                )}
                {editingMessageId && (
                    <div className="mb-3 flex items-center justify-between gap-3 rounded-xl glass-panel px-4 py-3 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200">
                        <button
                            type="button"
                            onClick={() => scrollToMessage(editingMessageId)}
                            className="min-w-0 text-left group rounded-lg px-2 py-1 -mx-2 -my-1 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                            title="Jump to message"
                        >
                            <div className="text-[rgb(var(--ss-accent-rgb))] ss-text-sm font-medium flex items-center gap-2">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                                Editing message
                            </div>
                            <div className="truncate ss-text text-slate-300 group-hover:text-white transition-colors">
                                {(() => {
                                    const t = editTargetMsg ? getPlaintextForMsg(editTargetMsg) : "";
                                    return (t || "Encrypted message").slice(0, 140);
                                })()}
                            </div>
                        </button>

                        <button
                            type="button"
                            onClick={cancelEdit}
                            className="h-8 w-8 rounded-full border border-white/10 bg-white/10 hover:bg-white/16 flex items-center justify-center transition-all text-slate-200"
                            title="Cancel edit"
                            aria-label="Cancel edit"
                        >
                            <span className="text-slate-300 hover:text-white">x</span>
                        </button>
                    </div>
                )}

                {!editingMessageId && replyToId && (
                    <div className="mb-3 flex items-center justify-between gap-3 rounded-xl glass-panel px-4 py-3 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200">
                        <button
                            type="button"
                            onClick={() => {
                                if (jumpToMessage) {
                                    jumpToMessage(replyToId);
                                    return;
                                }
                                scrollToMessage(replyToId);
                            }}
                            className="min-w-0 text-left group rounded-lg px-2 py-1 -mx-2 -my-1 bg-white/5 hover:bg-white/10 border border-white/10 transition-colors"
                            title="Jump to message"
                        >
                            <div className="text-[rgb(var(--ss-accent-rgb))] ss-text-sm font-medium flex items-center gap-2">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"></path></svg>
                                Replying to {replyName}
                            </div>
                            <div className="truncate ss-text text-slate-300 group-hover:text-white transition-colors">
                                {(() => {
                                    return (replySnippet || "Message").slice(0, 140);
                                })()}
                            </div>
                        </button>

                        <button
                            type="button"
                            onClick={cancelReply}
                            className="h-8 w-8 rounded-full border border-white/10 bg-white/10 hover:bg-white/16 flex items-center justify-center transition-all text-slate-200"
                            title="Cancel reply"
                            aria-label="Cancel reply"
                        >
                            <span className="text-slate-300 hover:text-white">x</span>
                        </button>
                    </div>
                )}

                {!editingMessageId && hasImages && (
                    <div className="mb-3 rounded-xl border border-white/10 bg-white/5 p-3">
                        <div className="flex items-center justify-between text-xs text-slate-400">
                            <span>Attachments ({pendingImages.length})</span>
                            {clearPendingImages && (
                                <button
                                    type="button"
                                    onClick={clearPendingImages}
                                    className="text-xs px-2 py-1 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
                                >
                                    Clear
                                </button>
                            )}
                        </div>
                        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                            {pendingImages.map((img) => {
                                const isImage = img.type !== "file" && img.mime && img.mime.startsWith("image/");
                                const isError = img.status === "error";
                                const isLoading = img.status === "loading";
                                const isReady = img.status === "ready";

                                return (
                                    <div
                                        key={img.id}
                                        className={[
                                            "relative shrink-0 rounded-lg border overflow-hidden",
                                            isError
                                                ? "border-red-500/40 bg-red-500/10"
                                                : "border-white/10 bg-white/5",
                                            isImage ? "h-20 w-20" : "h-20 w-44",
                                        ].join(" ")}
                                    >
                                        {isImage && isReady && img.dataUrl ? (
                                            <img
                                                src={img.dataUrl}
                                                alt={img.name || "Image"}
                                                className="h-full w-full object-cover"
                                                loading="lazy"
                                                decoding="async"
                                            />
                                        ) : isImage && isLoading ? (
                                            <div className="h-full w-full flex flex-col items-center justify-center gap-1 px-1">
                                                <div className="w-full rounded-full bg-white/10 h-1.5 overflow-hidden">
                                                    <div
                                                        className="h-full rounded-full bg-[rgb(var(--ss-accent-rgb))] transition-all duration-300"
                                                        style={{ width: `${img.progress || 0}%` }}
                                                    />
                                                </div>
                                                <span className="text-[10px] text-slate-400">{img.progress || 0}%</span>
                                            </div>
                                        ) : !isImage ? (
                                            <div className="h-full w-full flex items-center gap-2.5 px-3">
                                                <FileTypeIcon mime={img.mime} className="w-8 h-8 shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                    <div className="text-[11px] text-slate-200 truncate font-medium">{img.name || "File"}</div>
                                                    <div className="text-[10px] text-slate-500">{formatFileSize(img.size)}</div>
                                                    {isLoading && (
                                                        <div className="mt-1 w-full rounded-full bg-white/10 h-1 overflow-hidden">
                                                            <div
                                                                className="h-full rounded-full bg-[rgb(var(--ss-accent-rgb))] transition-all duration-300"
                                                                style={{ width: `${img.progress || 0}%` }}
                                                            />
                                                        </div>
                                                    )}
                                                    {isError && (
                                                        <div className="text-[10px] text-red-400 mt-0.5">Failed</div>
                                                    )}
                                                    {isReady && (
                                                        <div className="text-[10px] text-green-400 mt-0.5">Ready</div>
                                                    )}
                                                </div>
                                            </div>
                                        ) : null}

                                        {/* Error overlay for images */}
                                        {isImage && isError && (
                                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 gap-1">
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-400"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>
                                                <span className="text-[9px] text-red-400">Failed</span>
                                            </div>
                                        )}

                                        {/* Retry button for errored items */}
                                        {isError && retryPendingUpload && (
                                            <button
                                                type="button"
                                                onClick={() => retryPendingUpload(img.id)}
                                                className={[
                                                    "absolute flex items-center justify-center rounded-full bg-[rgb(var(--ss-accent-rgb))] text-slate-900 shadow-lg transition-all hover:scale-110",
                                                    isImage ? "bottom-1 left-1/2 -translate-x-1/2 h-6 w-6" : "top-1 right-7 h-5 w-5",
                                                ].join(" ")}
                                                title="Retry upload"
                                                aria-label="Retry upload"
                                            >
                                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
                                            </button>
                                        )}

                                        {/* Remove button */}
                                        {removePendingImage && (
                                            <button
                                                type="button"
                                                onClick={() => removePendingImage(img.id)}
                                                className="absolute top-1 right-1 h-5 w-5 rounded-full bg-black/60 text-white text-[11px] flex items-center justify-center"
                                                title="Remove"
                                                aria-label="Remove"
                                            >
                                                x
                                            </button>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <div className="flex gap-3 items-end relative bg-white/5 p-3 rounded-2xl border border-white/10 shadow-[0_18px_60px_-45px_rgba(0,0,0,0.9)] ring-1 ring-white/5 transition-all focus-within:ring-[rgb(var(--ss-accent-rgb)/0.5)] focus-within:border-[rgb(var(--ss-accent-rgb)/0.35)] focus-within:bg-white/10">
                    <input
                        ref={fileInputRef}
                        type="file"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                            handleFiles(e.target.files);
                            e.target.value = "";
                        }}
                    />
                    <button
                        type="button"
                        onClick={() => fileInputRef.current && fileInputRef.current.click()}
                        disabled={attachmentsDisabled}
                        className={[
                            "h-11 w-11 rounded-xl border border-white/10 flex items-center justify-center transition-colors",
                            attachmentsDisabled
                                ? "bg-white/5 text-slate-500 cursor-not-allowed"
                                : "bg-white/10 hover:bg-white/16 text-slate-200"
                        ].join(" ")}
                        title="Attach files"
                        aria-label="Attach files"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            if (attachmentsDisabled) return;
                            if (onOpenGifPicker) onOpenGifPicker();
                        }}
                        disabled={attachmentsDisabled}
                        className={[
                            "h-11 w-11 rounded-xl border border-white/10 flex items-center justify-center transition-colors text-xs font-semibold tracking-wide",
                            attachmentsDisabled
                                ? "bg-white/5 text-slate-500 cursor-not-allowed"
                                : "bg-white/10 hover:bg-white/16 text-slate-200"
                        ].join(" ")}
                        title="Add GIF"
                        aria-label="Add GIF"
                    >
                        GIF
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            if (onOpenEmojiPicker) onOpenEmojiPicker();
                        }}
                        className="h-11 w-11 rounded-xl border border-white/10 bg-white/10 hover:bg-white/16 flex items-center justify-center transition-colors text-slate-200"
                        title="Add emoji"
                        aria-label="Add emoji"
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line></svg>
                    </button>
                    <textarea
                        ref={textareaRef}
                        value={input}
                        maxLength={MAX_MESSAGE_CHARS}
                        onChange={(e) => setInput(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
                        placeholder="Type a message..."
                        onPaste={handlePaste}
                        onKeyDown={(e) => {
                            if (e.key === "Escape") {
                                e.preventDefault();
                                if (editingMessageId) cancelEdit();
                                else if (replyToId) cancelReply();
                                return;
                            }

                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                if (!sendDisabled) sendMessage();
                            }
                        }}
                        className="flex-1 min-w-0 bg-transparent py-3 px-3 ss-text text-slate-100 placeholder:text-slate-500 outline-none resize-none max-h-32 custom-scrollbar"
                        style={{ minHeight: "44px", height: "auto" }}
                        rows={1}
                        // Auto-expand height
                        onInput={(e) => {
                            e.target.style.height = "auto";
                            e.target.style.height = Math.min(e.target.scrollHeight, 128) + "px";
                        }}
                    />

                    <button
                        onClick={sendMessage}
                        disabled={sendDisabled}
                        className={[
                            "h-11 px-5 mb-1 rounded-xl text-sm font-semibold transition-all duration-200 shadow-[0_12px_40px_-24px_rgba(0,0,0,0.8)]",
                            !sendDisabled
                                ? "pill-accent bg-[rgb(var(--ss-accent-rgb))] text-slate-900 hover:brightness-110 active:scale-95"
                                : "bg-white/10 text-slate-500 border border-white/10 cursor-not-allowed"
                        ].join(" ")}
                    >
                        {editingMessageId ? "Save" : "Send"}
                    </button>
                </div>

                <div className="mt-2 flex items-center justify-between px-2">
                    <div className="text-slate-500 text-[11px] font-medium tracking-wide">
                        {editingMessageId ? "Editing text only" : ""}
                    </div>
                    <div className={`text-[11px] font-medium transition-colors ${input.length >= MAX_MESSAGE_CHARS ? "text-amber-400" : "text-slate-500"}`}>
                        {input.length > 0 && `${input.length}/${MAX_MESSAGE_CHARS}`}
                    </div>
                </div>
            </div>
        </footer>
    );
}
