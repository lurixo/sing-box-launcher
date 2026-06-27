use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::info;

use crate::error::AppError;

fn default_active_config() -> String {
    "default".into()
}

fn default_true() -> bool {
    true
}

fn default_log_level() -> String {
    "info".into()
}

fn default_lang() -> String {
    "zh-CN".into()
}

fn default_kernel_source() -> String {
    "lurixo".into()
}

fn default_kernel_channel() -> String {
    "stable".into()
}

fn default_startup_delay() -> u32 {
    30
}

/// Allowed sing-box log levels, lowest to highest verbosity.
pub const LOG_LEVELS: [&str; 5] = ["trace", "debug", "info", "warn", "error"];

/// Allowed UI languages (kept in sync with the frontend dictionaries).
pub const LANGS: [&str; 2] = ["en", "zh-CN"];

/// Allowed kernel download sources (kept in sync with core_update::KernelSource).
pub const KERNEL_SOURCES: [&str; 3] = ["lurixo", "sagernet", "ref1nd"];

/// Allowed kernel release channels (kept in sync with core_update::KernelChannel).
pub const KERNEL_CHANNELS: [&str; 2] = ["stable", "dev"];

/// Persistent application settings stored in settings.json
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub silent_start: bool,
    #[serde(default = "default_active_config")]
    pub active_config: String,
    #[serde(default = "default_true")]
    pub run_as_admin: bool,
    #[serde(default = "default_log_level")]
    pub log_level: String,
    #[serde(default = "default_lang")]
    pub lang: String,
    /// Allow more than one instance to run at once. Default: single instance.
    #[serde(default)]
    pub allow_multiple: bool,
    /// Closing the window minimizes to tray instead of quitting. Default: on.
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    /// Start the core automatically when the app launches. Default: off.
    #[serde(default)]
    pub auto_start_core: bool,
    /// Stop the core when the app actually exits (not on minimize-to-tray). Default: on.
    #[serde(default = "default_true")]
    pub exit_core_on_close: bool,
    /// Seconds to delay the whole app on an autostart (boot) launch. Default: 30.
    #[serde(default = "default_startup_delay")]
    pub startup_delay_secs: u32,
    /// Pass --disable-gpu-compositing to WebView2 (renderer-crash backstop).
    /// Dormant by default; flip on only if the WebView2 crash recurs.
    #[serde(default)]
    pub disable_gpu_compositing: bool,
    /// Where to download the sing-box core from: "lurixo" (bundled default),
    /// "sagernet" or "ref1nd". Drives the update-check + download logic.
    #[serde(default = "default_kernel_source")]
    pub kernel_source: String,
    /// Release channel for the GitHub kernel sources: "stable" (newest release)
    /// or "dev" (highest pre-release). Ignored by lurixo (single pipeline).
    #[serde(default = "default_kernel_channel")]
    pub kernel_channel: String,
    /// Show the Dashboard's outbound-IP card. Default OFF: the card has the core
    /// query a third-party geo-IP service through the proxy, so it is opt-in. Only
    /// meaningful on a lurixo kernel (OutboundTrace is lurixo-specific); the UI
    /// greys the toggle and the backend gates the query on a non-lurixo kernel.
    #[serde(default)]
    pub outbound_ip_card: bool,
    /// Per-config remembered system-proxy choice (config name -> on/off). A config
    /// whose inbounds ask for the system proxy turns it on by default on its FIRST
    /// launch; once the user toggles it in the GUI, that choice is stored here and
    /// wins on every later start of that config (config intent = first-time only).
    #[serde(default)]
    pub proxy_overrides: HashMap<String, bool>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            silent_start: false,
            active_config: "default".into(),
            run_as_admin: true,
            log_level: default_log_level(),
            lang: default_lang(),
            allow_multiple: false,
            close_to_tray: true,
            auto_start_core: false,
            exit_core_on_close: true,
            startup_delay_secs: default_startup_delay(),
            disable_gpu_compositing: false,
            kernel_source: default_kernel_source(),
            kernel_channel: default_kernel_channel(),
            outbound_ip_card: false,
            proxy_overrides: HashMap::new(),
        }
    }
}

