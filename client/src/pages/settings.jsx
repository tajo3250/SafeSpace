// src/pages/settings.jsx
import React from "react";
import { useNavigate } from "react-router-dom";
import { useSettings } from "../context/settings.jsx";
import logoWordmark from "../assets/brand/logo-wordmark.svg";

const ACCENTS = [
  { key: "teal", label: "Teal", rgb: "45 212 191" },
  { key: "blue", label: "Blue", rgb: "59 130 246" },
  { key: "purple", label: "Purple", rgb: "168 85 247" },
  { key: "rose", label: "Rose", rgb: "244 63 94" },
  { key: "amber", label: "Amber", rgb: "245 158 11" },
  { key: "lime", label: "Lime", rgb: "132 204 22" },
];

function ChoiceButton({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={[
        "px-3 py-2 rounded-xl border text-sm font-semibold transition-colors",
        active
          ? "bg-[rgb(var(--ss-accent-rgb)/0.18)] border-[rgb(var(--ss-accent-rgb)/0.45)] text-white"
          : "bg-white/5 border-white/10 text-slate-200 hover:bg-white/10",
      ].join(" ")}
      type="button"
    >
      {children}
    </button>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const { textSize, accent, setTextSize, setAccent, reset } = useSettings();

  return (
    <div className="min-h-[calc(100dvh-var(--ss-banner-h,0px))] text-slate-100">
      <header className="sticky top-0 z-10 border-b border-white/10 bg-white/10 backdrop-blur-xl">
        <div className="h-16 px-4 flex items-center gap-3">
          <button
            onClick={() => navigate("/chat")}
            className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
            type="button"
          >
            Back
          </button>

          <img src={logoWordmark} alt="SafeSpace" className="h-8 w-auto rounded-xl" />

          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold truncate text-white">Settings</div>
            <div className="text-xs text-slate-300/80 truncate">
              Readability and appearance (local-only)
            </div>
          </div>

          <button
            onClick={reset}
            className="text-sm px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/16 border border-white/10 text-slate-100"
            type="button"
          >
            Reset
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto p-4 space-y-4">
        <section className="rounded-2xl glass-panel p-5">
          <div className="font-semibold mb-1">Readability</div>
          <div className="text-slate-300/80 text-sm mb-3">
            Adjust text size across the UI (messages + inputs).
          </div>

          <div className="flex flex-wrap gap-2">
            <ChoiceButton active={textSize === "sm"} onClick={() => setTextSize("sm")}>
              Small
            </ChoiceButton>
            <ChoiceButton active={textSize === "md"} onClick={() => setTextSize("md")}>
              Medium
            </ChoiceButton>
            <ChoiceButton active={textSize === "lg"} onClick={() => setTextSize("lg")}>
              Large
            </ChoiceButton>
          </div>

          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3">
            <div className="text-slate-300/80 ss-text-sm">Preview</div>
            <div className="mt-1 ss-text">
              This is what message text looks like with your selected size.
            </div>
          </div>
        </section>

        <section className="rounded-2xl glass-panel p-5">
          <div className="font-semibold mb-1">Accent color</div>
          <div className="text-slate-300/80 text-sm mb-3">
            Changes highlights, buttons, and unread indicators. Default remains SafeSpace teal.
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.key}
                onClick={() => setAccent(a.key)}
                className={[
                  "flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors",
                  accent === a.key
                    ? "bg-[rgb(var(--ss-accent-rgb)/0.18)] border-[rgb(var(--ss-accent-rgb)/0.45)]"
                    : "bg-white/5 border-white/10 hover:bg-white/10",
                ].join(" ")}
                type="button"
              >
                <span
                  className="h-3 w-3 rounded-full border border-white/20"
                  style={{ backgroundColor: `rgb(${a.rgb})` }}
                />
                <span className="font-semibold">{a.label}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="rounded-2xl glass-panel p-5">
          <div className="font-semibold mb-1">Message limits</div>
          <div className="text-slate-300/80 text-sm">
            Current max message length: <span className="font-semibold">4000 characters</span>.
          </div>
        </section>
      </main>
    </div>
  );
}
