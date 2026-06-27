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
  ArrowUndoRegular,
  FolderOpenRegular,
  DeleteRegular,
  TagRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { ACCENT_PRESETS } from "../lib/colorEngine";
import { formatBytes } from "../lib/format";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useReveal } from "../hooks/useReveal";
import { useT, type TranslationKey, type Lang } from "../i18n/strings";
import type {
  Theme, AppSettings, CoreInfo, CoreUpdateCheck, StagedKernel, KernelSource, KernelChannel,
  AppInfo, AppUpdateCheck, StagedApp, RollbackTarget, AppRollback,
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
  const [outboundIpCard, setOutboundIpCard] = useState(false);
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
  const [kernelChannel, setKernelChannel] = useState<KernelChannel>("stable");
  // A staged-but-not-applied download. `showApplyModal` controls the restart
  // prompt; when a download is staged but the modal is dismissed, the kernel
  // stays on disk (this session) and a "pending" banner offers apply/discard.
  const [staged, setStaged] = useState<StagedKernel | null>(null);
  const [showApplyModal, setShowApplyModal] = useState(false);
  // Post-check "found vX, download it?" confirmation (download is never automatic).
  const [downloadPrompt, setDownloadPrompt] = useState<{ version: string } | null>(null);
  // Toggles the installed build's release tag inline.
  const [showTag, setShowTag] = useState(false);
  // Live byte progress of an in-flight core download (for the progress bar).
  const [dlProgress, setDlProgress] = useState<{ received: number; total: number | null } | null>(null);
  const [coreMsg, setCoreMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);
  // The retained previous kernel a rollback would restore (null = none kept).
  const [kernelRollback, setKernelRollback] = useState<RollbackTarget | null>(null);
  const [showKernelRollbackModal, setShowKernelRollbackModal] = useState(false);

  // ─── App self-update state ───────────────────────────────────────
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appCheck, setAppCheck] = useState<AppUpdateCheck | null>(null);
  const [appBusy, setAppBusy] = useState(false);
  const [stagedApp, setStagedApp] = useState<StagedApp | null>(null);
  // Whether the staged app download is an INSTALLER (run setup.exe in place) vs
  // a portable exe swap — drives apply wording + which apply command runs, so the
  // apply modal no longer depends on a prior check's `appCheck.installed`.
  const [stagedIsInstaller, setStagedIsInstaller] = useState(false);
  const [appMsg, setAppMsg] = useState<{ type: "ok" | "err" | "info"; text: string } | null>(null);
  // Live byte progress of an in-flight installer download (installed builds).
  const [appDlProgress, setAppDlProgress] = useState<{ received: number; total: number | null } | null>(null);
  // The previous app version a rollback would restore (null = none available).
  const [appRollback, setAppRollback] = useState<AppRollback | null>(null);
  const [showAppRollbackModal, setShowAppRollbackModal] = useState(false);

  const loadCoreInfo = useCallback(async () => {
    try {
      setCoreInfo(await invoke<CoreInfo>("get_core_info"));
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
  }, []);

  // Refresh both rollback targets (kernel + app). Called on mount and after any
  // update/rollback so the offered "roll back to vX" reflects what's retained.
  const loadRollback = useCallback(async () => {
    invoke<RollbackTarget | null>("get_kernel_rollback").then(setKernelRollback).catch(() => {});
    invoke<AppRollback | null>("get_app_rollback").then(setAppRollback).catch(() => {});
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
        setOutboundIpCard(settings.outbound_ip_card);
        setStartupDelay(settings.startup_delay_secs);
        setKernelSource(settings.kernel_source);
        setKernelChannel(settings.kernel_channel);
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

  const handleOutboundIpCard = async (val: boolean) => {
    try {
      await invoke("set_outbound_ip_card", { enabled: val });
      setOutboundIpCard(val);
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
    // Re-open the restart prompt for a download staged earlier this session.
    invoke<StagedKernel | null>("get_staged_kernel")
      .then((s) => { if (s) { setStaged(s); setShowApplyModal(true); } })
      .catch(() => {});
    invoke<StagedApp | null>("get_staged_app_update")
      .then((s) => { if (s) setStagedApp(s); })
      .catch(() => {});
    loadRollback();
    const unCore = listen<{ stage: string; message: string; received?: number; total?: number | null }>(
      "core-update-progress",
      (e) => {
        const p = e.payload;
        if (p.stage === "downloading" && typeof p.received === "number") {
          // The progress bar renders the bytes; skip the raw English stage text.
          setDlProgress({ received: p.received, total: p.total ?? null });
          return;
        }
        setDlProgress(null);
        setCoreMsg({ type: p.stage === "done" ? "ok" : "info", text: p.message });
      },
    );
    const unApp = listen<{ stage: string; message: string; received?: number; total?: number | null }>(
      "app-update-progress",
      (e) => {
        const p = e.payload;
        if (p.stage === "downloading" && typeof p.received === "number") {
          setAppDlProgress({ received: p.received, total: p.total ?? null });
          return;
        }
        setAppDlProgress(null);
        setAppMsg({ type: p.stage === "done" ? "ok" : "info", text: p.message });
      },
    );
    return () => { unCore.then((f) => f()); unApp.then((f) => f()); };
  }, [loadCoreInfo, loadRollback]);

  // Transient core notices (canceled / pending / up-to-date / applied) clear
  // themselves so they don't pile up next to the persistent controls; errors
  // stay until the next action.
  useEffect(() => {
    if (!coreMsg || coreMsg.type === "err") return;
    const id = setTimeout(() => setCoreMsg(null), 4000);
    return () => clearTimeout(id);
  }, [coreMsg]);

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

  const handleSetChannel = async (ch: KernelChannel) => {
    if (ch === kernelChannel) return;
    try {
      await invoke("set_kernel_channel", { channel: ch });
      setKernelChannel(ch);
      // A check against the old channel no longer applies.
      setCoreCheck(null);
      setCoreMsg(null);
    } catch (e) {
      setGenErr(String(e));
    }
  };

  // A check never downloads on its own: when an update is found, ask first.
  const handleCheckCore = async () => {
    setCoreBusy(true);
    setCoreMsg(null);
    try {
      const c = await invoke<CoreUpdateCheck>("check_core_update");
      setCoreCheck(c);
      if (c.update_available) {
        setDownloadPrompt({ version: c.latest_version });
      } else {
        setCoreMsg({ type: "ok", text: t("settings.upToDate") });
      }
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  // Download stages the new core next to the live one (the core may keep
  // running); we then prompt the user to apply it (or keep it for later).
  const handleDownload = async () => {
    setDownloadPrompt(null);
    setCoreBusy(true);
    setCoreMsg(null);
    setDlProgress(null);
    try {
      const s = await invoke<StagedKernel>("download_kernel");
      setStaged(s);
      setShowApplyModal(true);
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setDlProgress(null);
    setCoreBusy(false);
  };

  const handleApplyStaged = async () => {
    const s = staged;
    if (!s) return;
    setShowApplyModal(false);
    setStaged(null);
    setCoreBusy(true);
    setCoreMsg({ type: "info", text: t("settings.applying") });
    try {
      await invoke("apply_staged_kernel");
      setCoreMsg({ type: "ok", text: t("settings.kernelApplied", { version: s.version }) });
      setCoreCheck(null);
      await loadCoreInfo();
      await loadRollback();
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  // Roll the kernel back to the retained previous version (offered, not forced):
  // stops the core, swaps the backup in, relaunches if it had been running.
  const handleRollbackKernel = async () => {
    setShowKernelRollbackModal(false);
    setCoreBusy(true);
    setCoreMsg({ type: "info", text: t("settings.applying") });
    try {
      await invoke("rollback_kernel");
      setCoreCheck(null);
      await loadCoreInfo();
      await loadRollback();
      setCoreMsg({ type: "ok", text: t("settings.kernelRolledBack") });
    } catch (e) {
      setCoreMsg({ type: "err", text: String(e) });
    }
    setCoreBusy(false);
  };

  // "Apply later": close the prompt WITHOUT discarding or restarting. The staged
  // core stays on disk for this session; a pending banner offers apply/discard.
  const handleDeferStaged = () => {
    setShowApplyModal(false);
    if (staged) {
      setCoreMsg({
        type: "info",
        text: t("settings.kernelPending", { version: `${sourceLabel(staged.source)} ${staged.version}` }),
      });
    }
  };

  // Explicit discard of the staged download (the only path that deletes it).
  const handleDiscardStaged = async () => {
    setShowApplyModal(false);
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
      setStagedIsInstaller(false);
      setStagedApp(s);
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
    setAppBusy(false);
  };

  // Installed (NSIS) builds update by downloading + running a fresh setup.exe
  // (NSIS upgrades in place, keeping the uninstall registration), NOT the
  // portable in-place exe swap. Download+verify the installer, then prompt.
  const handleDownloadInstaller = async () => {
    setAppBusy(true);
    setAppMsg(null);
    setAppDlProgress(null);
    try {
      const s = await invoke<StagedApp>("download_installer_update");
      setStagedIsInstaller(true);
      setStagedApp(s);
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
    setAppDlProgress(null);
    setAppBusy(false);
  };

  // Fallback for installed builds: open the releases page in the browser.
  const handleOpenReleases = async () => {
    try {
      await invoke("open_releases_page");
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
  };

  // Confirm → for the portable build, swap exe + relaunch; for an installed
  // build, run the staged installer in passive mode. Either way the app exits as
  // part of this call (the new version is brought back up), so we just fire it.
  const handleApplyApp = async () => {
    const installed = stagedIsInstaller;
    setStagedApp(null);
    setAppMsg({
      type: "info",
      text: installed ? t("settings.appUpdateInstalling") : t("settings.appUpdateApplied"),
    });
    try {
      await invoke(installed ? "apply_installer_update" : "apply_app_update");
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

  // Start an app rollback to the previous version. Installed builds re-download
  // the previous release's verified setup.exe (then the apply modal runs it in
  // place); portable builds swap the retained `.prev` exe after a confirm.
  const handleStartAppRollback = async () => {
    if (!appRollback) return;
    if (!appRollback.installed) {
      setShowAppRollbackModal(true);
      return;
    }
    setAppBusy(true);
    setAppMsg(null);
    setAppDlProgress(null);
    try {
      const s = await invoke<StagedApp>("download_installer_rollback");
      setStagedIsInstaller(true);
      setStagedApp(s);
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
    setAppDlProgress(null);
    setAppBusy(false);
  };

  // Portable rollback confirmed: swap the retained `.prev` exe back in and
  // relaunch. The app exits as part of this call, so we just fire it.
  const handleRollbackAppPortable = async () => {
    setShowAppRollbackModal(false);
    setAppMsg({ type: "info", text: t("settings.appRollingBack") });
    try {
      await invoke("rollback_app");
    } catch (e) {
      setAppMsg({ type: "err", text: String(e) });
    }
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

  // The stable/dev channel only exists for the GitHub sources (lurixo is a
  // single pipeline). When the installed kernel's track (source or, for those
  // sources, channel) differs from what's selected, "check" is meaningless
  // (cross-track version comparison) → grey it and steer the user to download.
  const channelApplies = kernelSource !== "lurixo";
  const installedChannel = coreInfo?.channel ? coreInfo.channel : "stable";
  const trackMismatch =
    !!coreInfo?.present &&
    (coreInfo.source !== kernelSource ||
      (channelApplies && installedChannel !== kernelChannel));

  const copyBuildTag = () => {
    const tag = coreInfo?.tag;
    if (!tag) return;
    navigator.clipboard?.writeText(tag)
      .then(() => setCoreMsg({ type: "ok", text: t("settings.buildTagCopied") }))
      .catch(() => {});
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

        {/* Outbound-IP card. Off by default — the card has the core query a
            third-party geo-IP service through the proxy. Greyed + forced off on a
            non-lurixo kernel (OutboundTrace is lurixo-specific). */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.outboundIpCard")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{t("settings.outboundIpCardDesc")}</div>
          </div>
          <ToggleSwitch
            checked={coreInfo?.source === "lurixo" && outboundIpCard}
            onChange={handleOutboundIpCard}
            disabled={coreInfo?.source !== "lurixo"}
          />
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

        {/* Channel (stable / dev) — only the GitHub sources have one; lurixo is
            a single pre-release pipeline so the selector is hidden for it. */}
        {channelApplies && (
          <>
            <div className="section-label" style={{ marginTop: 6, marginBottom: 8 }}>{t("settings.kernelChannel")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              {(["stable", "dev"] as KernelChannel[]).map((ch) => (
                <button
                  key={ch}
                  className={`fluent-btn reveal-target ${kernelChannel === ch ? "accent" : ""}`}
                  onClick={() => handleSetChannel(ch)}
                  style={{ flex: 1, padding: "8px" }}
                >
                  <span style={{ fontSize: 13 }}>{ch === "stable" ? t("settings.channelStable") : t("settings.channelDev")}</span>
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", margin: "8px 0 6px" }}>
              {t("settings.channelDesc")}
            </div>
          </>
        )}

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderTop: "1px solid var(--border-divider)", gap: 8, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.singboxCore")}</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              {coreInfo?.present
                ? coreInfo.version
                  ? `${sourceLabel(coreInfo.source)}${coreInfo.channel ? ` · ${coreInfo.channel}` : ""} ${coreInfo.version}`
                  : t("settings.coreInstalledUnknown")
                : t("settings.coreNotInstalled")}
            </div>
            {showTag && (
              <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 4, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span>{t("settings.viewBuildTag")}:</span>
                {coreInfo?.tag ? (
                  <code
                    onClick={copyBuildTag}
                    title={t("settings.buildTagCopied")}
                    style={{ cursor: "pointer", userSelect: "text", WebkitUserSelect: "text", color: "var(--text-secondary)" }}
                  >
                    {coreInfo.tag}
                  </code>
                ) : (
                  <span>{t("settings.buildTagNone")}</span>
                )}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              className="fluent-btn reveal-target"
              onClick={() => invoke("open_core_location")}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              <FolderOpenRegular style={{ fontSize: 14 }} />
              {t("settings.openCoreLocation")}
            </button>
            <button
              className={`fluent-btn reveal-target ${showTag ? "accent" : ""}`}
              onClick={() => setShowTag((v) => !v)}
              disabled={!coreInfo?.present}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              <TagRegular style={{ fontSize: 14 }} />
              {t("settings.viewBuildTag")}
            </button>
            <button
              className="fluent-btn reveal-target"
              onClick={handleCheckCore}
              disabled={coreBusy || trackMismatch}
              title={trackMismatch ? t("settings.checkMismatchHint") : undefined}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              {coreBusy ? (
                <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
              ) : (
                <ArrowSyncRegular style={{ fontSize: 14 }} />
              )}
              {t("settings.check")}
            </button>
            {(trackMismatch || coreCheck?.update_available || !coreInfo?.present) && (
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
                {t("settings.download")}
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

        {/* Roll back to the retained previous kernel (offered, not forced). */}
        {kernelRollback && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderTop: "1px solid var(--border-divider)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{t("settings.kernelRollback")}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                {t("settings.kernelRollbackDesc", { version: `${sourceLabel(kernelRollback.source)} ${kernelRollback.version}` })}
              </div>
            </div>
            <button
              className="fluent-btn reveal-target"
              onClick={() => setShowKernelRollbackModal(true)}
              disabled={coreBusy}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              <ArrowUndoRegular style={{ fontSize: 14 }} />
              {t("settings.rollback")}
            </button>
          </div>
        )}

        {/* Live download progress bar (byte counts streamed from the backend). */}
        {dlProgress && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
              <span>
                {dlProgress.total
                  ? t("settings.downloadingPct", { pct: Math.floor((dlProgress.received / dlProgress.total) * 100) })
                  : t("settings.downloading")}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatBytes(dlProgress.received)}{dlProgress.total ? ` / ${formatBytes(dlProgress.total)}` : ""}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--bg-subtle)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: dlProgress.total ? `${Math.min(100, (dlProgress.received / dlProgress.total) * 100)}%` : "100%",
                  background: "var(--accent-default)",
                  transition: "width 0.15s linear",
                }}
              />
            </div>
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

        {/* Pending staged kernel: a download kept after "apply later"/dismiss
            stays on disk (this session) — offer to apply it (re-open the prompt)
            or discard it explicitly. */}
        {staged && !showApplyModal && (
          <div className="infobar" style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ flex: 1, minWidth: 160 }}>
              {t("settings.kernelPending", { version: `${sourceLabel(staged.source)} ${staged.version}` })}
            </span>
            <button
              className="fluent-btn accent reveal-target"
              onClick={() => setShowApplyModal(true)}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              {t("settings.applyKernelApply")}
            </button>
            <button
              className="fluent-btn reveal-target"
              onClick={handleDiscardStaged}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              {t("settings.kernelDiscard")}
            </button>
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
              <>
                <button
                  className="fluent-btn reveal-target"
                  onClick={handleOpenReleases}
                  style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
                  title={t("settings.appUpdateInstalledHint")}
                >
                  <GlobeRegular style={{ fontSize: 14 }} />
                  {t("settings.appUpdateOpenReleasesFallback")}
                </button>
                <button
                  className="fluent-btn accent reveal-target"
                  onClick={handleDownloadInstaller}
                  disabled={appBusy}
                  style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
                >
                  {appBusy ? (
                    <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  ) : (
                    <ArrowDownloadRegular style={{ fontSize: 14 }} />
                  )}
                  {t("settings.appInstallUpdate")}
                </button>
              </>
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

        {/* Live installer/app download progress bar (byte counts from backend). */}
        {appDlProgress && (
          <div style={{ marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>
              <span>
                {appDlProgress.total
                  ? t("settings.downloadingPct", { pct: Math.floor((appDlProgress.received / appDlProgress.total) * 100) })
                  : t("settings.downloading")}
              </span>
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatBytes(appDlProgress.received)}{appDlProgress.total ? ` / ${formatBytes(appDlProgress.total)}` : ""}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 3, background: "var(--bg-subtle)", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: appDlProgress.total ? `${Math.min(100, (appDlProgress.received / appDlProgress.total) * 100)}%` : "100%",
                  background: "var(--accent-default)",
                  transition: "width 0.15s linear",
                }}
              />
            </div>
          </div>
        )}

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

        {/* Roll Maestro back to the previous version (offered, not forced).
            Installed builds re-download the previous setup.exe; portable builds
            swap the retained `.prev` exe. */}
        {appRollback && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0 4px", marginTop: 6, borderTop: "1px solid var(--border-divider)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)" }}>{t("settings.appRollback")}</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                {t("settings.appRollbackDesc", { version: appRollback.version })}
              </div>
            </div>
            <button
              className="fluent-btn reveal-target"
              onClick={handleStartAppRollback}
              disabled={appBusy}
              style={{ fontSize: 12, minHeight: 28, padding: "4px 12px" }}
            >
              {appBusy ? (
                <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
              ) : (
                <ArrowUndoRegular style={{ fontSize: 14 }} />
              )}
              {t("settings.rollback")}
            </button>
          </div>
        )}
      </div>

      {/* Download-confirm: a check that finds an update asks before downloading
          (the download is never automatic). */}
      {downloadPrompt && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="fluent-card" style={{ width: 360, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("settings.downloadPromptTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {t("settings.downloadPromptBody", { version: downloadPrompt.version })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                className="fluent-btn reveal-target"
                onClick={() => setDownloadPrompt(null)}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.applyKernelCancel")}
              </button>
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleDownload}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.downloadConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Apply-confirm modal: shown after a download stages a new core. Three
          exits — discard the download, keep it for later (no restart), or apply
          now (a running core restarts; a stopped one just swaps in place). */}
      {staged && showApplyModal && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="fluent-card" style={{ width: 380, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("settings.applyKernelTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {t("settings.applyKernelBody", { version: `${sourceLabel(staged.source)} ${staged.version}` })}
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 4 }}>
              <button
                className="fluent-btn reveal-target"
                onClick={handleDiscardStaged}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 14px", color: "var(--status-danger)" }}
              >
                {t("settings.kernelDiscard")}
              </button>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  className="fluent-btn reveal-target"
                  onClick={handleDeferStaged}
                  style={{ fontSize: 13, minHeight: 32, padding: "4px 14px" }}
                >
                  {t("settings.applyKernelLater")}
                </button>
                <button
                  className="fluent-btn accent reveal-target"
                  onClick={handleApplyStaged}
                  style={{ fontSize: 13, minHeight: 32, padding: "4px 14px" }}
                >
                  {t("settings.applyKernelConfirm")}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* App self-update restart-confirm modal: confirm swaps Maestro's own exe
          and relaunches; cancel discards the staged download. Gated behind the
          kernel apply modal so the two can't stack and trap the user when both
          are open — the kernel one is handled first. */}
      {stagedApp && !(staged && showApplyModal) && (
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
              {stagedIsInstaller
                ? t("settings.appUpdateApplyInstallerBody", { version: stagedApp.version })
                : t("settings.appUpdateApplyBody", { version: stagedApp.version })}
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
                {stagedIsInstaller
                  ? t("settings.appUpdateApplyInstallerConfirm")
                  : t("settings.appUpdateApplyConfirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Kernel rollback confirm: swaps the retained previous core back in and
          restarts the core if it had been running (offered, never forced). */}
      {showKernelRollbackModal && kernelRollback && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1001,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="fluent-card" style={{ width: 380, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("settings.kernelRollbackTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {t("settings.kernelRollbackBody", { version: `${sourceLabel(kernelRollback.source)} ${kernelRollback.version}` })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                className="fluent-btn reveal-target"
                onClick={() => setShowKernelRollbackModal(false)}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.applyKernelCancel")}
              </button>
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleRollbackKernel}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.rollback")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Portable app rollback confirm: swaps the retained previous exe back in
          and relaunches Maestro. Installed builds use the staged-installer modal
          instead (re-download + run setup.exe), so this is portable-only. */}
      {showAppRollbackModal && appRollback && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1001,
            background: "rgba(0,0,0,0.45)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="fluent-card" style={{ width: 360, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)" }}>
              {t("settings.appRollbackTitle")}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5 }}>
              {t("settings.appRollbackBody", { version: appRollback.version })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                className="fluent-btn reveal-target"
                onClick={() => setShowAppRollbackModal(false)}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.applyKernelCancel")}
              </button>
              <button
                className="fluent-btn accent reveal-target"
                onClick={handleRollbackAppPortable}
                style={{ fontSize: 13, minHeight: 32, padding: "4px 16px" }}
              >
                {t("settings.rollback")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
