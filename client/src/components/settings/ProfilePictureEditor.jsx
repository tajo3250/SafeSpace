// components/settings/ProfilePictureEditor.jsx
// Canvas-based profile picture crop/zoom/pan editor.
// Allows the user to select an image, zoom and pan to frame it, and upload a cropped version.

import React, { useState, useRef, useCallback, useEffect } from "react";

const CANVAS_SIZE = 220;
const OUTPUT_SIZE = 256;

export default function ProfilePictureEditor({ currentPicture, apiBase, token, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [imgSrc, setImgSrc] = useState(null);
  const [img, setImg] = useState(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);

  // Load image when a file is selected
  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setImgSrc(url);
    setEditing(true);
    setScale(1);
    setOffset({ x: 0, y: 0 });

    const image = new Image();
    image.onload = () => setImg(image);
    image.src = url;

    // Reset input so the same file can be selected again
    e.target.value = "";
  }, []);

  // Draw the image on the canvas with current zoom/pan
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

    // Calculate fit: scale image so the smaller dimension fills the canvas
    const baseScale = Math.max(CANVAS_SIZE / img.width, CANVAS_SIZE / img.height);
    const drawScale = baseScale * scale;
    const dw = img.width * drawScale;
    const dh = img.height * drawScale;
    const dx = (CANVAS_SIZE - dw) / 2 + offset.x;
    const dy = (CANVAS_SIZE - dh) / 2 + offset.y;

    // Draw image
    ctx.save();
    ctx.beginPath();
    ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, dx, dy, dw, dh);
    ctx.restore();

    // Draw circular border
    ctx.beginPath();
    ctx.arc(CANVAS_SIZE / 2, CANVAS_SIZE / 2, CANVAS_SIZE / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [img, scale, offset]);

  // Mouse/touch drag handlers
  const handlePointerDown = useCallback((e) => {
    e.preventDefault();
    setDragging(true);
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    setDragStart({ x: clientX - offset.x, y: clientY - offset.y });
  }, [offset]);

  const handlePointerMove = useCallback((e) => {
    if (!dragging) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    setOffset({ x: clientX - dragStart.x, y: clientY - dragStart.y });
  }, [dragging, dragStart]);

  const handlePointerUp = useCallback(() => setDragging(false), []);

  // Wheel zoom
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    setScale((s) => Math.max(0.5, Math.min(5, s + (e.deltaY > 0 ? -0.08 : 0.08))));
  }, []);

  // Global pointer up listener
  useEffect(() => {
    if (!dragging) return;
    const up = () => setDragging(false);
    window.addEventListener("mouseup", up);
    window.addEventListener("touchend", up);
    return () => {
      window.removeEventListener("mouseup", up);
      window.removeEventListener("touchend", up);
    };
  }, [dragging]);

  // Save: extract the full-resolution crop and upload as a file
  const handleSave = useCallback(async () => {
    if (!img) return;
    setSaving(true);
    setError("");
    try {
      // Create a high-res output canvas
      const outCanvas = document.createElement("canvas");
      outCanvas.width = OUTPUT_SIZE;
      outCanvas.height = OUTPUT_SIZE;
      const ctx = outCanvas.getContext("2d");

      const baseScale = Math.max(CANVAS_SIZE / img.width, CANVAS_SIZE / img.height);
      const drawScale = baseScale * scale;
      const dw = img.width * drawScale;
      const dh = img.height * drawScale;
      const dx = (CANVAS_SIZE - dw) / 2 + offset.x;
      const dy = (CANVAS_SIZE - dh) / 2 + offset.y;

      // Scale up to OUTPUT_SIZE
      const ratio = OUTPUT_SIZE / CANVAS_SIZE;
      ctx.drawImage(img, dx * ratio, dy * ratio, dw * ratio, dh * ratio);

      // Try WebP first, fall back to PNG if browser doesn't support WebP encoding
      let blob = await new Promise((resolve) =>
        outCanvas.toBlob(resolve, "image/webp", 0.9)
      );
      let filename = "avatar.webp";
      if (!blob) {
        blob = await new Promise((resolve) =>
          outCanvas.toBlob(resolve, "image/png")
        );
        filename = "avatar.png";
      }
      if (!blob) {
        setError("Could not process image. Try a different file.");
        return;
      }

      const formData = new FormData();
      formData.append("avatar", blob, filename);

      const res = await fetch(`${apiBase}/api/users/me/profile-picture`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      onSaved(data.profilePicture, data.profilePictureThumbnail);
      setEditing(false);
      setImgSrc(null);
      setImg(null);
    } catch (err) {
      console.error("Profile picture upload error:", err);
      setError(err.message || "Upload failed. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [img, scale, offset, apiBase, token, onSaved]);

  const handleRemove = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(`${apiBase}/api/users/me/profile`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ removeProfilePicture: true }),
      });
      if (!res.ok) throw new Error("Failed to remove");
      onSaved(null, null);
    } catch (err) {
      console.error("Remove profile picture error:", err);
    } finally {
      setSaving(false);
    }
  }, [apiBase, token, onSaved]);

  const handleCancel = useCallback(() => {
    setEditing(false);
    setImgSrc(null);
    setImg(null);
    if (imgSrc) URL.revokeObjectURL(imgSrc);
  }, [imgSrc]);

  // Current picture preview (not editing)
  if (!editing) {
    return (
      <div className="flex items-center gap-4">
        <div className="relative group">
          {currentPicture ? (
            <img
              src={currentPicture}
              alt="Profile"
              className="h-20 w-20 rounded-full object-cover border-2 border-white/10"
            />
          ) : (
            <div className="h-20 w-20 rounded-full bg-[rgb(var(--ss-accent-rgb)/0.15)] border-2 border-[rgb(var(--ss-accent-rgb)/0.3)] flex items-center justify-center">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--ss-accent-rgb))" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            className="hidden"
            onChange={handleFileSelect}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="px-4 py-1.5 rounded-lg bg-[rgb(var(--ss-accent-rgb)/0.15)] hover:bg-[rgb(var(--ss-accent-rgb)/0.25)] border border-[rgb(var(--ss-accent-rgb)/0.3)] text-[rgb(var(--ss-accent-rgb))] text-sm font-medium transition-all"
          >
            {currentPicture ? "Change Picture" : "Upload Picture"}
          </button>
          {currentPicture && (
            <button
              onClick={handleRemove}
              disabled={saving}
              className="px-4 py-1.5 rounded-lg bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 text-red-400 text-sm font-medium transition-all disabled:opacity-50"
            >
              Remove
            </button>
          )}
        </div>
      </div>
    );
  }

  // Editing mode: crop/zoom/pan
  return (
    <div className="flex flex-col items-center gap-4">
      <div className="text-sm text-slate-400 mb-1">
        Drag to reposition. Scroll to zoom.
      </div>
      <div
        className="relative rounded-full overflow-hidden border-2 border-[rgb(var(--ss-accent-rgb)/0.4)] shadow-[0_0_40px_-10px_rgb(var(--ss-accent-rgb)/0.3)]"
        style={{ width: CANVAS_SIZE, height: CANVAS_SIZE, touchAction: "none" }}
      >
        <canvas
          ref={canvasRef}
          width={CANVAS_SIZE}
          height={CANVAS_SIZE}
          className="cursor-grab active:cursor-grabbing"
          onMouseDown={handlePointerDown}
          onMouseMove={handlePointerMove}
          onMouseUp={handlePointerUp}
          onTouchStart={handlePointerDown}
          onTouchMove={handlePointerMove}
          onTouchEnd={handlePointerUp}
          onWheel={handleWheel}
        />
      </div>

      {/* Zoom slider */}
      <div className="flex items-center gap-3 w-full max-w-[260px]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-500 shrink-0">
          <circle cx="11" cy="11" r="8" />
          <line x1="8" y1="11" x2="14" y2="11" />
        </svg>
        <input
          type="range"
          min="50"
          max="500"
          step="5"
          value={scale * 100}
          onChange={(e) => setScale(Number(e.target.value) / 100)}
          className="flex-1 accent-[rgb(var(--ss-accent-rgb))]"
        />
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-slate-500 shrink-0">
          <circle cx="11" cy="11" r="8" />
          <line x1="8" y1="11" x2="14" y2="11" />
          <line x1="11" y1="8" x2="11" y2="14" />
        </svg>
      </div>

      {/* Error display */}
      {error && (
        <div className="px-3 py-2 rounded-lg bg-red-500/15 border border-red-500/20 text-sm text-red-300 text-center max-w-[280px]">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleCancel}
          className="px-5 py-2 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 text-slate-300 text-sm font-medium transition-all"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-5 py-2 rounded-lg bg-[rgb(var(--ss-accent-rgb)/0.6)] hover:bg-[rgb(var(--ss-accent-rgb)/0.8)] border border-[rgb(var(--ss-accent-rgb)/0.5)] text-white text-sm font-semibold transition-all disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save"}
        </button>
      </div>
    </div>
  );
}
