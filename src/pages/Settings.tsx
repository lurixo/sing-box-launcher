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
  FolderOpenRegular,
  DeleteRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { ACCENT_PRESETS } from "../lib/colorEngine";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useReveal } from "../hooks/useReveal";
import { useT, type TranslationKey, type Lang } from "../i18n/strings";
import type {
  Theme, AppSettings, CoreInfo, CoreUpdateCheck, StagedKernel, KernelSource,
  AppInfo, AppUpdateCheck, StagedApp,
} from "../types";

const KERNEL_SOURCES: { id: KernelSource; label: string }[] = [
  { id: "lurixo", label: "lurixo" },
  { id: "sagernet", label: "SagerNet" },
  { id: "ref1nd", label: "reF1nd" },
];

function sourceLabel(s: string): string {
  return s === "sagernet" ? "SagerNet" : s === "ref1nd" ? "reF1nd" : "lurixo";
}

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
      className="reveal-target"
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

  // ─── Window behavior ─────────────────────────────────────────────
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [closeToTray, setCloseToTray] = useState(true);
  const [exitCoreOnClose, setExitCoreOnClose] = useState(true);
  const [autoStartCore, setAutoStartCore] = useState(true);
  const [startupDelay, setStartupDelay] = useState(30);

  // ─── UWP state ───────────────────────────────────────────────────
  const [uwpLoading, setUwpLoading] = useState(false);
  const [uwpResult, setUwpResult] = useState<{ ok: boolean; text: string } | null>(null);

  // ─── Core state ──────────────────────────────────────────────────
  const [coreInfo, setCoreInfo] = useState<CoreInfo | null>(null);
  const [coreCheck, setCoreCheck] = useState<CoreUpdateCheck | null>(null);
  const [coreBusy, setCoreBusy] = useState(false);
  const [cacheBusy, setCacheBusy] = useState(false);
  const [kernelSource, setKernelSource] = useState<KernelSource>("lurixo");
  // A staged-but-not-applied download; presence opens the restart-confirm modal.
  const [staged, setStaged] = useState<StagedKernel | null>(null);
  const [coreMsg, setCoreMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);

  // ─── App self-update state ───────────────────────────────────────
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appCheck, setAppCheck] = useState<AppUpdateCheck | null>(null);
  const [appBusy, setAppBusy] = useState(false);
  const [stagedApp, setStagedApp] = useState<StagedApp | null>(null);
  const [appMsg, setAppMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);

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
        setAllowMultiple(settings.allow_multiple);
        setCloseToTray(settings.close_to_tray);
        setExitCoreOnClose(settings.exit_core_on_close);
        setAutoStartCore(settings.auto_start_core);
        setStartupDelay(settings.startup_delay_secs);
        setKernelSource(settings.kernel_source);
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

  const handleAllowMultiple = async (val: boolean) => {
    try {
      await invoke("set_allow_multiple", { enabled: val });
      setAllowMultiple(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  const handleCloseToTray = async (val: boolean) => {
    try {
      await invoke("set_close_to_tray", { enabled: val });
      setCloseToTray(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  const handleExitCoreOnClose = async (val: boolean) => {
    try {
      await invoke("set_exit_core_on_close", { enabled: val });
      setExitCoreOnClose(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  const handleAutoStartCore = async (val: boolean) => {
    try {
      await invoke("set_auto_start_core", { enabled: val });
      setAutoStartCore(val);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  const handleStartupDelay = async (val: number) => {
    const secs = Math.max(0, Math.min(3600, Math.floor(val) || 0));
    setStartupDelay(secs);
    try {
      await invoke("set_startup_delay", { secs });
    } catch (e) {
      setGenErr(String(e));
    }
  };

  // Load version + core info, listen for update progress
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
    loadCoreInfo();
    invoke<AppInfo>("get_app_info").then(setAppInfo).catch(() => {});
    // Re-open the restart prompts for downloads staged in a prior session.
    invoke<StagedKernel | null>("get_staged_kernel")
      .then((s) => { if (s) setStaged(s); })
      .catch(() => {});
    invoke<StagedApp | null>("get_staged_app_update")
      .then((s) => { if (s) setStagedApp(s); })
      .catch(() => {});
    const unCore = listen<{ stage: string; message: string }>("core-update-progress", (e) => {
      setCoreMsg({ type: e.payload.stage === "done" ? "ok" : "info", text: e.payload.message });
    });
    const unApp = listen<{ stage: string; message: string }>("app-update-progress", (e) => {
      setAppMsg({ type: e.payload.stage === "done" ? "ok" : "info", text: e.payload.message });
    });
    return () => { unCore.then((f) => f()); unApp.then((f) => f()); };
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

  const handleSetSource = async (src: KernelSource) => {
    if (src === kernelSource) return;
    try {
      await invoke("set_kernel_source", { source: src });
      setKernelSource(src);
      // A check against the old source no longer applies.
      setCoreCheck(null);
      setCoreMsg(null);
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
          ? { type: "info", text: t("settings.updateAvailable", { version: c.latest_version }) }
          : { type: "ok", text: t("settings.upToDate") }
      );
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  // Download stages the new core next to the live one (the core may keep
  // running); we then prompt the user to confirm the restart before applying.
  const handleDownload = async () => {
    setCoreBusy(true);
    setCoreMsg(null);
    try {
      const s = await invoke<StagedKernel>("download_kernel");
      setStaged(s);
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  const handleApplyStaged = async () => {
    const s = staged;
    if (!s) return;
    setStaged(null);
    setCoreBusy(true);
    setCoreMsg({ type: "info", text: t("settings.applying") });
    try {
      await invoke("apply_staged_kernel");
      setCoreMsg({ type: "ok", text: t("settings.kernelApplied", { version: s.version }) });
      setCoreCheck(null);
      await loadCoreInfo();
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  const handleCancelStaged = async () => {
    setStaged(null);
    try {
      await invoke("discard_staged_kernel");
    } catch {
      /* noop */
    }
    setCoreMsg({ type: "info", text: t("settings.downloadCanceled") });
  };

  const handleClearCache = async () => {
    setCacheBusy(true);
    setCoreMsg(null);
    try {
      const n = await invoke<number>("clear_kernel_cache");
      setCoreMsg({ type: "ok", text: t("settings.cacheCleared", { count: n }) });
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCacheBusy(false);
  };

  // ─── App self-update (Maestro itself, separate from the kernel) ──────
  const handleCheckApp = async () => {
    setAppBusy(true);
    setAppMsg(null);
    try {
      const c = await invoke<AppUpdateCheck>("check_app_update");
      setAppCheck(c);
      setAppMsg(
        c.update_available
          ? { type: "info", text: t("settings.appUpdateAvailable", { version: c.latest_version }) }
          : { type: "ok", text: t("settings.appUpToDate") }
      );
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
    setAppBusy(false);
  };

  const handleDownloadApp = async () => {
    setAppBusy(true);
    setAppMsg(null);
    try {
      const s = await invoke<StagedApp>("download_app_update");
      setStagedApp(s);
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
    setAppBusy(false);
  };

  // Installed (NSIS) builds update by downloading a fresh installer, not by the
  // portable in-place self-swap (which would desync the install). Send the user
  // to the releases page instead.
  const handleOpenReleases = async () => {
    try {
      await invoke("open_releases_page");
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
  };

  // Confirm → swap exe + relaunch. The app exits as part of this call, so there
  // is nothing to await meaningfully; we just fire it.
  const handleApplyApp = async () => {
    setStagedApp(null);
    setAppMsg({ type: "info", text: t("settings.appUpdateApplied") });
    try {
      await invoke("apply_app_update");
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
  };

  const handleCancelApp = async () => {
    setStagedApp(null);
    try {
      await invoke("discard_app_update");
    } catch {
      /* noop */
    }
    setAppMsg({ type: "info", text: t("settings.downloadCanceled") });
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

        {/* Allow multiple instances */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.allowMultiple")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{t("settings.allowMultipleDesc")}</div>
          </div>
          <ToggleSwitch checked={allowMultiple} onChange={handleAllowMultiple} />
        </div>

        {/* Close to tray */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.closeToTray")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{t("settings.closeToTrayDesc")}</div>
          </div>
          <ToggleSwitch checked={closeToTray} onChange={handleCloseToTray} />
        </div>

        {/* Exit core when closing (below close-to-tray) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.exitCoreOnClose")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{t("settings.exitCoreOnCloseDesc")}</div>
          </div>
          <ToggleSwitch checked={exitCoreOnClose} onChange={handleExitCoreOnClose} />
        </div>

        {/* Start core on launch */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.autoStartCore")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{t("settings.autoStartCoreDesc")}</div>
          </div>
          <ToggleSwitch checked={autoStartCore} onChange={handleAutoStartCore} />
        </div>

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

        {/* Startup delay - only when autostart is ON (below autostart) */}
        {autostart && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.startupDelay")}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{t("settings.startupDelayDesc")}</div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="number"
                min={0}
                max={3600}
                value={startupDelay}
                onChange={(e) => handleStartupDelay(Number(e.target.value))}
                style={{ width: 72, textAlign: "right", fontSize: 13, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-default)", background: "var(--bg-card)", color: "var(--text-primary)", fontFamily: "inherit" }}
              />
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t("settings.seconds")}</span>
            </div>
          </div>
        )}

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
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{t("settings.logs")}</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
          {t("settings.logStorageDesc")}
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

        {/* Kernel source */}
        <div className="section-label" style={{ marginBottom: 8 }}>{t("settings.kernelSource")}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {KERNEL_SOURCES.map((s) => (
            <button
              key={s.id}
              className={`fluent-btn reveal-target ${kernelSource === s.id ? "accent" : ""}`}
              onClick={() => handleSetSource(s.id)}
              style={{ flex: 1, padding: "8px" }}
            >
              <span style={{ fontSize: 13 }}>{s.label}</span>
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "8px 0 6px" }}>
          {t("settings.kernelSourceDesc")}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.singboxCore")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {coreInfo?.present
                ? coreInfo.version
                  ? `${sourceLabel(coreInfo.source)} ${coreInfo.version}`
                  : t("settings.coreInstalledUnknown")
                : t("settings.coreNotInstalled")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="fluent-btn reveal-target"
              onClick={() => invoke("open_core_location")}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              <FolderOpenRegular style={{ fontSize: 14 }} />
              {t("settings.openCoreLocation")}
            </button>
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
            {(coreCheck?.update_available ||
              !coreInfo?.present ||
              (coreInfo?.present && coreInfo.source !== kernelSource)) && (
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleDownload}
                disabled={coreBusy}
                style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
              >
                {coreBusy ? (
                  <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
                ) : (
                  <ArrowDownloadRegular style={{ fontSize: 14 }} />
                )}
                {coreInfo?.present ? t("settings.update") : t("settings.download")}
              </button>
            )}
          </div>
        </div>

        {/* Clear cache */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.clearCache")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {t("settings.clearCacheDesc")}
            </div>
          </div>
          <button
            className="fluent-btn reveal-target"
            onClick={handleClearCache}
            disabled={cacheBusy || status.running}
            title={status.running ? t("settings.clearCacheRunning") : undefined}
            style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
          >
            {cacheBusy ? (
              <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
            ) : (
              <DeleteRegular style={{ fontSize: 14 }} />
            )}
            {t("settings.clearCache")}
          </button>
        </div>

        {status.running && (
          <div style={{ fontSize: 11, color: "var(--text-tertiary)", marginTop: 2 }}>
            {t("settings.clearCacheRunning")}
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

        {/* Application self-update (separate from the kernel update above) */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0 4px", marginTop: 10, borderTop: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{t("settings.appUpdate")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {appInfo?.built_at ? t("settings.appBuilt", { date: appInfo.built_at }) : t("settings.appUpdateDesc")}
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              className="fluent-btn reveal-target"
              onClick={handleCheckApp}
              disabled={appBusy}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              {appBusy ? (
                <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
              ) : (
                <ArrowSyncRegular style={{ fontSize: 14 }} />
              )}
              {t("settings.check")}
            </button>
            {appCheck?.update_available && appCheck.installed && (
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleOpenReleases}
                style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
                title={t("settings.appUpdateInstalledHint")}
              >
                <ArrowDownloadRegular style={{ fontSize: 14 }} />
                {t("settings.appUpdateOpenReleases")}
              </button>
            )}
            {appCheck?.update_available && !appCheck.installed && (
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleDownloadApp}
                disabled={appBusy}
                style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
              >
                <ArrowDownloadRegular style={{ fontSize: 14 }} />
                {t("settings.update")}
              </button>
            )}
          </div>
        </div>

        {appMsg && (
          <div
            className="infobar"
            style={{
              marginTop: 10,
              background:
                appMsg.type === "err"
                  ? "var(--status-danger-bg)"
                  : appMsg.type === "ok"
                  ? "var(--status-success-bg)"
                  : undefined,
              borderColor:
                appMsg.type === "err"
                  ? "var(--status-danger)"
                  : appMsg.type === "ok"
                  ? "var(--status-success)"
                  : undefined,
            }}
          >
            {appMsg.text}
          </div>
        )}
      </div>

      {/* Restart-confirm modal: shown after a download stages a new core, before
          it is applied. Confirm swaps + restarts the core; cancel discards it. */}
      {staged && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="fluent-card" style={{ width: 360, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("settings.applyKernelTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {t("settings.applyKernelBody", { version: `${sourceLabel(staged.source)} ${staged.version}` })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                className="fluent-btn reveal-target"
                onClick={handleCancelStaged}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.applyKernelCancel")}
              </button>
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleApplyStaged}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.applyKernelConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* App self-update restart-confirm modal: confirm swaps Maestro's own exe
          and relaunches; cancel discards the staged download. Gated behind the
          kernel modal so the two can't stack and trap the user when both are
          staged — the kernel one is handled first. */}
      {stagedApp && !staged && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1001,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="fluent-card" style={{ width: 360, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("settings.appUpdateApplyTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {t("settings.appUpdateApplyBody", { version: stagedApp.version })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                className="fluent-btn reveal-target"
                onClick={handleCancelApp}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.applyKernelCancel")}
              </button>
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleApplyApp}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.appUpdateApplyConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