fn settings_path(base_dir: &Path) -> PathBuf {
    base_dir.join("settings.json")
}

/// Load settings from disk, returning defaults if file doesn't exist
pub fn load_settings(base_dir: &Path) -> AppSettings {
    let path = settings_path(base_dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            tracing::warn!(error = %e, "settings.json invalid; using defaults");
            AppSettings::default()
        }),
        Err(_) => AppSettings::default(),
    }
}

/// Save settings to disk
pub fn save_settings(base_dir: &Path, settings: &AppSettings) -> Result<(), AppError> {
    let path = settings_path(base_dir);
    let raw = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::Config(format!("serialize settings: {e}")))?;
    std::fs::write(&path, raw)
        .map_err(|e| AppError::Config(format!("write settings: {e}")))?;
    info!("settings saved");
    Ok(())
}

// ─── IPC Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<AppSettings, AppError> {
    let mgr = mgr.lock().await;
    Ok(load_settings(&mgr.base_dir))
}

#[tauri::command]
pub async fn set_silent_start(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.silent_start = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_run_as_admin(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.run_as_admin = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_log_level(
    mgr: tauri::State<'_, crate::manager::Manager>,
    level: String,
) -> Result<(), AppError> {
    if !LOG_LEVELS.contains(&level.as_str()) {
        return Err(AppError::Config(format!("invalid log level: {level}")));
    }
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.log_level = level;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_allow_multiple(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.allow_multiple = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_close_to_tray(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.close_to_tray = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_auto_start_core(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.auto_start_core = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_exit_core_on_close(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.exit_core_on_close = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_startup_delay(
    mgr: tauri::State<'_, crate::manager::Manager>,
    secs: u32,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.startup_delay_secs = secs.min(3600);
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_disable_gpu_compositing(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.disable_gpu_compositing = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_kernel_source(
    mgr: tauri::State<'_, crate::manager::Manager>,
    source: String,
) -> Result<(), AppError> {
    if !KERNEL_SOURCES.contains(&source.as_str()) {
        return Err(AppError::Config(format!("invalid kernel source: {source}")));
    }
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.kernel_source = source;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_outbound_ip_card(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.outbound_ip_card = enabled;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_kernel_channel(
    mgr: tauri::State<'_, crate::manager::Manager>,
    channel: String,
) -> Result<(), AppError> {
    if !KERNEL_CHANNELS.contains(&channel.as_str()) {
        return Err(AppError::Config(format!("invalid kernel channel: {channel}")));
    }
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.kernel_channel = channel;
    save_settings(&mgr.base_dir, &settings)
}

#[tauri::command]
pub async fn set_lang(
    mgr: tauri::State<'_, crate::manager::Manager>,
    app: tauri::AppHandle,
    lang: String,
) -> Result<(), AppError> {
    if !LANGS.contains(&lang.as_str()) {
        return Err(AppError::Config(format!("invalid lang: {lang}")));
    }
    {
        let mgr = mgr.lock().await;
        let mut settings = load_settings(&mgr.base_dir);
        settings.lang = lang.clone();
        save_settings(&mgr.base_dir, &settings)?;
    }
    // Re-label the tray menu live so it follows the in-app language.
    crate::tray::rebuild_tray_menu(&app, &lang);
    Ok(())
}

#[tauri::command]
pub async fn set_active_config(
    mgr: tauri::State<'_, crate::manager::Manager>,
    name: String,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let path = crate::config::config_path(&mgr.base_dir, &name)?;
    if !path.exists() {
        return Err(AppError::Config(format!("config '{name}' not found")));
    }
    let mut settings = load_settings(&mgr.base_dir);
    settings.active_config = name;
    save_settings(&mgr.base_dir, &settings)
}
