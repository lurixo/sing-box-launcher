import { useEffect, useState, useCallback, useRef } from "react";
import {
  DocumentRegular,
  ArrowImportRegular,
  SaveRegular,
  AddRegular,
  DeleteRegular,
  CheckmarkCircleRegular,
  EditRegular,
  ArrowLeftRegular,
  DocumentCheckmarkRegular,
  TextWrapRegular,
  CopyRegular,
  RenameRegular,
} from "@fluentui/react-icons";
import { invoke } from "@tauri-apps/api/core";
import { useReveal } from "../hooks/useReveal";
import { useT } from "../i18n/strings";
import { useAppStore } from "../stores/appStore";
import { JsonEditor, type JsonEditorHandle } from "../components/JsonEditor";
import type { ConfigEntry, CheckResult } from "../types";

// Best-effort: pull a 1-based line number out of a sing-box check error
// (`…config_format_tmp.json:LINE:COL: …`, or a generic "line N").
function parseErrorLine(msg: string): number | null {
  const m = msg.match(/\.json:(\d+)(?::\d+)?/) || msg.match(/\bline[ :]+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

export function Config() {
  const t = useT();
  const revealRef = useReveal<HTMLDivElement>();
  const running = useAppStore((s) => s.status.running);
  const restartCore = useAppStore((s) => s.restartCore);
  const [showRestart, setShowRestart] = useState(false);

  const [configs, setConfigs] = useState<ConfigEntry[]>([]);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [configText, setConfigText] = useState("");
  const [configDirty, setConfigDirty] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [configMsg, setConfigMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [wrap, setWrap] = useState(true);
  const [errorLine, setErrorLine] = useState<number | null>(null);
  const editorRef = useRef<JsonEditorHandle>(null);

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

  // Load the config list on mount so the entry is discoverable immediately.
  useEffect(() => {
    loadConfigList();
  }, [loadConfigList]);

  // Auto-expire success toasts so a "set active" confirmation doesn't linger
  // stale after the user has moved on (e.g. switched config + restarted).
  useEffect(() => {
    if (configMsg?.type !== "ok") return;
    const id = setTimeout(() => setConfigMsg(null), 3000);
    return () => clearTimeout(id);
  }, [configMsg]);

  const activateIfFirst = useCallback(async (name: string): Promise<boolean> => {
    try {
      const list = await invoke<ConfigEntry[]>("list_configs");
      if (!list.some((c) => c.active)) {
        await invoke("set_active_config", { name });
        return true;
      }
    } catch {
      /* noop */
    }
    return false;
  }, []);

  const handleSaveConfig = async () => {
    if (!editingName) return;
    setConfigSaving(true);
    try {
      await invoke("save_config", { name: editingName, content: configText });
      setConfigDirty(false);
      const activated = await activateIfFirst(editingName);
      await loadConfigList();
      setConfigMsg({
        type: "ok",
        text: activated ? t("dashboard.savedActiveMsg") : t("dashboard.savedMsg"),
      });
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
    setConfigSaving(false);
  };

  const handleCheckFormat = async () => {
    if (!editingName) return;
    setChecking(true);
    setConfigMsg(null);
    setErrorLine(null);
    try {
      const res = await invoke<CheckResult>("check_and_format_config", { content: configText });
      if (res.ok) {
        if (res.content !== configText) {
          setConfigText(res.content);
          setConfigDirty(true);
        }
        setConfigMsg({ type: "ok", text: t("dashboard.checkOk") });
      } else {
        setConfigMsg({ type: "err", text: res.message });
        setErrorLine(parseErrorLine(res.message));
      }
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
    setChecking(false);
  };

  const handleSetActive = async (name: string) => {
    try {
      await invoke("set_active_config", { name });
      await loadConfigList();
      setConfigMsg({ type: "ok", text: t("dashboard.activeMsg", { name }) });
      // A config switch only takes effect after a core restart. Offer it when
      // the core is running; if stopped, the new active config applies on start.
      if (running) setShowRestart(true);
    } catch (e) {
      setConfigMsg({ type: "err", text: String(e) });
    }
  };

  const handleConfirmRestart = async () => {
    setShowRestart(false);
    setConfigMsg({ type: "ok", text: t("config.restarting") });
    await restartCore();
  };

  const startCreate = () => { setEditingName(null); setCreating(true); setNewName(""); };

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
      setConfigMsg({ type: "err", text: t("dashboard.cannotDeleteActive") });
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

  // Duplicate a config: copy its contents into a fresh "<name>-copy[-N]" file.
  const handleDuplicate = async (name: string) => {
    try {
      const content = await invoke<string>("get_config", { name });
      const taken = new Set(configs.map((c) => c.name));
      let candidate = `${name}-copy`;
      let i = 2;
      while (taken.has(candidate)) candidate = `${name}-copy-${i++}`;
      await invoke("save_config", { name: candidate, content });
      await loadConfigList();
      // No "copied" toast — the duplicate appears in the list immediately; a
      // transient toast here only shifted the layout (round-9 H).
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
        setConfigMsg({ type: "err", text: t("dashboard.invalidJson") });
        return;
      }
      const baseName = file.name.replace(/\.json$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_") || "imported";
      try {
        await invoke("save_config", { name: baseName, content: text });
        const activated = await activateIfFirst(baseName);
        await loadConfigList();
        openEditor(baseName);
        setConfigMsg({
          type: "ok",
          text: activated
            ? t("dashboard.importedActiveMsg", { name: baseName })
            : t("dashboard.importedMsg", { name: baseName }),
        });
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
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 16, height: "100%" }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
          {t("dashboard.configuration")}
        </h1>
        {editingName === null && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button className="fluent-btn accent reveal-target" onClick={startCreate} style={{ fontSize: 13 }}>
              <AddRegular style={{ fontSize: 16 }} />
              {t("dashboard.new")}
            </button>
            <button className="fluent-btn reveal-target" onClick={handleImportFile} style={{ fontSize: 13 }}>
              <ArrowImportRegular style={{ fontSize: 16 }} />
              {t("dashboard.import")}
            </button>
          </div>
        )}
      </div>

      {/* Floating overlay — never sits in the page flow, so showing/clearing it
          can't resize the list or editor (round-9 H). Still click-to-jump for
          validation errors. */}
      {configMsg && (
        <div
          onClick={errorLine != null ? () => editorRef.current?.jumpToLine(errorLine) : undefined}
          title={errorLine != null ? t("config.jumpToError", { line: errorLine }) : undefined}
          style={{
            position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)",
            zIndex: 2000, maxWidth: "min(80vw, 640px)", padding: "8px 16px",
            borderRadius: "var(--radius-md)", whiteSpace: "pre-wrap",
            background: configMsg.type === "err" ? "var(--status-danger-bg)" : "var(--status-success-bg)",
            border: `1px solid ${configMsg.type === "err" ? "var(--status-danger)" : "var(--status-success)"}`,
            color: "var(--text-primary)", fontSize: 13,
            boxShadow: "0 4px 16px rgba(0,0,0,0.22)",
            cursor: errorLine != null ? "pointer" : "default",
          }}
        >
          {configMsg.text}
          {errorLine != null && (
            <span style={{ marginLeft: 8, fontWeight: 600, opacity: 0.85 }}>→ {t("config.jumpToError", { line: errorLine })}</span>
          )}
        </div>
      )}

      {editingName !== null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              className="fluent-btn reveal-target"
              onClick={handleBackToList}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 10px" }}
            >
              <ArrowLeftRegular style={{ fontSize: 14 }} />
              {t("common.back")}
            </button>
            <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
              {editingName}
            </span>
            {isEditingActive && (
              <span style={{ fontSize: 11, color: "var(--accent-default)", fontWeight: 600 }}>
                ✦ {t("dashboard.active")}
              </span>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {!isEditingActive && (
              <button className="fluent-btn accent reveal-target" onClick={() => handleSetActive(editingName)} style={{ fontSize: 13 }}>
                <CheckmarkCircleRegular style={{ fontSize: 16 }} />
                {t("dashboard.setActive")}
              </button>
            )}
            <button className="fluent-btn reveal-target" onClick={() => openEditor(editingName)} style={{ fontSize: 13 }}>
              {t("common.reload")}
            </button>
            <button
              className="fluent-btn reveal-target"
              onClick={handleCheckFormat}
              disabled={checking}
              style={{ fontSize: 13 }}
            >
              {checking ? <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <DocumentCheckmarkRegular style={{ fontSize: 16 }} />}
              {t("dashboard.checkFormat")}
            </button>
            <button
              className="fluent-btn reveal-target"
              onClick={() => { setRenamingName(editingName); setRenameInput(editingName); }}
              style={{ fontSize: 13 }}
            >
              <EditRegular style={{ fontSize: 16 }} />
              {t("common.rename")}
            </button>
            <button
              className={`fluent-btn reveal-target ${wrap ? "accent" : ""}`}
              onClick={() => setWrap((w) => !w)}
              title={t("config.wrap")}
              aria-label={t("config.wrap")}
              style={{ fontSize: 13 }}
            >
              <TextWrapRegular style={{ fontSize: 16 }} />
            </button>
            {!isEditingActive && (
              <button className="fluent-btn reveal-target" onClick={() => handleDelete(editingName)} style={{ fontSize: 13, color: "var(--status-danger)" }}>
                <DeleteRegular style={{ fontSize: 16 }} />
                {t("common.delete")}
              </button>
            )}
            <button
              className="fluent-btn accent reveal-target"
              onClick={handleSaveConfig}
              disabled={!configDirty || configSaving}
              style={{ fontSize: 13, marginLeft: "auto" }}
            >
              {configSaving ? <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <SaveRegular style={{ fontSize: 16 }} />}
              {t("common.save")}
            </button>
          </div>

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
                {t("common.confirm")}
              </button>
              <button className="fluent-btn reveal-target" onClick={() => setRenamingName(null)} style={{ fontSize: 12, minHeight: 30, padding: "4px 10px" }}>
                {t("common.cancel")}
              </button>
            </div>
          )}

          <JsonEditor
            ref={editorRef}
            value={configText}
            onChange={(v) => { setConfigText(v); setConfigDirty(true); setConfigMsg(null); setErrorLine(null); }}
            onSave={handleSaveConfig}
            wrap={wrap}
          />

          <div style={{ fontSize: 11, color: "var(--text-tertiary)", flexShrink: 0 }}>
            {t("dashboard.editorHint")}
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {creating && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); if (e.key === "Escape") setCreating(false); }}
                placeholder={t("dashboard.configName")}
                style={{
                  border: "1px solid var(--border-default)", borderRadius: "var(--radius-sm)",
                  padding: "4px 10px", fontSize: 13, background: "var(--bg-surface)",
                  color: "var(--text-primary)", outline: "none", width: 200, height: 30, fontFamily: "inherit",
                }}
              />
              <button className="fluent-btn accent reveal-target" onClick={handleCreate} style={{ fontSize: 12, minHeight: 30, padding: "4px 10px" }}>{t("common.create")}</button>
              <button className="fluent-btn reveal-target" onClick={() => setCreating(false)} style={{ fontSize: 12, minHeight: 30, padding: "4px 10px" }}>{t("common.cancel")}</button>
            </div>
          )}

          {configs.length === 0 ? (
            <div style={{ textAlign: "center", padding: "28px 0", color: "var(--text-tertiary)", fontSize: 13 }}>
              {t("dashboard.noConfigs")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {configs.map((c) => (
                <div
                  key={c.name}
                  style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "12px 16px", borderRadius: "var(--radius-sm)",
                    border: c.active ? "1px solid var(--accent-default)" : "1px solid var(--border-card)",
                    background: c.active ? "var(--bg-selected)" : "var(--bg-card)",
                    cursor: "pointer", transition: "background 0.1s",
                  }}
                  onClick={() => { if (!c.active) handleSetActive(c.name); }}
                  title={c.active ? undefined : t("dashboard.setActive")}
                  onMouseEnter={(e) => { if (!c.active) e.currentTarget.style.background = "var(--bg-card-hover)"; }}
                  onMouseLeave={(e) => { if (!c.active) e.currentTarget.style.background = "var(--bg-card)"; }}
                >
                  <DocumentRegular style={{ fontSize: 16, color: "var(--text-secondary)", flexShrink: 0 }} />
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
                        <button className="fluent-btn accent" onClick={(e) => { e.stopPropagation(); handleRename(c.name); }} style={{ fontSize: 11, minHeight: 24, padding: "2px 8px" }}>{t("common.confirm")}</button>
                        <button className="fluent-btn" onClick={(e) => { e.stopPropagation(); setRenamingName(null); }} title={t("common.cancel")} aria-label={t("common.cancel")} style={{ fontSize: 11, minHeight: 24, padding: "2px 8px" }}>✕</button>
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
                      {t("dashboard.active")}
                    </span>
                  )}
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    <button
                      className="fluent-btn reveal-target"
                      onClick={() => openEditor(c.name)}
                      style={{ fontSize: 11, minHeight: 30, minWidth: 34, padding: "5px 8px" }}
                      title={t("config.editConfig")}
                    >
                      <EditRegular style={{ fontSize: 13 }} />
                    </button>
                    <button
                      className="fluent-btn reveal-target"
                      onClick={() => handleDuplicate(c.name)}
                      style={{ fontSize: 11, minHeight: 30, minWidth: 34, padding: "5px 8px" }}
                      title={t("config.duplicate")}
                    >
                      <CopyRegular style={{ fontSize: 13 }} />
                    </button>
                    <button
                      className="fluent-btn reveal-target"
                      onClick={() => { setRenamingName(c.name); setRenameInput(c.name); }}
                      style={{ fontSize: 11, minHeight: 30, minWidth: 34, padding: "5px 8px" }}
                      title={t("common.rename")}
                    >
                      <RenameRegular style={{ fontSize: 13 }} />
                    </button>
                    {!c.active && (
                      <button
                        className="fluent-btn reveal-target"
                        onClick={() => handleDelete(c.name)}
                        style={{ fontSize: 11, minHeight: 30, minWidth: 34, padding: "5px 8px", color: "var(--status-danger)" }}
                        title={t("common.delete")}
                      >
                        <DeleteRegular style={{ fontSize: 13 }} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Restart-to-apply confirm: shown after activating a config while the
          core is running (a switch only takes effect on restart). */}
      {showRestart && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="fluent-card" style={{ width: 360, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("config.restartTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {t("config.restartBody")}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button className="fluent-btn reveal-target" onClick={() => setShowRestart(false)} style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}>
                {t("config.restartLater")}
              </button>
              <button className="fluent-btn accent reveal-target" onClick={handleConfirmRestart} style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}>
                {t("config.restartNow")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
