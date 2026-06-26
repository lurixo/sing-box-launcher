use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};
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
pub fn config_path(base_dir: &Path, name: &str) -> Result<PathBuf, AppError> {
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

    let (api_address, api_secret) = inject_api(&mut config)?;
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
    std::fs::write(&path, MINIMAL_CONFIG)
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

/// Rename a config file.  Updates active_config in settings if necessary.
#[tauri::command]
pub async fn rename_config(
    mgr: tauri::State<'_, crate::manager::Manager>,
    old_name: String,
    new_name: String,
) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let old_path = config_path(&mgr.base_dir, &old_name)?;
    let new_path = config_path(&mgr.base_dir, &new_name)?;
    if !old_path.exists() {
        return Err(AppError::Config(format!("config '{old_name}' not found")));
    }
    if new_path.exists() {
        return Err(AppError::Config(format!("config '{new_name}' already exists")));
    }
    std::fs::rename(&old_path, &new_path)
        .map_err(|e| AppError::Config(format!("rename config: {e}")))?;

    // If renaming the active config, update settings
    let mut settings = crate::settings::load_settings(&mgr.base_dir);
    if settings.active_config == old_name {
        settings.active_config = new_name.clone();
        let _ = crate::settings::save_settings(&mgr.base_dir, &settings);
    }

    info!(old = %old_name, new = %new_name, "config renamed");
    Ok(())
}

// ─── Internal helpers ───────────────────────────────────────────────────────

const MINIMAL_CONFIG: &str = r#"{
  "log": {
    "level": "info"
  },
  "inbounds": [
    {
      "type": "mixed",
      "tag": "mixed-in",
      "listen": "127.0.0.1",
      "listen_port": 2080
    }
  ],
  "outbounds": [
    {
      "type": "direct",
      "tag": "direct"
    }
  ]
}
"#;

/// Ensure `key` in `parent` is an object, replacing any non-object value.
fn ensure_object<'a>(parent: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let slot = parent
        .entry(key)
        .or_insert_with(|| Value::Object(Map::new()));
    if !slot.is_object() {
        *slot = Value::Object(Map::new());
    }
    slot.as_object_mut().unwrap()
}

/// Ensure a sing-box native `api` service exists in `services[]` and that
/// `experimental.cache_file` is enabled (for selector persistence).
/// Returns the API `host:port` and secret to connect with.
fn inject_api(config: &mut Value) -> Result<(String, String), AppError> {
    const DEFAULT_HOST: &str = "127.0.0.1";
    const DEFAULT_PORT: u64 = 9090;

    let obj = config
        .as_object_mut()
        .ok_or_else(|| AppError::Config("config root must be a JSON object".into()))?;

    let experimental = ensure_object(obj, "experimental");
    let cache_file = ensure_object(experimental, "cache_file");
    cache_file.entry("enabled").or_insert(Value::Bool(true));
    cache_file
        .entry("path")
        .or_insert_with(|| Value::String("cache.db".into()));

    let services = obj
        .entry("services")
        .or_insert_with(|| Value::Array(Vec::new()));
    if !services.is_array() {
        *services = Value::Array(Vec::new());
    }
    let arr = services.as_array_mut().unwrap();

    if let Some(api) = arr
        .iter()
        .find(|s| s.get("type").and_then(|v| v.as_str()) == Some("api"))
    {
        let listen = api.get("listen").and_then(|v| v.as_str()).unwrap_or(DEFAULT_HOST);
        let port = api.get("listen_port").and_then(|v| v.as_u64()).unwrap_or(DEFAULT_PORT);
        let secret = api
            .get("secret")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let host = if listen == "0.0.0.0" || listen == "::" { DEFAULT_HOST } else { listen };
        return Ok((format!("{host}:{port}"), secret));
    }

    arr.push(json!({
        "type": "api",
        "tag": "sing-box-launcher",
        "listen": DEFAULT_HOST,
        "listen_port": DEFAULT_PORT,
    }));
    Ok((format!("{DEFAULT_HOST}:{DEFAULT_PORT}"), String::new()))
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
