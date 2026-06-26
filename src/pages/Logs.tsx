import { useEffect, useMemo, useRef, useState } from "react";
import { DeleteRegular } from "@fluentui/react-icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useReveal } from "../hooks/useReveal";
import { useT } from "../i18n/strings";
import { useAppStore } from "../stores/appStore";
import type { AppSettings, LogLine } from "../types";

const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

function rank(level: string): number {
  const i = LEVELS.indexOf(level as Level);
  return i < 0 ? 2 : i;
}

function levelColor(level: string): string {
  switch (level) {
    case "error":
      return "var(--status-danger)";
    case "warn":
      return "var(--status-warning)";
    case "debug":
    case "trace":
      return "var(--text-tertiary)";
    default:
      return "var(--text-secondary)";
  }
}

function fmtTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
  } catch {
    return "";
  }
}

export function Logs() {
  const t = useT();
  const revealRef = useReveal<HTMLDivElement>();

  const running = useAppStore((s) => s.status.running);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [source, setSource] = useState<"core" | "app">("core");
  const [minLevel, setMinLevel] = useState<Level>("info");
  const [autoScroll, setAutoScroll] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((m) => (m === msg ? null : m)), 2500);
  };

  // Seed the level from the persisted kernel log level — this switch is the
  // single source of truth for verbosity (it also filters the view below).
  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        if ((LEVELS as readonly string[]).includes(s.log_level)) {
          setMinLevel(s.log_level as Level);
        }
      })
      .catch(() => {});
  }, []);

  // Change the kernel verbosity + the display filter together. sing-box reads
  // log.level only at startup (no live/reload API), so when the core is running
  // we reload it so the new level actually takes effect — with a toast so the
  // brief reconnect isn't mysterious. This is a *kernel* reload, distinct from
  // the visible GUI restart on the dashboard.
  const changeLevel = async (level: Level) => {
    if (level === minLevel) return;
    setMinLevel(level);
    try {
      await invoke("set_log_level", { level });
      if (running) {
        await invoke("restart_core");
        showToast(t("logs.levelRestarted", { level: level.toUpperCase() }));
      }
    } catch {
      /* noop */
    }
  };

  useEffect(() => {
    const merge = (incoming: LogLine[]) =>
      setLines((prev) => {
        const map = new Map<number, LogLine>();
        for (const l of prev) map.set(l.seq, l);
        for (const l of incoming) map.set(l.seq, l);
        const merged = [...map.values()].sort((a, b) => a.seq - b.seq);
        return merged.length > 5000 ? merged.slice(-5000) : merged;
      });

    // Coalesce the live log stream: buffer incoming lines and flush on a timer
    // so a burst can't drive a per-line re-render/repaint storm (a second
    // WebView2 ACCESS_VIOLATION source, like the unthrottled chart was).
    let buffer: LogLine[] = [];
    const flush = setInterval(() => {
      if (buffer.length) { const batch = buffer; buffer = []; merge(batch); }
    }, 250);

    // Register the live listener before fetching the backlog so no line slips
    // through the gap between the snapshot and the subscription.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const fn = await listen<LogLine>("log-line", (e) => { buffer.push(e.payload); });
      if (cancelled) { fn(); return; }
      unlisten = fn;
      try {
        merge(await invoke<LogLine[]>("get_logs"));
      } catch {
        /* noop */
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      clearInterval(flush);
    };
  }, []);

  const visible = useMemo(
    () => lines.filter((l) => l.source === source && rank(l.level) >= rank(minLevel)).slice(-2000),
    [lines, source, minLevel],
  );

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visible, autoScroll]);

  const handleClear = async () => {
    try {
      await invoke("clear_logs");
    } catch {
      /* noop */
    }
    setLines([]);
  };

  const tabBtn = (id: "core" | "app", label: string) => (
    <button
      className={`fluent-btn reveal-target ${source === id ? "accent" : ""}`}
      onClick={() => setSource(id)}
      style={{ fontSize: 13, minHeight: 30, padding: "4px 16px" }}
    >
      {label}
    </button>
  );

  return (
    <div
      ref={revealRef}
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16, height: "100%" }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
        {t("logs.title")}
      </h1>

      {/* Toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 4 }}>
          {tabBtn("core", t("logs.core"))}
          {tabBtn("app", t("logs.app"))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t("logs.minLevel")}</span>
          <select
            value={minLevel}
            onChange={(e) => changeLevel(e.target.value as Level)}
            title={t("logs.levelApplyHint")}
            style={{
              border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)",
              padding: "4px 8px", fontSize: 12, background: "var(--bg-surface)",
              color: "var(--text-primary)", outline: "none", height: 30, fontFamily: "inherit",
            }}
          >
            {LEVELS.map((l) => (
              <option key={l} value={l}>{l.toUpperCase()}</option>
            ))}
          </select>
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
          <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
          {t("logs.autoScroll")}
        </label>

        <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginLeft: "auto" }}>
          {t("logs.count", { count: visible.length })}
        </span>
        <button
          className="fluent-btn reveal-target"
          onClick={handleClear}
          style={{ fontSize: 12, minHeight: 30, padding: "4px 12px" }}
        >
          <DeleteRegular style={{ fontSize: 14 }} />
          {t("logs.clear")}
        </button>
      </div>

      {toast && (
        <div className="infobar" style={{ background: "var(--status-success-bg)", borderColor: "var(--status-success)" }}>
          {toast}
        </div>
      )}

      {/* Log view */}
      <div
        ref={scrollRef}
        className="fluent-card"
        style={{
          flex: 1, minHeight: 0, overflow: "auto", padding: "10px 12px",
          fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
          fontSize: 12, lineHeight: 1.55, background: "var(--bg-surface)",
        }}
      >
        {visible.length === 0 ? (
          <div style={{ color: "var(--text-tertiary)", textAlign: "center", padding: "28px 0" }}>
            {t("logs.empty")}
          </div>
        ) : (
          visible.map((l) => (
            <div key={l.seq} style={{ display: "flex", gap: 10, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
              <span style={{ color: "var(--text-tertiary)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                {fmtTime(l.ts)}
              </span>
              <span style={{ color: levelColor(l.level), flexShrink: 0, width: 46, textTransform: "uppercase" }}>
                {l.level}
              </span>
              <span style={{ color: "var(--text-primary)", flex: 1 }}>{l.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
