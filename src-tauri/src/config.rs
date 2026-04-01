use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use tracing::info;

use crate::error::AppError;

/// Information extracted after processing config.json
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfigInfo {
    pub proxy_server: String,
    pub api_address: String,
    pub api_secret: String,
}

/// Entry in the config list
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConfigEntry {
    pub name: String,
    pub active: bool,
}

// ─── Helpers ────────────────────────────────────────────────────────────────

fn configs_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("configs")
}

/// Ensure the `configs/` directory exists.
/// If a legacy `config.json` is present, migrate it to `configs/default.json`.
pub fn ensure_configs_dir(base_dir: &Path) {
    let dir = configs_dir(base_dir);
    let _ = std::fs::create_dir_all(&dir);

    let legacy = base_dir.join("config.json");
    let target = dir.join("default.json");
    if legacy.exists() && !target.exists() {
        if std::fs::rename(&legacy, &target).is_ok() {
            info!("migrated config.json -> configs/default.json");
        }
    }
}

/// Validate and resolve config file path.
fn config_path(base_dir: &Path, name: &str) -> Result<PathBuf, AppError> {
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(AppError::Config(format!("invalid config name: {name}")));
    }
    Ok(configs_dir(base_dir).join(format!("{name}.json")))
}

/// Read the active config, inject clash_api settings, write config_runtime.json.
pub fn prepare_runtime_config(base_dir: &Path, config_name: &str) -> Result<ConfigInfo, AppError> {
    let path = config_path(base_dir, config_name)?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| AppError::Config(format!("read {config_name}.json: {e}")))?;

    let mut config: Value =
        serde_json::from_str(&raw).map_err(|e| AppError::Config(format!("parse config: {e}")))?;

    let (api_address, api_secret) = inject_clash_api(&mut config);
    let proxy_server = extract_proxy_server(&config);

    let runtime_path = base_dir.join("config_runtime.json");
    let runtime_raw = serde_json::to_string_pretty(&config)?;
    std::fs::write(&runtime_path, runtime_raw)
        .map_err(|e| AppError::Config(format!("write runtime config: {e}")))?;

    info!(
        config_name = %config_name,
        proxy_server = %proxy_server,
        api_address = %api_address,
        "runtime config written"
    );

    Ok(ConfigInfo {
        proxy_server,
        api_address,
        api_secret,
    })
}

// ─── IPC Commands ───────────────────────────────────────────────────────────

/// List all config files in `configs/`
#[tauri::command]
pub async fn list_configs(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<Vec<ConfigEntry>, AppError> {
    let mgr = mgr.lock().await;
    ensure_configs_dir(&mgr.base_dir);
    let dir = configs_dir(&mgr.base_dir);
    let active = crate::settings::load_settings(&mgr.base_dir).active_config;

    let mut entries = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    entries.push(ConfigEntry {
                        name: stem.to_string(),
                        active: stem == active,
                    });
                }
            }
        }
    }
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Read a specific config file content.  Returns empty string if not found.
#[tauri::command]
pub async fn get_config(
    mgr: tauri::State<'_, crate::manager::Manager>,
    name: String,
) -> Result<String, AppError> {
    let mgr = mgr.lock().await;
    let path = config_path(&mgr.base_dir, &name)?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path)
        .map_err(|e| AppError::Config(format!("read {name}.json: {e}")))
}

/// Save content to a config file (validates JSON first)
#[tauri::command]
pub async fn save_config(
    mgr: tauri::State<'_, crate::manager::Manager>,
    name: String,
    content: String,
) -> Result<(), AppError> {
    let _: Value = serde_json::from_str(&content)
        .map_err(|e| AppError::Config(format!("invalid JSON: {e}")))?;

    let mgr = mgr.lock().await;
    ensure_configs_dir(&mgr.base_dir);
    let path = config_path(&mgr.base_dir, &name)?;
    std::fs::write(&path, &content)
        .map_err(|e| AppError::Config(format!("write {name}.json: {e}")))?;
    info!(name = %name, bytes = content.len(), "config saved");
    Ok(())
}

