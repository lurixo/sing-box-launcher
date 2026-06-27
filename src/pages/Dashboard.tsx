import { useEffect, useState, useCallback, useRef, memo } from "react";
import {
  PlayRegular,
  StopRegular,
  ArrowSyncRegular,
  ShieldCheckmarkRegular,
  TimerRegular,
  ServerRegular,
  PlugConnectedRegular,
  GlobeRegular,
  FolderOpenRegular,
  ChevronDownRegular,
  ChevronUpRegular,
  CheckmarkCircleFilled,
  ArrowUpRegular,
  ArrowDownRegular,
  ArrowUploadRegular,
  ArrowDownloadRegular,
  FlashRegular,
  SearchRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useReveal } from "../hooks/useReveal";
import { useT } from "../i18n/strings";
import { formatBytes, formatSpeed } from "../lib/format";
import type { OutboundIpInfo, CoreMetrics, ClashModeInfo } from "../types";

// Font size scaled to the address length so a full IPv6 never overflows the
// inline slot in the status card (IPv4 ~14px down to ~10px for long IPv6).
function ipFont(ip: string): number {
  const n = ip.length;
  if (n <= 15) return 14;
  if (n <= 21) return 13;
  if (n <= 28) return 12;
  if (n <= 34) return 11;
  return 10;
}

function countryCodeToFlag(cc: string): string {
  if (!/^[a-zA-Z]{2}$/.test(cc)) return "🏳️";
  const u = cc.toUpperCase();
  return (
    String.fromCodePoint(0x1f1e6 + u.charCodeAt(0) - 65) +
    String.fromCodePoint(0x1f1e6 + u.charCodeAt(1) - 65)
  );
}

// Compact outbound IP(s) shown inline in the status card, right after uptime.
// Shows both IPv4 and IPv6 (whatever the backend's domain-strategy-aware
// trace returns), font-scaled per address so long IPv6 never overflows/wraps.
// Module-level cache so switching pages back shows the last-known IP instantly
// (no remount flash). refreshSignal (ipNonce) is bumped ONLY on a real outbound
// change (clash-mode or node switch), so we re-resolve only when it differs from
// the nonce the cache was fetched at — a plain remount keeps the same nonce.
let ipCache: OutboundIpInfo[] = [];
let ipCacheNonce = -1;

