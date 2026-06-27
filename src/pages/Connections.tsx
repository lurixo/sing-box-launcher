import { useEffect, useState, useCallback, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { DismissRegular, DismissCircleRegular } from "@fluentui/react-icons";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
import { useReveal } from "../hooks/useReveal";
import { useT } from "../i18n/strings";
import { formatBytes, formatDuration, normalizeMs } from "../lib/format";
import type { ConnInfo } from "../types";

/** One connection as a single clipboard line. */
function connLine(c: ConnInfo): string {
  const meta = [
    c.network ? c.network.toUpperCase() : "",
    c.chain.length ? c.chain.join(" → ") : c.outbound,
    c.rule,
  ].filter(Boolean).join("  ·  ");
  return `${c.domain || c.destination || c.id}  |  ${meta}  |  ↑ ${formatBytes(c.upload)}  ↓ ${formatBytes(c.download)}`;
}

export function Connections() {
  const running = useAppStore((s) => s.status.running);
  const t = useT();
  const revealRef = useReveal<HTMLDivElement>();
  const [conns, setConns] = useState<ConnInfo[]>([]);
  // Anchor index of an in-progress drag-select, or null when idle. Declared up
  // here so the poll below can freeze the list while a drag is live (round-9 L4):
  // a refresh that adds/removes rows mid-drag would shift indices and make the
  // anchor highlight the wrong range.
  const dragRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    if (!running) { setConns([]); return; }
    if (dragRef.current != null) return; // don't reshuffle rows mid drag-select
    try {
      setConns(await invoke<ConnInfo[]>("get_connections"));
    } catch {
      /* keep the last snapshot */
    }
  }, [running]);

  useEffect(() => {
    if (!running) { setConns([]); return; }
    refresh();
    const id = setInterval(refresh, 1500);
    return () => clearInterval(id);
  }, [running, refresh]);

  const closeOne = async (id: string) => {
    try { await invoke("close_connection", { id }); } catch { /* noop */ }
    setConns((c) => c.filter((x) => x.id !== id));
  };

  const closeAll = async () => {
    try { await invoke("close_all_connections"); } catch { /* noop */ }
    setConns([]);
  };

  // Stable order (oldest first) so rows never shuffle on a poll and the close
  // button stays put under the cursor.
  const sorted = [...conns].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));

  // Drag-select to copy (round-9 I): a vertical drag over the rows highlights the
  // covered range; on release it copies those rows to the clipboard — same gesture
  // as the log page, no text highlight.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!copyMsg) return;
    const id = setTimeout(() => setCopyMsg(null), 2000);
    return () => clearTimeout(id);
  }, [copyMsg]);

  const rowIdxAt = (target: EventTarget | null): number | null => {
    const el = (target as HTMLElement | null)?.closest?.(".row-reveal[data-idx]") as HTMLElement | null;
    if (!el) return null;
    const i = Number(el.dataset.idx);
    return Number.isFinite(i) ? i : null;
  };

  const selectRange = (anchor: number, cursor: number) => {
    const lo = Math.min(anchor, cursor);
    const hi = Math.max(anchor, cursor);
    setSelected(new Set(sorted.slice(lo, hi + 1).map((c) => c.id)));
  };

  const onRowMouseDown = (e: ReactMouseEvent, idx: number) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
    e.preventDefault(); // no text highlight
    dragRef.current = idx;
    selectRange(idx, idx);
  };

  const onBodyMouseMove = (e: ReactMouseEvent) => {
    if (dragRef.current == null) return;
    const cur = rowIdxAt(e.target);
    if (cur != null) selectRange(dragRef.current, cur);
  };

  const endDragCopy = () => {
    if (dragRef.current == null) return;
    dragRef.current = null;
    const text = sorted.filter((c) => selected.has(c.id)).map(connLine).join("\n");
    if (!text) return;
    const count = selected.size;
    navigator.clipboard?.writeText(text)
      .then(() => setCopyMsg(t("connections.copied", { count })))
      .catch(() => {});
  };

  return (
    <div
      ref={revealRef}
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16, height: "100%" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
          {t("connections.title")}
        </h1>
        <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
          {t("connections.count", { count: sorted.length })}
        </span>
        <button
          className="fluent-btn reveal-target"
          onClick={closeAll}
          disabled={!running || sorted.length === 0}
          style={{ marginLeft: "auto", fontSize: 12, minHeight: 30, padding: "4px 12px" }}
        >
          <DismissRegular style={{ fontSize: 14 }} />
          {t("connections.closeAll")}
        </button>
      </div>

      {!running ? (
        <div className="fluent-card" style={{ padding: "40px 0", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
          {t("connections.startToView")}
        </div>
      ) : sorted.length === 0 ? (
        <div className="fluent-card" style={{ padding: "40px 0", textAlign: "center", color: "var(--text-tertiary)", fontSize: 13 }}>
          {t("connections.empty")}
        </div>
      ) : (
        <div
          className="fluent-card"
          onMouseMove={onBodyMouseMove}
          onMouseUp={endDragCopy}
          onMouseLeave={endDragCopy}
          style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 0, userSelect: "none", WebkitUserSelect: "none" }}
        >
          {sorted.map((c, idx) => (
            <div
              key={c.id}
              data-idx={idx}
              className="row-reveal"
              onMouseDown={(e) => onRowMouseDown(e, idx)}
              style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 14px", borderBottom: "1px solid var(--border-divider)",
                background: selected.has(c.id) ? "var(--bg-subtle)" : undefined,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {c.domain || c.destination || c.id}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {[
                    c.network ? c.network.toUpperCase() : "",
                    c.chain.length ? c.chain.join(" → ") : c.outbound,
                    c.rule,
                  ].filter(Boolean).join("  ·  ")}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", fontSize: 11, color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums", flexShrink: 0, minWidth: 82 }}>
                <span>↑ {formatBytes(c.upload)}</span>
                <span>↓ {formatBytes(c.download)}</span>
              </div>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", fontVariantNumeric: "tabular-nums", flexShrink: 0, width: 46, textAlign: "right" }}>
                {c.created_at > 0 ? formatDuration(normalizeMs(c.created_at)) : "—"}
              </span>
              <button
                className="fluent-btn reveal-target"
                onClick={() => closeOne(c.id)}
                title={t("connections.close")}
                aria-label={t("connections.close")}
                style={{ flexShrink: 0, minHeight: 28, minWidth: 32, padding: "4px 8px" }}
              >
                <DismissCircleRegular style={{ fontSize: 14 }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Floating "copied" toast — overlay, never displaces the list. */}
      {copyMsg && (
        <div
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            zIndex: 2000, padding: "8px 16px", borderRadius: "var(--radius-md)",
            background: "var(--status-success-bg)", border: "1px solid var(--status-success)",
            color: "var(--text-primary)", fontSize: 13, pointerEvents: "none",
            boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
          }}
        >
          {copyMsg}
        </div>
      )}
    </div>
  );
}