/// Create a new config with a minimal sing-box template
#[tauri::command]
pub async fn create_config(
    mgr: tauri::State<'_, crate::manager::Manager>,
    name: String,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    ensure_configs_dir(&mgr.base_dir);
    let path = config_path(&mgr.base_dir, &name)?;
    if path.exists() {
        return Err(AppError::Config(format!("config '{name}' already exists")));
    }
    let template = serde_json::json!({
        "log": { "level": "info" },
        "inbounds": [],
        "outbounds": [
            { "type": "direct", "tag": "direct" },
            { "type": "block",  "tag": "block"  },
            { "type": "dns",    "tag": "dns-out" }
        ],
        "route": { "rules": [] }
    });
    let content = serde_json::to_string_pretty(&template)?;
    std::fs::write(&path, &content)
        .map_err(|e| AppError::Config(format!("create {name}.json: {e}")))?;
    info!(name = %name, "new config created");
    Ok(())
}

/// Delete a config file.  The active config cannot be deleted.
#[tauri::command]
pub async fn delete_config(
    mgr: tauri::State<'_, crate::manager::Manager>,
    name: String,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let path = config_path(&mgr.base_dir, &name)?;
    if !path.exists() {
        return Err(AppError::Config(format!("config '{name}' not found")));
    }
    let settings = crate::settings::load_settings(&mgr.base_dir);
    if settings.active_config == name {
        return Err(AppError::Config("cannot delete the active config".into()));
    }
    std::fs::remove_file(&path)
        .map_err(|e| AppError::Config(format!("delete {name}.json: {e}")))?;
    info!(name = %name, "config deleted");
    Ok(())
}

// ─── Internal helpers ───────────────────────────────────────────────────────

/// Ensure `experimental.clash_api.external_controller` exists.
fn inject_clash_api(config: &mut Value) -> (String, String) {
    const DEFAULT_ADDR: &str = "127.0.0.1:9090";

    let obj = config.as_object_mut().expect("config must be an object");

    let experimental = obj
        .entry("experimental")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .unwrap();

    let clash_api = experimental
        .entry("clash_api")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .unwrap();

    let addr = match clash_api.get("external_controller").and_then(|v| v.as_str()) {
        Some(a) if !a.is_empty() => a.to_string(),
        _ => {
            clash_api.insert(
                "external_controller".into(),
                Value::String(DEFAULT_ADDR.into()),
            );
            DEFAULT_ADDR.to_string()
        }
    };

    let secret = clash_api
        .get("secret")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let cache_file = experimental
        .entry("cache_file")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .unwrap();

    cache_file.entry("enabled").or_insert(Value::Bool(true));
    cache_file
        .entry("path")
        .or_insert_with(|| Value::String("cache.db".into()));

    (addr, secret)
}

/// Find the first HTTP/SOCKS/mixed inbound -> "host:port"
fn extract_proxy_server(config: &Value) -> String {
    let inbounds = match config.get("inbounds").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return String::new(),
    };

    struct Entry { host: String, port: u16 }

    let mut mixed: Option<Entry> = None;
    let mut http: Option<Entry> = None;
    let mut socks: Option<Entry> = None;

    for raw in inbounds {
        let ib = match raw.as_object() { Some(o) => o, None => continue };
        let typ = ib.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let host = ib.get("listen").and_then(|v| v.as_str()).unwrap_or("127.0.0.1").to_string();
        let port = ib.get("listen_port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
        if port == 0 { continue; }
        let entry = Entry { host, port };
        match typ {
            "mixed" if mixed.is_none() => mixed = Some(entry),
            "http"  if http.is_none()  => http  = Some(entry),
            "socks" if socks.is_none() => socks = Some(entry),
            _ => {}
        }
    }

    match mixed.or(http).or(socks) {
        Some(e) => {
            let h = if e.host == "0.0.0.0" || e.host == "::" { "127.0.0.1" } else { &e.host };
            format!("{h}:{}", e.port)
        }
        None => String::new(),
    }
}
