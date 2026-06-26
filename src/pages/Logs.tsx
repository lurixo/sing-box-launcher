import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownloadRegular, DeleteRegular } from "@fluentui/react-icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { useReveal } from "../hooks/useReveal";
import { useT } from "../i18n/strings";
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

  const [lines, setLines] = useState<LogLine[]>([]);
  const [source, setSource] = useState<"core" | "app">("core");
  const [minLevel, setMinLevel] = useState<Level>("info");
  const [autoScroll, setAutoScroll] = useState(true);
  // Per-entry export selection, keyed by the line's seq so it survives buffer
  // scroll-off (lines that roll out of the buffer are simply skipped on export).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Seed the display filter from the persisted preference. The core always logs
  // at full (trace) detail; this switch only filters what the view renders.
  useEffect(() => {
    invoke<AppSettings>("get_settings")
      .then((s) => {
        if ((LEVELS as readonly string[]).includes(s.log_level)) {
          setMinLevel(s.log_level as Level);
        }
      })
      .catch(() => {});
  }, []);

  // Pure GUI filter: the core always records at trace, so changing the level
  // only changes what the view renders — instant, and it never touches the core,
  // system proxy, or connections. We persist the choice as the default filter.
  const changeLevel = (level: Level) => {
    if (level === minLevel) return;
    setMinLevel(level);
    invoke("set_log_level", { level }).catch(() => {});
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

  // Cap rendered rows so a trace-level view (the core always logs at trace)
  // can't explode the DOM. Auto-scroll keeps the tail visible.
  const visible = useMemo(
    () => lines.filter((l) => l.source === source && rank(l.level) >= rank(minLevel)).slice(-1000),
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
    setSelected(new Set());
    setExportMsg(null);
  };

  const allVisibleSelected = visible.length > 0 && visible.every((l) => selected.has(l.seq));

  const toggleOne = (seq: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seq)) next.delete(seq);
      else next.add(seq);
      return next;
    });

  const toggleAllVisible = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (visible.every((l) => next.has(l.seq))) {
        for (const l of visible) next.delete(l.seq);
      } else {
        for (const l of visible) next.add(l.seq);
      }
      return next;
    });

  // Export the selected entries to a user-chosen text file. The save dialog
  // picks the path; the backend writes only the lines whose seq is selected.
  const handleExport = async () => {
    const seqs = [...selected];
    if (seqs.length === 0) return;
    try {
      const path = await save({
        defaultPath: "maestro-logs.txt",
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (!path) return; // user cancelled
      const n = await invoke<number>("export_logs", { seqs, dest: path });
      setExportMsg({ ok: true, text: t("logs.exportDone", { count: n }) });
    } catch {
      setExportMsg({ ok: false, text: t("logs.exportFailed") });
    }
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

        <label
          style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--text-secondary)", cursor: visible.length ? "pointer" : "default", opacity: visible.length ? 1 : 0.5 }}
          title={t("logs.selectAllHint")}
        >
          <input
            type="checkbox"
            checked={allVisibleSelected}
            disabled={visible.length === 0}
            onChange={toggleAllVisible}
          />
          {t("logs.selectAll")}
        </label>

        <span style={{ fontSize: 12, color: "var(--text-tertiary)", marginLeft: "auto" }}>
          {t("logs.count", { count: visible.length })}
        </span>
        <button
          className="fluent-btn reveal-target"
          onClick={handleExport}
          disabled={selected.size === 0}
          title={t("logs.exportHint")}
          style={{ fontSize: 12, minHeight: 30, padding: "4px 12px", opacity: selected.size === 0 ? 0.5 : 1 }}
        >
          <ArrowDownloadRegular style={{ fontSize: 14 }} />
          {selected.size ? t("logs.exportN", { count: selected.size }) : t("logs.export")}
        </button>
        <button
          className="fluent-btn reveal-target"
          onClick={handleClear}
          style={{ fontSize: 12, minHeight: 30, padding: "4px 12px" }}
        >
          <DeleteRegular style={{ fontSize: 14 }} />
          {t("logs.clear")}
        </button>
      </div>

      {exportMsg && (
        <div
          className="infobar"
          style={{
            background: exportMsg.ok ? "var(--status-success-bg)" : "var(--status-danger-bg)",
            borderColor: exportMsg.ok ? "var(--status-success)" : "var(--status-danger)",
          }}
        >
          {exportMsg.text}
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
            <div key={l.seq} style={{ display: "flex", gap: 10, whiteSpace: "pre-wrap", wordBreak: "break-word", background: selected.has(l.seq) ? "var(--bg-subtle)" : undefined }}>
              <input
                type="checkbox"
                checked={selected.has(l.seq)}
                onChange={() => toggleOne(l.seq)}
                style={{ flexShrink: 0, marginTop: 3, cursor: "pointer" }}
                aria-label={t("logs.selectLine")}
              />
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
