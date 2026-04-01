import { useEffect, useState, useCallback } from "react";
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
  AddRegular,
  DeleteRegular,
  CheckmarkCircleRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { invoke } from "@tauri-apps/api/core";
import { useReveal } from "../hooks/useReveal";
import type { ConfigEntry } from "../types";

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

  // ─── Multi-config state ──────────────────────────────────────────────────
  const [configExpanded, setConfigExpanded] = useState(false);
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [configText, setConfigText] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const loadConfigList = useCallback(async () => {
    try {
      const list = await invoke<ConfigEntry[]>("list_configs");
      setConfigs(list);
      // Auto-select: keep current selection, or pick active, or first
      setSelectedName((prev) => {
        if (prev && list.find((c) => c.name === prev)) return prev;
        const active = list.find((c) => c.active);
        return active?.name ?? list[0]?.name ?? null;
      });
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  }, []);

  const loadConfigContent = useCallback(async (name: string) => {
    try {
      const content = await invoke<string>("get_config", { name });
      setConfigText(content);
      setConfigDirty(false);
      setConfigMsg(null);
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  }, []);

  // Load list when expanded
  useEffect(() => {
    if (configExpanded) {
      loadConfigList();
    }
  }, [configExpanded, loadConfigList]);

  // Load content when selection changes
  useEffect(() => {
    if (configExpanded && selectedName) {
      loadConfigContent(selectedName);
    }
  }, [configExpanded, selectedName, loadConfigContent]);

  const handleSaveConfig = async () => {
    if (!selectedName) return;
    setConfigSaving(true);
    try {
      await invoke("save_config", { name: selectedName, content: configText });
      setConfigDirty(false);
      setConfigMsg({ type: "ok", text: "Saved. Restart core to apply changes." });
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
    setConfigSaving(false);
  };

  const handleSetActive = async () => {
    if (!selectedName) return;
    try {
      await invoke("set_active_config", { name: selectedName });
      await loadConfigList();
      setConfigMsg({ type: "ok", text: `'${selectedName}' is now the active config.` });
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  };

  const handleCreate = async () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    try {
      await invoke("create_config", { name: trimmed });
      setCreating(false);
      setNewName("");
      await loadConfigList();
      setSelectedName(trimmed);
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  };

  const handleDelete = async () => {
    if (!selectedName) return;
    const active = configs.find((c) => c.active);
    if (active?.name === selectedName) {
      setConfigMsg({ type: "err", text: "Cannot delete the active config." });
      return;
    }
    try {
      await invoke("delete_config", { name: selectedName });
      setSelectedName(null);
      await loadConfigList();
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
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
        JSON.parse(text); // validate JSON
      } catch {
        setConfigMsg({ type: "err", text: "Invalid JSON file" });
        return;
      }
      // Use filename without extension as config name
      const baseName = file.name.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_") || "imported";
      try {
        await invoke("save_config", { name: baseName, content: text });
        await loadConfigList();
        setSelectedName(baseName);
        setConfigMsg({ type: "ok", text: `Imported as '${baseName}'.` });
      } catch (e) {
        setConfigMsg({ type: "err", text: String(e) });
      }
    };
    input.click();
  };

  const isActive = configs.find((c) => c.name === selectedName)?.active ?? false;

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

            {/* Config Tabs */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              {configs.map((c) => (
                <button
                  key={c.name}
                  className={`fluent-btn reveal-target ${selectedName === c.name ? "accent" : ""}`}
                  onClick={() => { setSelectedName(c.name); setConfigMsg(null); }}
                  style={{ fontSize: 12, minHeight: 28, padding: "4px 12px", position: "relative" }}
                >
                  {c.active && <CheckmarkCircleRegular style={{ fontSize: 13 }} />}
                  {c.name}
                </button>
              ))}

              {/* Create new */}
              {creating ? (
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
                    placeholder="name"
                    style={{
                      border: "1px solid var(--border-default)",
                      borderRadius: "var(--radius-sm)",
                      padding: "3px 8px",
                      fontSize: 12,
                      background: "var(--bg-surface)",
                      color: "var(--text-primary)",
                      outline: "none",
                      width: 100,
                      height: 28,
                      fontFamily: "inherit",
                    }}
                  />
                  <button className="fluent-btn accent reveal-target" onClick={handleCreate} style={{ fontSize: 12, minHeight: 28, padding: "4px 8px" }}>OK</button>
                  <button className="fluent-btn reveal-target" onClick={() => setCreating(false)} style={{ fontSize: 12, minHeight: 28, padding: "4px 8px" }}>✕</button>
                </div>
              ) : (
                <button
                  className="fluent-btn reveal-target"
                  onClick={() => { setCreating(true); setNewName(""); }}
                  style={{ fontSize: 12, minHeight: 28, padding: "4px 8px" }}
                  title="New config"
                >
                  <AddRegular style={{ fontSize: 14 }} />
                </button>
              )}

              <button
                className="fluent-btn reveal-target"
                onClick={handleImportFile}
                style={{ fontSize: 12, minHeight: 28, padding: "4px 10px" }}
              >
                <ArrowImportRegular style={{ fontSize: 14 }} />
                Import
              </button>
            </div>

            {/* Empty state */}
            {configs.length === 0 && (
              <div style={{ textAlign: "center", padding: "32px 0", color: "var(--text-tertiary)", fontSize: 13 }}>
                No configs yet. Click <strong>+</strong> to create one or <strong>Import</strong> a file.
              </div>
            )}

            {/* Toolbar (when a config is selected) */}
            {selectedName && (
              <>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {!isActive && (
                    <button className="fluent-btn accent reveal-target" onClick={handleSetActive} style={{ fontSize: 13 }}>
                      <CheckmarkCircleRegular style={{ fontSize: 16 }} />
                      Set Active
                    </button>
                  )}
                  <button className="fluent-btn reveal-target" onClick={() => selectedName && loadConfigContent(selectedName)} style={{ fontSize: 13 }}>
                    Reload
                  </button>
                  {!isActive && (
                    <button className="fluent-btn reveal-target" onClick={handleDelete} style={{ fontSize: 13, color: "var(--status-danger)" }}>
                      <DeleteRegular style={{ fontSize: 16 }} />
                      Delete
                    </button>
                  )}
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
                  {isActive ? "✦ Active config" : "Inactive"} · Paste JSON or import from file. Save and restart core to apply.
                </div>
              </>
            )}
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