function OutboundIpInline({ refreshSignal = 0 }: { refreshSignal?: number }) {
  const running = useAppStore((s) => s.status.running);
  const [lines, setLines] = useState<OutboundIpInfo[]>(ipCache);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!running) { setLines([]); ipCache = []; ipCacheNonce = -1; return; }
    if (refreshSignal === ipCacheNonce) return; // remount with no real change → keep cache
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tryFetch = async () => {
      if (cancelled) return;
      try {
        const res = await invoke<OutboundIpInfo[]>("get_outbound_ip");
        if (cancelled) return;
        if (res.length > 0) {
          setLines(res);
          ipCache = res;
          ipCacheNonce = refreshSignal; // lock the cache only on a real result
          return;
        }
        // Empty right after a node/mode switch (still reconnecting) is a soft
        // failure: keep the last-known IP shown and retry, rather than caching
        // the empty result and advancing the nonce (which hid the row until the
        // next manual switch).
      } catch {
        /* transport error — keep last known, retry */
      }
      if (!cancelled && attempts++ < 8) timer = setTimeout(tryFetch, 700);
    };
    timer = setTimeout(tryFetch, refreshSignal <= 0 ? 800 : 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [running, refreshSignal]);

  const copy = (ip: string) => {
    navigator.clipboard?.writeText(ip).then(() => {
      setCopied(ip);
      setTimeout(() => setCopied((c) => (c === ip ? null : c)), 1200);
    }).catch(() => {});
  };

  if (!running || lines.length === 0) return null;

  return (
    <div className="fluent-card reveal-target" style={{ padding: "8px 14px", display: "flex", flexDirection: "column", justifyContent: "center", gap: 1, minWidth: 0 }}>
      {lines.map((info) => {
        // ASN + IP share one length-scaled monospace size so the two read as a
        // consistent pair and a long IPv6 still fits.
        const fs = ipFont(info.asn + info.ip);
        return (
          <button
            key={info.ip}
            onClick={() => copy(info.ip)}
            title={`${info.asn ? info.asn + "  ·  " : ""}${info.ip}`}
            style={{ display: "flex", alignItems: "center", gap: 6, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit", maxWidth: "100%" }}
          >
            <span style={{ fontSize: 14, flexShrink: 0, lineHeight: 1, fontFamily: "'Twemoji Country Flags', 'Segoe UI Emoji', sans-serif" }}>{countryCodeToFlag(info.country)}</span>
            {info.asn && (
              <span style={{ fontFamily: "monospace", fontSize: fs, fontWeight: 700, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{info.asn}</span>
            )}
            <span style={{ fontFamily: "monospace", fontSize: fs, fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap" }}>{info.ip}</span>
            {copied === info.ip && <span style={{ fontSize: 10, color: "var(--accent-default)", flexShrink: 0 }}>✓</span>}
          </button>
        );
      })}
    </div>
  );
}

function formatUptime(secs: number): string {
  if (secs === 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Self-contained uptime ticker so the whole dashboard does NOT re-render every
// second (that, plus an unstable chart scale, was the source of the flicker).
function Uptime() {
  const running = useAppStore((s) => s.status.running);
  const base = useAppStore((s) => s.status.uptime_secs);
  const [secs, setSecs] = useState(base);
  useEffect(() => {
    setSecs(base);
    if (!running) return;
    const id = setInterval(() => setSecs((p) => p + 1), 1000);
    return () => clearInterval(id);
  }, [running, base]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 13, lineHeight: 1 }}>
      <TimerRegular style={{ fontSize: 15, display: "block" }} />
      <span style={{ fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{formatUptime(running ? secs : 0)}</span>
    </div>
  );
}

// ─── Live traffic chart (hand-rolled SVG, memoized, shared Y, smoothed scale) ─
const MAX_SAMPLES = 60; // ~1 min window at 1 Hz
const SCALE_FLOOR = 1024; // 1 KB/s floor → idle scale stays put (no flicker)
const FALL_RATE = 0.1; // slow-fall: the scale eases ~10%/s back toward the window peak

const TrafficChart = memo(function TrafficChart({ samples, max }: { samples: { up: number; down: number }[]; max: number }) {
  const W = 300;
  const H = 72;
  const data = samples.length ? samples : [{ up: 0, down: 0 }];
  const n = data.length;
  // Fixed step + right alignment: the newest point is pinned to the right edge
  // and the line grows in from the right while the window fills — no horizontal
  // stretch/wobble as points accumulate (the offset trick).
  const stepX = W / Math.max(MAX_SAMPLES - 1, 1);
  const offset = Math.max(0, MAX_SAMPLES - n);
  const xAt = (i: number) => (offset + i) * stepX;
  const yAt = (v: number) => H - 2 - (v / max) * (H - 8);
  const points = (key: "up" | "down") =>
    data.map((s, i) => `${xAt(i).toFixed(1)},${yAt(s[key]).toFixed(1)}`).join(" ");
  const area = (key: "up" | "down") =>
    `M${xAt(0).toFixed(1)},${H} L${points(key).split(" ").join(" L")} L${xAt(n - 1).toFixed(1)},${H} Z`;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: 72, display: "block" }}>
      <path d={area("down")} fill="var(--accent-default)" opacity={0.13} />
      <path d={area("up")} fill="var(--status-success)" opacity={0.11} />
      <polyline points={points("down")} fill="none" stroke="var(--accent-default)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <polyline points={points("up")} fill="none" stroke="var(--status-success)" strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

function ClashModeSelector({ onModeChanged }: { onModeChanged?: () => void }) {
  const running = useAppStore((s) => s.status.running);
  const t = useT();
  const [info, setInfo] = useState<ClashModeInfo | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!running) { setInfo(null); return; }
    try {
      setInfo(await invoke<ClashModeInfo>("get_clash_mode"));
    } catch {
      setInfo(null);
    }
  }, [running]);

  // Fetch immediately on start and retry quickly until the clash API answers,
  // so the selector appears on first screen instead of after a fixed delay.
  useEffect(() => {
    if (!running) { setInfo(null); return; }
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stop) return;
      try {
        const v = await invoke<ClashModeInfo>("get_clash_mode");
        if (stop) return;
        setInfo(v);
        if (v.modes.length > 0) return; // got modes — stop polling
      } catch { /* API not ready yet */ }
      if (!stop) timer = setTimeout(tick, 600);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); };
  }, [running]);

  const setMode = async (mode: string) => {
    if (busy || !info || mode === info.current) return;
    setBusy(true);
    setInfo({ ...info, current: mode });
    try {
      await invoke("set_clash_mode", { mode });
      onModeChanged?.();
    } catch {
      refresh();
    }
    setBusy(false);
  };

  if (!running || !info || info.modes.length === 0) return null;

  // A "Mode" label precedes the segmented control; the mode VALUES stay verbatim
  // (the core's own strings — no translation). Lives in its own small reveal card.
  return (
    <div className="fluent-card reveal-target" style={{ padding: "8px 14px", display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>{t("dashboard.mode")}</span>
      <div style={{ display: "inline-flex", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", overflow: "hidden" }}>
      {info.modes.map((mode, i) => {
        const active = mode.toLowerCase() === info.current.toLowerCase();
        return (
          <button
            key={mode}
            onClick={() => setMode(mode)}
            disabled={busy}
            style={{
              border: "none",
              borderLeft: i === 0 ? "none" : "1px solid var(--border-default)",
              background: active ? "var(--accent-btn-bg)" : "transparent",
              color: active ? "var(--accent-btn-text)" : "var(--text-primary)",
              fontFamily: "inherit", fontSize: 12, padding: "5px 14px",
              cursor: busy ? "default" : "pointer",
            }}
          >
            {mode}
          </button>
        );
      })}
      </div>
    </div>
  );
}

function StatTile({ icon, label, value, accent, onClick, upcase = true }: { icon: React.ReactNode; label: string; value: string; accent?: string; onClick?: () => void; upcase?: boolean }) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? label : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
      className="reveal-target"
      style={{ background: "var(--bg-card)", border: "1px solid var(--border-card)", borderRadius: "var(--radius-sm)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 4, minWidth: 0, cursor: onClick ? "pointer" : undefined }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 11, textTransform: upcase ? "uppercase" : "none", letterSpacing: "0.03em" }}>
        <span style={{ display: "flex", color: accent || "var(--text-tertiary)" }}>{icon}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}

// Persists the last metrics across page switches so returning to the dashboard
// shows the last-known values immediately instead of blanking until the next tick.
let metricsCache: { m: CoreMetrics | null; samples: { up: number; down: number }[]; smoothPeak: number } = {
  m: null,
  samples: [],
  smoothPeak: SCALE_FLOOR,
};

const MetricsOverview = memo(function MetricsOverview() {
  const running = useAppStore((s) => s.status.running);
  const setPage = useAppStore((s) => s.setPage);
  const t = useT();
  const [m, setM] = useState<CoreMetrics | null>(metricsCache.m);
  const [samples, setSamples] = useState<{ up: number; down: number }[]>(metricsCache.samples);
  const [chartMax, setChartMax] = useState<number>(metricsCache.smoothPeak * 1.2);
  const latest = useRef<CoreMetrics | null>(null);
  const samplesRef = useRef(metricsCache.samples);
  const smoothPeak = useRef(metricsCache.smoothPeak);

  // Buffer incoming ticks in a ref and render at a fixed 1 Hz cadence. This
  // decouples the render/repaint rate from the core's push rate: a fast (or
  // mis-throttled) status stream can no longer drive a re-render storm — which
  // was both the chart "too-fast flicker" and the WebView2 renderer crash.
  useEffect(() => {
    if (!running) {
      setM(null); setSamples([]); setChartMax(SCALE_FLOOR * 1.2);
      latest.current = null; samplesRef.current = []; smoothPeak.current = SCALE_FLOOR;
      metricsCache = { m: null, samples: [], smoothPeak: SCALE_FLOOR };
      return;
    }
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const fn = await listen<CoreMetrics>("metrics-tick", (e) => { latest.current = e.payload; });
      if (cancelled) { fn(); return; }
      unlisten = fn;
    })();
    const flush = setInterval(() => {
      const cur = latest.current;
      if (!cur) return;
      const next = [...samplesRef.current, { up: Math.max(0, cur.uplink), down: Math.max(0, cur.downlink) }].slice(-MAX_SAMPLES);
      samplesRef.current = next;
      // Shared-axis peak across BOTH series with fast-rise / slow-fall
      // hysteresis: the scale jumps up instantly to fit a new burst (so a spike
      // never clips) but eases back down slowly — the axis never re-scales
      // abruptly tick-to-tick the way the old per-render niceCeil() did.
      const windowPeak = next.reduce((mx, p) => Math.max(mx, p.up, p.down), 0);
      const target = Math.max(SCALE_FLOOR, windowPeak);
      const prev = smoothPeak.current;
      smoothPeak.current = target >= prev ? target : prev + (target - prev) * FALL_RATE;
      metricsCache = { m: cur, samples: next, smoothPeak: smoothPeak.current };
      setM(cur);
      setSamples(next);
      setChartMax(smoothPeak.current * 1.2);
    }, 1000);
    return () => { cancelled = true; unlisten?.(); clearInterval(flush); };
  }, [running]);

  const last = samples[samples.length - 1] ?? { up: 0, down: 0 };
  const dash = (v: string) => (running ? v : "—");

  return (
    <div className="fluent-card" style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: 14 }}>
      <div className="card-header" style={{ marginBottom: 0 }}>{t("dashboard.overview")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <StatTile icon={<ArrowUpRegular style={{ fontSize: 14 }} />} label={t("dashboard.upSpeed")} value={dash(formatSpeed(last.up))} accent="var(--status-success)" />
        <StatTile icon={<ArrowDownRegular style={{ fontSize: 14 }} />} label={t("dashboard.downSpeed")} value={dash(formatSpeed(last.down))} accent="var(--accent-default)" />
        <StatTile icon={<PlugConnectedRegular style={{ fontSize: 14 }} />} label={t("dashboard.connections")} value={running && m ? String(m.connections_in) : "—"} onClick={running ? () => setPage("connections") : undefined} />
        <StatTile icon={<ServerRegular style={{ fontSize: 14 }} />} label={t("dashboard.memory")} value={running && m ? formatBytes(m.memory) : "—"} upcase={false} />
        <StatTile icon={<ArrowUploadRegular style={{ fontSize: 14 }} />} label={t("dashboard.upTotal")} value={running && m ? formatBytes(m.uplink_total) : "—"} />
        <StatTile icon={<ArrowDownloadRegular style={{ fontSize: 14 }} />} label={t("dashboard.downTotal")} value={running && m ? formatBytes(m.downlink_total) : "—"} />
      </div>
      {/* Legend + live readout above the chart, color-matched to each line. */}
      <div style={{ display: "flex", gap: 18, fontSize: 12, alignItems: "center" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--accent-default)", flexShrink: 0 }} />
          <ArrowDownRegular style={{ fontSize: 13, color: "var(--text-secondary)" }} />
          <span style={{ color: "var(--text-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{dash(formatSpeed(last.down))}</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--status-success)", flexShrink: 0 }} />
          <ArrowUpRegular style={{ fontSize: 13, color: "var(--text-secondary)" }} />
          <span style={{ color: "var(--text-primary)", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{dash(formatSpeed(last.up))}</span>
        </span>
      </div>
      <TrafficChart samples={running ? samples : []} max={chartMax} />
    </div>
  );
});

// ─── Proxy groups (merged from the former Proxies page) ──────────────────────
function DelayBadge({ delay, t }: { delay?: number; t: ReturnType<typeof useT> }) {
  if (delay === undefined) return null;
  let cls = "timeout";
  let text = t("proxies.timeout");
  if (delay > 0 && delay < 200) { cls = "fast"; text = `${delay}ms`; }
  else if (delay >= 200 && delay < 500) { cls = "medium"; text = `${delay}ms`; }
  else if (delay >= 500) { cls = "slow"; text = `${delay}ms`; }
  return <span className={`delay-badge ${cls}`}>{text}</span>;
}

const ProxyGroups = memo(function ProxyGroups() {
  const running = useAppStore((s) => s.status.running);
  const groups = useAppStore((s) => s.groups);
  const switchProxy = useAppStore((s) => s.switchProxy);
  const testDelay = useAppStore((s) => s.testDelay);
  const delays = useAppStore((s) => s.delays);
  const testingGroup = useAppStore((s) => s.testingGroup);
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  if (!running || groups.length === 0) return null;

  return (
    <div className="fluent-card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="card-header" style={{ padding: "14px 18px 10px", marginBottom: 0 }}>
        <GlobeRegular style={{ fontSize: 16 }} />
        {t("proxies.title")}
        <span style={{ marginLeft: 6, color: "var(--text-tertiary)", textTransform: "none", letterSpacing: 0 }}>
          {t("proxies.groupsCount", { count: groups.length })}
        </span>
      </div>
      {groups.map((g) => {
        const isOpen = open === g.name;
        const gd = delays[g.name];
        const nodes = (g.all ?? []).filter((node) => !isOpen || node.toLowerCase().includes(search.toLowerCase()));
        return (
          <div key={g.name} style={{ borderTop: "1px solid var(--border-divider)" }}>
            <button
              onClick={() => { setOpen(isOpen ? null : g.name); setSearch(""); }}
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%",
                padding: "12px 18px", border: "none", background: "transparent",
                cursor: "pointer", color: "var(--text-primary)", fontFamily: "inherit", textAlign: "left",
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, flexShrink: 0 }}>{g.name}</span>
              <span style={{ fontSize: 12, color: "var(--accent-default)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
                {g.now}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}>
                {t("proxies.nodesCount", { count: g.all.length })}
              </span>
              <span style={{ display: "flex", color: "var(--text-tertiary)", flexShrink: 0 }}>
                {isOpen ? <ChevronUpRegular /> : <ChevronDownRegular />}
              </span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 18px 14px" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, background: "var(--bg-surface)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)", padding: "4px 10px" }}>
                    <SearchRegular style={{ fontSize: 15, color: "var(--text-tertiary)" }} />
                    <input
                      type="text"
                      placeholder={t("proxies.searchNodes")}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      style={{ border: "none", background: "transparent", outline: "none", color: "var(--text-primary)", fontSize: 13, flex: 1, fontFamily: "inherit" }}
                    />
                  </div>
                  <button
                    className="fluent-btn"
                    onClick={() => testDelay(g.name)}
                    disabled={testingGroup !== null}
                    style={{ fontSize: 13, whiteSpace: "nowrap" }}
                  >
                    {testingGroup === g.name ? (
                      <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
                    ) : (
                      <FlashRegular style={{ fontSize: 16 }} />
                    )}
                    {t("proxies.testAll")}
                  </button>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
                  {nodes.map((node) => {
                    const selected = node === g.now;
                    return (
                      <div
                        key={node}
                        className={`node-card ${selected ? "selected" : ""}`}
                        onClick={() => switchProxy(g.name, node)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchProxy(g.name, node); } }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flex: 1, minWidth: 0 }}>
                          {selected && <CheckmarkCircleFilled style={{ fontSize: 16, color: "var(--accent-default)", flexShrink: 0 }} />}
                          <span style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node}</span>
                        </div>
                        <DelayBadge delay={gd?.[node]} t={t} />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
});

export function Dashboard() {
  const { status, loading, error, startCore, stopCore, restartCore, toggleProxy, clearError, ipNonce, bumpIp } =
    useAppStore();
  const t = useT();

  const revealRef = useReveal<HTMLDivElement>();

  return (
    <div
      ref={revealRef}
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
        {t("dashboard.title")}
      </h1>

      {error && (
        <div className="infobar error">
          <span style={{ flex: 1 }}>{error}</span>
          <button
            className="fluent-btn reveal-target"
            onClick={clearError}
            style={{ padding: "2px 8px", minHeight: 24, fontSize: 12 }}
          >
            {t("common.dismiss")}
          </button>
        </div>
      )}

      {/* Status row — a set of small reveal cards rather than one big card, so
          the highlight only lights the card under the cursor. */}
      <div style={{ display: "flex", alignItems: "stretch", gap: 12, flexWrap: "wrap" }}>
        <div className="fluent-card reveal-target" style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 8 }}>
          <span
            className={`status-dot ${
              status.running ? (status.proxy_enabled ? "proxy" : "running") : "stopped"
            }`}
          />
          <span style={{ fontSize: 15, fontWeight: 600, whiteSpace: "nowrap" }}>
            {status.running
              ? status.proxy_enabled ? t("dashboard.status.proxyActive") : t("dashboard.status.running")
              : t("dashboard.status.stopped")}
          </span>
        </div>
        {status.running && (
          <div className="fluent-card reveal-target" style={{ padding: "10px 16px", display: "flex", alignItems: "center" }}>
            <Uptime />
          </div>
        )}
        <OutboundIpInline refreshSignal={ipNonce} />
        <ClashModeSelector onModeChanged={bumpIp} />
      </div>

      {/* Controls */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div className="section-label" style={{ marginBottom: 14 }}>{t("dashboard.controls")}</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!status.running ? (
            <button className="fluent-btn accent reveal-target" onClick={startCore} disabled={loading}>
              {loading ? <span className="progress-ring" style={{ width: 16, height: 16, borderWidth: 2 }} /> : <PlayRegular style={{ fontSize: 16 }} />}
              {t("dashboard.start")}
            </button>
          ) : (
            <>
              <button className="fluent-btn reveal-target" onClick={stopCore} disabled={loading}>
                {loading ? <span className="progress-ring" style={{ width: 16, height: 16, borderWidth: 2 }} /> : <StopRegular style={{ fontSize: 16 }} />}
                {t("dashboard.stop")}
              </button>
              <button className="fluent-btn reveal-target" onClick={restartCore} disabled={loading}>
                <ArrowSyncRegular style={{ fontSize: 16 }} />
                {t("dashboard.restart")}
              </button>
            </>
          )}
          <button
            className={`fluent-btn reveal-target ${status.proxy_enabled ? "accent" : ""}`}
            onClick={toggleProxy}
            disabled={!status.running || !status.proxy_server || loading}
            title={status.running && !status.proxy_server ? t("dashboard.noProxyServer") : undefined}
          >
            <ShieldCheckmarkRegular style={{ fontSize: 16 }} />
            {status.proxy_enabled ? t("dashboard.systemProxyOn") : t("dashboard.systemProxyOff")}
          </button>
          <button className="fluent-btn reveal-target" onClick={() => invoke("open_base_dir")} style={{ marginLeft: "auto" }}>
            <FolderOpenRegular style={{ fontSize: 16 }} />
            {t("dashboard.openDirectory")}
          </button>
        </div>
      </div>

      {/* Live metrics */}
      <MetricsOverview />

      {/* Proxy groups */}
      <ProxyGroups />

      {/* Status Bar */}
      <div
        style={{
          display: "flex", gap: 24, fontSize: 12, color: "var(--text-secondary)",
          padding: "4px 0", borderTop: "1px solid var(--border-divider)", paddingTop: 12,
        }}
      >
        <span>{t("dashboard.proxyLabel")} <code style={{ color: "var(--text-primary)" }}>{status.proxy_server}</code></span>
        <span>{t("dashboard.apiLabel")} <code style={{ color: "var(--text-primary)" }}>{status.api_address}</code></span>
      </div>
    </div>
  );
}
