import { useEffect, useState } from "react";
import {
  PlayRegular,
  StopRegular,
  ArrowSyncRegular,
  ShieldCheckmarkRegular,
  TimerRegular,
  ServerRegular,
  PlugConnectedRegular,
  FolderOpenRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { invoke } from "@tauri-apps/api/core";

function formatUptime(secs: number): string {
  if (secs === 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function Dashboard() {
  const { status, loading, error, startCore, stopCore, restartCore, toggleProxy, clearError } =
    useAppStore();

  // Refresh uptime every second
  const [uptime, setUptime] = useState(status.uptime_secs);
  useEffect(() => {
    setUptime(status.uptime_secs);
    if (!status.running) return;
    const interval = setInterval(() => {
      setUptime((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [status.running, status.uptime_secs]);

  return (
    <div
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}
    >
      {/* Error InfoBar */}
      {error && (
        <div className="infobar error">
          <span style={{ flex: 1 }}>{error}</span>
          <button
            className="fluent-btn"
            onClick={clearError}
            style={{ padding: "2px 8px", minHeight: 24, fontSize: 12 }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <div className="fluent-card" style={{ padding: "16px 18px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              color: "var(--text-secondary)",
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <ServerRegular style={{ fontSize: 16 }} />
            Status
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className={`status-dot ${
                status.running
                  ? status.proxy_enabled
                    ? "proxy"
                    : "running"
                  : "stopped"
              }`}
            />
            <span style={{ fontSize: 18, fontWeight: 600 }}>
              {status.running
                ? status.proxy_enabled
                  ? "Proxy Active"
                  : "Running"
                : "Stopped"}
            </span>
          </div>
        </div>

        <div className="fluent-card" style={{ padding: "16px 18px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              color: "var(--text-secondary)",
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <TimerRegular style={{ fontSize: 16 }} />
            Uptime
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {formatUptime(uptime)}
          </div>
        </div>

        <div className="fluent-card" style={{ padding: "16px 18px" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              color: "var(--text-secondary)",
              fontSize: 12,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <PlugConnectedRegular style={{ fontSize: 16 }} />
            Connection
          </div>
          <div
            style={{
              fontSize: 13,
              color: status.running
                ? "var(--text-primary)"
                : "var(--text-tertiary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {status.running ? status.proxy_server || "N/A" : "—"}
          </div>
        </div>
      </div>

      {/* Control Buttons */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--text-secondary)",
            marginBottom: 14,
          }}
        >
          Controls
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!status.running ? (
            <button
              className="fluent-btn accent"
              onClick={startCore}
              disabled={loading}
            >
              {loading ? (
                <span className="progress-ring" style={{ width: 16, height: 16, borderWidth: 2 }} />
              ) : (
                <PlayRegular style={{ fontSize: 16 }} />
              )}
              Start
            </button>
          ) : (
            <>
              <button
                className="fluent-btn"
                onClick={stopCore}
                disabled={loading}
              >
                {loading ? (
                  <span className="progress-ring" style={{ width: 16, height: 16, borderWidth: 2 }} />
                ) : (
                  <StopRegular style={{ fontSize: 16 }} />
                )}
                Stop
              </button>
              <button
                className="fluent-btn"
                onClick={restartCore}
                disabled={loading}
              >
                <ArrowSyncRegular style={{ fontSize: 16 }} />
                Restart
              </button>
            </>
          )}

          <button
            className={`fluent-btn ${status.proxy_enabled ? "accent" : ""}`}
            onClick={toggleProxy}
            disabled={!status.running || loading}
          >
            <ShieldCheckmarkRegular style={{ fontSize: 16 }} />
            System Proxy {status.proxy_enabled ? "ON" : "OFF"}
          </button>

          <button
            className="fluent-btn"
            onClick={() => invoke("open_base_dir")}
            style={{ marginLeft: "auto" }}
          >
            <FolderOpenRegular style={{ fontSize: 16 }} />
            Open Directory
          </button>
        </div>
      </div>

      {/* Status Bar */}
      <div
        style={{
          display: "flex",
          gap: 24,
          fontSize: 12,
          color: "var(--text-secondary)",
          padding: "4px 0",
          borderTop: "1px solid var(--border-divider)",
          paddingTop: 12,
        }}
      >
        <span>
          Proxy: <code style={{ color: "var(--text-primary)" }}>{status.proxy_server || "—"}</code>
        </span>
        <span>
          API: <code style={{ color: "var(--text-primary)" }}>{status.api_address || "—"}</code>
        </span>
      </div>
    </div>
  );
}
