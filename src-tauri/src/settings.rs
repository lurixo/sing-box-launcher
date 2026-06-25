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

/// Allowed sing-box log levels, lowest to highest verbosity.
pub const LOG_LEVELS: [&str; 5] = ["trace", "debug", "info", "warn", "error"];

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
    #[serde(default)]
    pub log_persist: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            silent_start: false,
            active_config: "default".into(),
            run_as_admin: true,
            log_level: default_log_level(),
            log_persist: false,
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
pub async fn set_log_persist(
    mgr: tauri::State<'_, crate::manager::Manager>,
    enabled: bool,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let mut settings = load_settings(&mgr.base_dir);
    settings.log_persist = enabled;
    save_settings(&mgr.base_dir, &settings)
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
