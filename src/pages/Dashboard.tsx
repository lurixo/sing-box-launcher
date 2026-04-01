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
  DocumentRegular,
  ArrowImportRegular,
  SaveRegular,
  ChevronDownRegular,
  ChevronUpRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { invoke } from "@tauri-apps/api/core";
import { useReveal } from "../hooks/useReveal";

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

  const revealRef = useReveal<HTMLDivElement>();

  // Uptime counter
  const [uptime, setUptime] = useState(status.uptime_secs);
  useEffect(() => {
    setUptime(status.uptime_secs);
    if (!status.running) return;
    const interval = setInterval(() => setUptime((p) => p + 1), 1000);
    return () => clearInterval(interval);
  }, [status.running, status.uptime_secs]);

  // Config editor state
  const [configExpanded, setConfigExpanded] = useState(false);
  const [configText, setConfigText] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadConfig = async () => {
    try {
      const content = await invoke<string>("get_config");
      setConfigText(content);
      setConfigDirty(false);
      setConfigMsg(null);
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  };

  useEffect(() => {
    if (configExpanded && !configText) {
      loadConfig();
    }
  }, [configExpanded]);

  const handleSaveConfig = async () => {
    setConfigSaving(true);
    try {
      await invoke("save_config", { content: configText });
      setConfigDirty(false);
      setConfigMsg({ type: "ok", text: "Config saved. Restart core to apply." });
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
    setConfigSaving(false);
  };

  const handleImportFile = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      const text = await file.text();
      try {
        JSON.parse(text); // validate
        setConfigText(text);
        setConfigDirty(true);
        setConfigMsg(null);
      } catch {
        setConfigMsg({ type: "err", text: "Invalid JSON file" });
      }
    };
    input.click();
  };

  return (
    <div
      ref={revealRef}
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
        Dashboard
      </h1>

      {error && (
        <div className="infobar error">
          <span style={{ flex: 1 }}>{error}</span>
          <button
            className="fluent-btn reveal-target"
            onClick={clearError}
            style={{ padding: "2px 8px", minHeight: 24, fontSize: 12 }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Status Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <div className="fluent-card reveal-target" style={{ padding: "16px 18px" }}>
          <div className="card-header">
            <ServerRegular style={{ fontSize: 16 }} />
            Status
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              className={`status-dot ${
                status.running ? (status.proxy_enabled ? "proxy" : "running") : "stopped"
              }`}
            />
            <span style={{ fontSize: 18, fontWeight: 600 }}>
              {status.running
                ? status.proxy_enabled ? "Proxy Active" : "Running"
                : "Stopped"}
            </span>
          </div>
        </div>

        <div className="fluent-card reveal-target" style={{ padding: "16px 18px" }}>
          <div className="card-header">
            <TimerRegular style={{ fontSize: 16 }} />
            Uptime
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
            {formatUptime(uptime)}
          </div>
        </div>

        <div className="fluent-card reveal-target" style={{ padding: "16px 18px" }}>
          <div className="card-header">
            <PlugConnectedRegular style={{ fontSize: 16 }} />
            Connection
          </div>
          <div
            style={{
              fontSize: 13,
              color: status.running ? "var(--text-primary)" : "var(--text-tertiary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {status.running ? status.proxy_server || "N/A" : "—"}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div className="section-label" style={{ marginBottom: 14 }}>Controls</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {!status.running ? (
            <button className="fluent-btn accent reveal-target" onClick={startCore} disabled={loading}>
              {loading ? <span className="progress-ring" style={{ width: 16, height: 16, borderWidth: 2 }} /> : <PlayRegular style={{ fontSize: 16 }} />}
              Start
            </button>
          ) : (
            <>
              <button className="fluent-btn reveal-target" onClick={stopCore} disabled={loading}>
                {loading ? <span className="progress-ring" style={{ width: 16, height: 16, borderWidth: 2 }} /> : <StopRegular style={{ fontSize: 16 }} />}
                Stop
              </button>
              <button className="fluent-btn reveal-target" onClick={restartCore} disabled={loading}>
                <ArrowSyncRegular style={{ fontSize: 16 }} />
                Restart
              </button>
            </>
          )}
          <button
            className={`fluent-btn reveal-target ${status.proxy_enabled ? "accent" : ""}`}
            onClick={toggleProxy}
            disabled={!status.running || loading}
          >
            <ShieldCheckmarkRegular style={{ fontSize: 16 }} />
            System Proxy {status.proxy_enabled ? "ON" : "OFF"}
          </button>
          <button className="fluent-btn reveal-target" onClick={() => invoke("open_base_dir")} style={{ marginLeft: "auto" }}>
            <FolderOpenRegular style={{ fontSize: 16 }} />
            Open Directory
          </button>
        </div>
      </div>

      {/* Config Editor */}
      <div className="fluent-card" style={{ padding: 0, overflow: "hidden" }}>
        <button
          onClick={() => setConfigExpanded(!configExpanded)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "14px 20px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            color: "var(--text-primary)",
            fontFamily: "inherit",
            fontSize: 14,
            fontWeight: 600,
            textAlign: "left",
          }}
        >
          <DocumentRegular style={{ fontSize: 18 }} />
          Configuration
          <span style={{ marginLeft: "auto", display: "flex", color: "var(--text-tertiary)" }}>
            {configExpanded ? <ChevronUpRegular /> : <ChevronDownRegular />}
          </span>
        </button>

        {configExpanded && (
          <div style={{ padding: "0 20px 18px", display: "flex", flexDirection: "column", gap: 10 }}>
            {/* Toolbar */}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button className="fluent-btn reveal-target" onClick={handleImportFile} style={{ fontSize: 13 }}>
                <ArrowImportRegular style={{ fontSize: 16 }} />
                Import File
              </button>
              <button className="fluent-btn reveal-target" onClick={loadConfig} style={{ fontSize: 13 }}>
                Reload
              </button>
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleSaveConfig}
                disabled={!configDirty || configSaving}
                style={{ fontSize: 13, marginLeft: "auto" }}
              >
                {configSaving ? <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <SaveRegular style={{ fontSize: 16 }} />}
                Save
              </button>
            </div>

            {/* Message */}
            {configMsg && (
              <div
                className={`infobar ${configMsg.type === "err" ? "error" : ""}`}
                style={configMsg.type === "ok" ? { background: "var(--status-success-bg)", borderColor: "var(--status-success)" } : undefined}
              >
                {configMsg.text}
              </div>
            )}

            {/* Editor */}
            <textarea
              value={configText}
              onChange={(e) => {
                setConfigText(e.target.value);
                setConfigDirty(true);
                setConfigMsg(null);
              }}
              spellCheck={false}
              style={{
                width: "100%",
                height: 280,
                resize: "vertical",
                fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
                fontSize: 12,
                lineHeight: 1.5,
                padding: 12,
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-default)",
                background: "var(--bg-surface)",
                color: "var(--text-primary)",
                outline: "none",
                tabSize: 2,
              }}
              onFocus={(e) => (e.target.style.borderColor = "var(--accent-default)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--border-default)")}
            />

            <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
              Paste config.json content directly or import from file. Save and restart core to apply changes.
            </div>
          </div>
        )}
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
