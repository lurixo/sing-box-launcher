import { useState, useEffect, useCallback } from "react";
import {
  WeatherSunnyRegular,
  WeatherMoonRegular,
  DesktopRegular,
  ColorRegular,
  GlobeRegular,
  BoxRegular,
  ArrowSyncRegular,
  ArrowDownloadRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { ACCENT_PRESETS } from "../lib/colorEngine";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useReveal } from "../hooks/useReveal";
import { useT, type TranslationKey, type Lang } from "../i18n/strings";
import type { Theme, AppSettings, CoreInfo, CoreUpdateCheck, CoreBuildInfo } from "../types";

const themes: { id: Theme; icon: React.ReactNode; key: TranslationKey }[] = [
  { id: "light", icon: <WeatherSunnyRegular />, key: "settings.themeLight" },
  { id: "dark", icon: <WeatherMoonRegular />, key: "settings.themeDark" },
  { id: "system", icon: <DesktopRegular />, key: "settings.themeSystem" },
];

const langs: { id: Lang; label: string }[] = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en", label: "English" },
];

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        border: "none",
        background: checked ? "var(--accent-default)" : "var(--border-default)",
        cursor: disabled ? "not-allowed" : "pointer",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

export function Settings() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const accentColor = useAppStore((s) => s.accentColor);
  const setAccentColor = useAppStore((s) => s.setAccentColor);
  const accentSource = useAppStore((s) => s.accentSource);
  const setAccentSource = useAppStore((s) => s.setAccentSource);
  const lang = useAppStore((s) => s.lang);
  const setLang = useAppStore((s) => s.setLang);
  const t = useT();
  const revealRef = useReveal<HTMLDivElement>();

  const status = useAppStore((s) => s.status);

  const [customInput, setCustomInput] = useState(accentColor);
  const [appVersion, setAppVersion] = useState("");
  const [genErr, setGenErr] = useState<string | null>(null);

  // ─── Autostart state ─────────────────────────────────────────────
  const [autostart, setAutostart] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);

  // ─── Elevation state ─────────────────────────────────────────────
  const [runAsAdmin, setRunAsAdmin] = useState(true);
  const [elevated, setElevated] = useState(true);

  // ─── Log state ───────────────────────────────────────────────────
  const [logPersist, setLogPersist] = useState(false);

  // ─── UWP state ───────────────────────────────────────────────────
  const [uwpLoading, setUwpLoading] = useState(false);
  const [uwpResult, setUwpResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ─── Core state ──────────────────────────────────────────────────
  const [coreInfo, setCoreInfo] = useState<CoreInfo | null>(null);
  const [coreCheck, setCoreCheck] = useState<CoreUpdateCheck | null>(null);
  const [coreBusy, setCoreBusy] = useState(false);
  const [coreMsg, setCoreMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);

  const loadCoreInfo = useCallback(async () => {
    try {
      setCoreInfo(await invoke<CoreInfo>("get_core_info"));
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
  }, []);

  // Load autostart + settings on mount
  useEffect(() => {
    (async () => {
      try {
        const enabled = await isEnabled();
        setAutostart(enabled);
        const settings = await invoke<AppSettings>("get_settings");
        setSilentStart(settings.silent_start);
        setRunAsAdmin(settings.run_as_admin);
        setLogPersist(settings.log_persist);
        setElevated(await invoke<boolean>("is_admin"));
      } catch (e) {
        setGenErr(String(e));
      }
      setAutostartLoading(false);
    })();
  }, []);

  const handleRunAsAdminToggle = async (val: boolean) => {
    try {
      await invoke("set_run_as_admin", { enabled: val });
      setRunAsAdmin(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  const handleLogPersist = async (val: boolean) => {
    try {
      await invoke("set_log_persist", { enabled: val });
      setLogPersist(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  // Load version + core info, listen for update progress
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    loadCoreInfo();
    const un = listen<{ stage: string; message: string }>("core-update-progress", (e) => {
      setCoreMsg({ type: e.payload.stage === "done" ? "ok" : "info", text: e.payload.message });
    });
    return () => { un.then((f) => f()); };
  }, [loadCoreInfo]);

  const handleAutostartToggle = async (val: boolean) => {
    try {
      if (val) {
        await enable();
      } else {
        await disable();
        // Also disable silent start when autostart is off
        setSilentStart(false);
        await invoke("set_silent_start", { enabled: false });
      }
      setAutostart(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  const handleSilentToggle = async (val: boolean) => {
    try {
      await invoke("set_silent_start", { enabled: val });
      setSilentStart(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  const handleCheckCore = async () => {
    setCoreBusy(true);
    setCoreMsg(null);
    try {
      const c = await invoke<CoreUpdateCheck>("check_core_update");
      setCoreCheck(c);
      setCoreMsg(
        c.update_available
          ? { type: "info", text: t("settings.updateAvailable", { version: c.latest.version }) }
          : { type: "ok", text: t("settings.upToDate") }
      );
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  const handleUpdateCore = async () => {
    setCoreBusy(true);
    setCoreMsg(null);
    try {
      const info = await invoke<CoreBuildInfo>("update_core");
      setCoreMsg({ type: "ok", text: t("settings.coreUpdated", { version: info.version }) });
      setCoreCheck(null);
      await loadCoreInfo();
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  const handleUwpLoopback = async () => {
    setUwpLoading(true);
    setUwpResult(null);
    try {
      const result = await invoke<string>("enable_uwp_loopback");
      setUwpResult({ ok: true, text: result });
    } catch (e) {
      setUwpResult({ ok: false, text: String(e) });
    }
    setUwpLoading(false);
  };

  const handleCustomAccent = () => {
    const hex = customInput.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      setAccentColor(hex);
    }
  };

  return (
    <div
      ref={revealRef}
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
        {t("settings.title")}
      </h1>

      {genErr && (
        <div className="infobar error">
          <span style={{ flex: 1 }}>{genErr}</span>
          <button
            className="fluent-btn reveal-target"
            onClick={() => setGenErr(null)}
            style={{ padding: "2px 8px", minHeight: 24, fontSize: 12 }}
          >
            {t("common.dismiss")}
          </button>
        </div>
      )}

      {/* ─── General ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>{t("settings.general")}</div>

        {/* Run as administrator */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.runAsAdmin")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("settings.runAsAdminDesc")}
            </div>
          </div>
          <ToggleSwitch checked={runAsAdmin} onChange={handleRunAsAdminToggle} />
        </div>

        {runAsAdmin && !elevated && (
          <div className="infobar" style={{ marginTop: 4, marginBottom: 4, background: "var(--status-warning-bg)", borderColor: "var(--status-warning)" }}>
            {t("settings.notElevated")}
          </div>
        )}

        {/* Autostart */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.launchAtStartup")}</div>
          </div>
          {autostartLoading ? (
            <span className="progress-ring" style={{ width: 20, height: 20, borderWidth: 2 }} />
          ) : (
            <ToggleSwitch checked={autostart} onChange={handleAutostartToggle} />
          )}
        </div>

        {/* Silent Start - only visible when autostart is ON */}
        {autostart && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.silentStart")}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                {t("settings.silentStartDesc")}
              </div>
            </div>
            <ToggleSwitch checked={silentStart} onChange={handleSilentToggle} />
          </div>
        )}

        {/* UWP Loopback */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.uwpLoopback")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("settings.uwpLoopbackDesc")}
            </div>
          </div>
          <button
            className="fluent-btn reveal-target"
            onClick={handleUwpLoopback}
            disabled={uwpLoading}
            style={{ fontSize: 12, minHeight: 28, padding: "4px 14px" }}
          >
            {uwpLoading ? (
              <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
            ) : (
              <GlobeRegular style={{ fontSize: 14 }} />
            )}
            {t("settings.openTool")}
          </button>
        </div>

        {uwpResult && (
          <div
            className="infobar"
            style={{
              marginTop: 4,
              background: uwpResult.ok ? "var(--status-success-bg)" : "var(--status-danger-bg)",
              borderColor: uwpResult.ok ? "var(--status-success)" : "var(--status-danger)",
            }}
          >
            {uwpResult.text}
          </div>
        )}
      </div>

      {/* ─── Logs ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>{t("settings.logs")}</div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.logPersist")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("settings.logPersistDesc")}
            </div>
          </div>
          <ToggleSwitch checked={logPersist} onChange={handleLogPersist} />
        </div>
      </div>

      {/* ─── Appearance ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{t("settings.appearance")}</div>
        <div className="section-label" style={{ marginBottom: 10 }}>{t("settings.theme")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {themes.map((th) => (
            <button
              key={th.id}
              className={`fluent-btn reveal-target ${theme === th.id ? "accent" : ""}`}
              onClick={() => setTheme(th.id)}
              style={{ flex: 1, flexDirection: "column", gap: 4, padding: "10px 8px" }}
            >
              <span style={{ fontSize: 18, display: "flex" }}>{th.icon}</span>
              <span style={{ fontSize: 12 }}>{t(th.key)}</span>
            </button>
          ))}
        </div>

        <div className="section-label" style={{ marginTop: 16, marginBottom: 10 }}>{t("settings.language")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {langs.map((l) => (
            <button
              key={l.id}
              className={`fluent-btn reveal-target ${lang === l.id ? "accent" : ""}`}
              onClick={() => setLang(l.id)}
              style={{ flex: 1, padding: "8px" }}
            >
              <span style={{ fontSize: 13 }}>{l.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ─── Accent Color ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          <ColorRegular style={{ fontSize: 18 }} />
          {t("settings.accentColor")}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, padding: "8px 0" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.followSystemAccent")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("settings.followSystemAccentDesc")}
            </div>
          </div>
          <ToggleSwitch
            checked={accentSource === "system"}
            onChange={(v) => setAccentSource(v ? "system" : "manual")}
          />
        </div>

        {accentSource === "manual" && (
          <>
            <div className="section-label" style={{ marginBottom: 10 }}>{t("settings.presets")}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.hex}
                  className={`accent-swatch ${accentColor.toLowerCase() === preset.hex.toLowerCase() ? "active" : ""}`}
                  style={{ background: preset.hex }}
                  onClick={() => setAccentColor(preset.hex)}
                  aria-label={t("settings.accentColorSwatch", { name: preset.label })}
                  title={preset.label}
                />
              ))}
            </div>

            <div className="section-label" style={{ marginBottom: 8 }}>{t("settings.custom")}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div
                style={{
                  width: 32, height: 32, borderRadius: "var(--radius-sm)",
                  background: accentColor, border: "1px solid var(--border-default)", flexShrink: 0,
                }}
              />
              <div
                style={{
                  display: "flex", alignItems: "center", flex: 1,
                  background: "var(--bg-card)", border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-sm)", overflow: "hidden",
                }}
              >
                <input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCustomAccent()}
                  placeholder="#0078D4"
                  maxLength={7}
                  style={{
                    border: "none", background: "transparent", outline: "none",
                    color: "var(--text-primary)", fontSize: 13, flex: 1,
                    padding: "6px 10px", fontFamily: "monospace",
                  }}
                />
                <button
                  className="fluent-btn accent"
                  onClick={handleCustomAccent}
                  style={{ borderRadius: 0, minHeight: 30, fontSize: 12, padding: "4px 12px", border: "none" }}
                >
                  {t("settings.apply")}
                </button>
              </div>
            </div>
          </>
        )}

        {/* Accent scale preview */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>{t("settings.accentScale")}</div>
          <div style={{ display: "flex", borderRadius: "var(--radius-sm)", overflow: "hidden", height: 28 }}>
            {[
              "var(--accent-dark-3)", "var(--accent-dark-2)", "var(--accent-dark-1)",
              "var(--accent-default)",
              "var(--accent-light-1)", "var(--accent-light-2)", "var(--accent-light-3)",
            ].map((cssVar, i) => (
              <div key={i} style={{ flex: 1, background: cssVar }} />
            ))}
          </div>
        </div>
      </div>

      {/* ─── Core ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          <BoxRegular style={{ fontSize: 18 }} />
          {t("settings.core")}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.singboxCore")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {coreInfo?.present
                ? coreInfo.build
                  ? t("settings.coreVersion", { version: coreInfo.build.version })
                  : t("settings.coreInstalledUnknown")
                : t("settings.coreNotInstalled")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="fluent-btn reveal-target"
              onClick={handleCheckCore}
              disabled={coreBusy}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              {coreBusy ? (
                <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
              ) : (
                <ArrowSyncRegular style={{ fontSize: 14 }} />
              )}
              {t("settings.check")}
            </button>
            {(coreCheck?.update_available || !coreInfo?.present) && (
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleUpdateCore}
                disabled={coreBusy || status.running}
                title={status.running ? t("settings.stopToUpdate") : undefined}
                style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
              >
                <ArrowDownloadRegular style={{ fontSize: 14 }} />
                {coreInfo?.present ? t("settings.update") : t("settings.download")}
              </button>
            )}
          </div>
        </div>

        {status.running && (coreCheck?.update_available || !coreInfo?.present) && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
            {t("settings.stopToUpdate")}
          </div>
        )}

        {coreMsg && (
          <div
            className="infobar"
            style={{
              marginTop: 10,
              background:
                coreMsg.type === "err"
                  ? "var(--status-danger-bg)"
                  : coreMsg.type === "ok"
                  ? "var(--status-success-bg)"
                  : undefined,
              borderColor:
                coreMsg.type === "err"
                  ? "var(--status-danger)"
                  : coreMsg.type === "ok"
                  ? "var(--status-success)"
                  : undefined,
            }}
          >
            {coreMsg.text}
          </div>
        )}
      </div>

      {/* ─── About ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{t("settings.about")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
          <div>
            <strong style={{ color: "var(--text-primary)" }}>Maestro</strong>
            {appVersion ? ` v${appVersion}` : ""}
          </div>
          <div>{t("settings.aboutDesc")}</div>
          <div style={{ marginTop: 4 }}>{t("settings.builtWith")}</div>
        </div>
      </div>
    </div>
  );
}
