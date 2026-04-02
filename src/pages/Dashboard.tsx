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
  EditRegular,
  ArrowLeftRegular,
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

  // ─── Config state ─────────────────────────────────────────────────────────
  const [configExpanded, setConfigExpanded] = useState(false);
  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  // null = list view, string = detail/editor view
  const [editingName, setEditingName] = useState<string | null>(null);
  const [configText, setConfigText] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  // Creating
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // Renaming
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");

  const loadConfigList = useCallback(async () => {
    try {
      const list = await invoke<ConfigEntry[]>("list_configs");
      setConfigs(list);
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  }, []);

  const openEditor = useCallback(async (name: string) => {
    try {
      const content = await invoke<string>("get_config", { name });
      setConfigText(content);
      setConfigDirty(false);
      setConfigMsg(null);
      setEditingName(name);
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

  const handleSaveConfig = async () => {
    if (!editingName) return;
    setConfigSaving(true);
    try {
      await invoke("save_config", { name: editingName, content: configText });
      setConfigDirty(false);
      setConfigMsg({ type: "ok", text: "Saved. Restart core to apply changes." });
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
    setConfigSaving(false);
  };

  const handleSetActive = async (name: string) => {
    try {
      await invoke("set_active_config", { name });
      await loadConfigList();
      setConfigMsg({ type: "ok", text: `'${name}' is now the active config.` });
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
      openEditor(trimmed);
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  };

  const handleDelete = async (name: string) => {
    const active = configs.find((c) => c.active);
    if (active?.name === name) {
      setConfigMsg({ type: "err", text: "Cannot delete the active config." });
      return;
    }
    try {
      await invoke("delete_config", { name });
      if (editingName === name) setEditingName(null);
      await loadConfigList();
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  };

  const handleRename = async (oldName: string) => {
    const trimmed = renameInput.trim();
    if (!trimmed || trimmed === oldName) {
      setRenamingName(null);
      return;
    }
    try {
      await invoke("rename_config", { oldName, newName: trimmed });
      if (editingName === oldName) setEditingName(trimmed);
      setRenamingName(null);
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
        JSON.parse(text);
      } catch {
        setConfigMsg({ type: "err", text: "Invalid JSON file" });
        return;
      }
      const baseName = file.name.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_") || "imported";
      try {
        await invoke("save_config", { name: baseName, content: text });
        await loadConfigList();
        openEditor(baseName);
        setConfigMsg({ type: "ok", text: `Imported as '${baseName}'.` });
      } catch (e) {
        setConfigMsg({ type: "err", text: String(e) });
      }
    };
    input.click();
  };

  const handleBackToList = () => {
    setEditingName(null);
    setConfigMsg(null);
    loadConfigList();
  };

  const isEditingActive = editingName ? (configs.find((c) => c.name === editingName)?.active ?? false) : false;

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

      {/* ─── Configuration Section ─── */}
      <div className="fluent-card" style={{ padding: 0, overflow: "hidden" }}>
        <button
          onClick={() => setConfigExpanded(!configExpanded)}
          style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            padding: "14px 20px", border: "none", background: "transparent",
            cursor: "pointer", color: "var(--text-primary)", fontFamily: "inherit",
            fontSize: 14, fontWeight: 600, textAlign: "left",
          }}
        >
          <DocumentRegular style={{ fontSize: 18 }} />
          Configuration
          <span style={{ marginLeft: "auto", display: "flex", color: "var(--text-tertiary)" }}>
            {configExpanded ? <ChevronUpRegular /> : <ChevronDownRegular />}
          </span>
        </button>

        {configExpanded && (
          <div style={{ padding: "0 20px 18px" }}>

            {/* Message bar (shared between list & detail) */}
            {configMsg && (
              <div
                className={`infobar ${configMsg.type === "err" ? "error" : ""}`}
                style={{
                  marginBottom: 12,
                  ...(configMsg.type === "ok" ? { background: "var(--status-success-bg)", borderColor: "var(--status-success)" } : {}),
                }}
              >
                {configMsg.text}
              </div>
            )}

            {/* ═══ Detail / Editor View ═══ */}
            {editingName !== null ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Back + title */}
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    className="fluent-btn reveal-target"
                    onClick={handleBackToList}
                    style={{ fontSize: 12, minHeight: 28, padding: "4px 10px" }}
                  >
                    <ArrowLeftRegular style={{ fontSize: 14 }} />
                    Back
                  </button>
                  <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
                    {editingName}
                  </span>
                  {isEditingActive && (
                    <span style={{ fontSize: 11, color: "var(--accent-default)", fontWeight: 600 }}>
                      ✦ Active
                    </span>
                  )}
                </div>

                {/* Toolbar */}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {!isEditingActive && (
                    <button className="fluent-btn accent reveal-target" onClick={() => handleSetActive(editingName)} style={{ fontSize: 13 }}>
                      <CheckmarkCircleRegular style={{ fontSize: 16 }} />
                      Set Active
                    </button>
                  )}
                  <button className="fluent-btn reveal-target" onClick={() => openEditor(editingName)} style={{ fontSize: 13 }}>
                    Reload
                  </button>
                  <button
                    className="fluent-btn reveal-target"
                    onClick={() => { setRenamingName(editingName); setRenameInput(editingName); }}
                    style={{ fontSize: 13 }}
                  >
                    <EditRegular style={{ fontSize: 16 }} />
                    Rename
                  </button>
                  {!isEditingActive && (
                    <button className="fluent-btn reveal-target" onClick={() => handleDelete(editingName)} style={{ fontSize: 13, color: "var(--status-danger)" }}>
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

                {/* Rename inline */}
                {renamingName === editingName && (
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      autoFocus
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleRename(editingName); if (e.key === "Escape") setRenamingName(null); }}
                      style={{
                        border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)",
                        padding: "4px 10px", fontSize: 13, background: "var(--bg-surface)",
                        color: "var(--text-primary)", outline: "none", flex: 1, height: 30, fontFamily: "inherit",
                      }}
                    />
                    <button className="fluent-btn accent reveal-target" onClick={() => handleRename(editingName)} style={{ fontSize: 12, minHeight: 30, padding: "4px 10px" }}>
                      Confirm
                    </button>
                    <button className="fluent-btn reveal-target" onClick={() => setRenamingName(null)} style={{ fontSize: 12, minHeight: 30, padding: "4px 10px" }}>
                      Cancel
                    </button>
                  </div>
                )}

                {/* Editor */}
                <textarea
                  value={configText}
                  onChange={(e) => { setConfigText(e.target.value); setConfigDirty(true); setConfigMsg(null); }}
                  spellCheck={false}
                  placeholder="Paste your sing-box config JSON here..."
                  style={{
                    width: "100%", height: 300, resize: "vertical",
                    fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
                    fontSize: 12, lineHeight: 1.5, padding: 12,
                    borderRadius: "var(--radius-sm)", border: "1px solid var(--border-default)",
                    background: "var(--bg-surface)", color: "var(--text-primary)",
                    outline: "none", tabSize: 2,
                  }}
                  onFocus={(e) => (e.target.style.borderColor = "var(--accent-default)")}
                  onBlur={(e) => (e.target.style.borderColor = "var(--border-default)")}
                />

                <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>
                  Paste config JSON or import from file. Save and restart core to apply.
                </div>
              </div>

            ) : (
              /* ═══ List View ═══ */
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {/* Toolbar */}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  {creating ? (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flex: 1 }}>
                      <input
                        autoFocus
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
                        placeholder="Config name"
                        style={{
                          border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)",
                          padding: "4px 10px", fontSize: 13, background: "var(--bg-surface)",
                          color: "var(--text-primary)", outline: "none", width: 160, height: 30, fontFamily: "inherit",
                        }}
                      />
                      <button className="fluent-btn accent reveal-target" onClick={handleCreate} style={{ fontSize: 12, minHeight: 30, padding: "4px 10px" }}>Create</button>
                      <button className="fluent-btn reveal-target" onClick={() => setCreating(false)} style={{ fontSize: 12, minHeight: 30, padding: "4px 10px" }}>Cancel</button>
                    </div>
                  ) : (
                    <>
                      <button className="fluent-btn reveal-target" onClick={() => { setCreating(true); setNewName(""); }} style={{ fontSize: 13 }}>
                        <AddRegular style={{ fontSize: 16 }} />
                        New
                      </button>
                      <button className="fluent-btn reveal-target" onClick={handleImportFile} style={{ fontSize: 13 }}>
                        <ArrowImportRegular style={{ fontSize: 16 }} />
                        Import
                      </button>
                    </>
                  )}
                </div>

                {/* Config list */}
                {configs.length === 0 ? (
                  <div style={{ textAlign: "center", padding: "28px 0", color: "var(--text-tertiary)", fontSize: 13 }}>
                    No configs yet. Click <strong>New</strong> to create or <strong>Import</strong> a file.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                    {configs.map((c) => (
                      <div
                        key={c.name}
                        style={{
                          display: "flex", alignItems: "center", gap: 10,
                          padding: "10px 14px", borderRadius: "var(--radius-sm)",
                          border: c.active ? "1px solid var(--accent-default)" : "1px solid var(--border-card)",
                          background: c.active ? "var(--bg-selected)" : "var(--bg-card)",
                          cursor: "pointer", transition: "background 0.1s",
                        }}
                        onClick={() => openEditor(c.name)}
                        onMouseEnter={(e) => { if (!c.active) e.currentTarget.style.background = "var(--bg-card-hover)"; }}
                        onMouseLeave={(e) => { if (!c.active) e.currentTarget.style.background = "var(--bg-card)"; }}
                      >
                        <DocumentRegular style={{ fontSize: 16, color: "var(--text-secondary)", flexShrink: 0 }} />
                        {/* Name + rename inline */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {renamingName === c.name ? (
                            <div style={{ display: "flex", gap: 4, alignItems: "center" }} onClick={(e) => e.stopPropagation()}>
                              <input
                                autoFocus
                                value={renameInput}
                                onChange={(e) => setRenameInput(e.target.value)}
                                onKeyDown={(e) => { if (e.key === "Enter") handleRename(c.name); if (e.key === "Escape") setRenamingName(null); }}
                                style={{
                                  border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)",
                                  padding: "2px 8px", fontSize: 13, background: "var(--bg-surface)",
                                  color: "var(--text-primary)", outline: "none", flex: 1, fontFamily: "inherit",
                                }}
                              />
                              <button className="fluent-btn accent" onClick={(e) => { e.stopPropagation(); handleRename(c.name); }} style={{ fontSize: 11, minHeight: 24, padding: "2px 8px" }}>OK</button>
                              <button className="fluent-btn" onClick={(e) => { e.stopPropagation(); setRenamingName(null); }} style={{ fontSize: 11, minHeight: 24, padding: "2px 8px" }}>✕</button>
                            </div>
                          ) : (
                            <span style={{ fontSize: 13, fontWeight: c.active ? 600 : 400, color: "var(--text-primary)" }}>
                              {c.name}
                            </span>
                          )}
                        </div>
                        {c.active && (
                          <span style={{ fontSize: 11, color: "var(--accent-default)", fontWeight: 600, whiteSpace: "nowrap" }}>
                            <CheckmarkCircleRegular style={{ fontSize: 13, marginRight: 3, verticalAlign: "middle" }} />
                            Active
                          </span>
                        )}
                        {/* Action buttons */}
                        <div style={{ display: "flex", gap: 2, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                          <button
                            className="fluent-btn reveal-target"
                            onClick={() => { setRenamingName(c.name); setRenameInput(c.name); }}
                            style={{ fontSize: 11, minHeight: 26, padding: "2px 6px" }}
                            title="Rename"
                          >
                            <EditRegular style={{ fontSize: 13 }} />
                          </button>
                          {!c.active && (
                            <>
                              <button
                                className="fluent-btn reveal-target"
                                onClick={() => handleSetActive(c.name)}
                                style={{ fontSize: 11, minHeight: 26, padding: "2px 6px" }}
                                title="Set as active config"
                              >
                                <CheckmarkCircleRegular style={{ fontSize: 13 }} />
                              </button>
                              <button
                                className="fluent-btn reveal-target"
                                onClick={() => handleDelete(c.name)}
                                style={{ fontSize: 11, minHeight: 26, padding: "2px 6px", color: "var(--status-danger)" }}
                                title="Delete"
                              >
                                <DeleteRegular style={{ fontSize: 13 }} />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div
        style={{
          display: "flex", gap: 24, fontSize: 12, color: "var(--text-secondary)",
          padding: "4px 0", borderTop: "1px solid var(--border-divider)", paddingTop: 12,
        }}
      >
        <span>Proxy: <code style={{ color: "var(--text-primary)" }}>{status.proxy_server || "—"}</code></span>
        <span>API: <code style={{ color: "var(--text-primary)" }}>{status.api_address || "—"}</code></span>
      </div>
    </div>
  );
}
