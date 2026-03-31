use std::path::Path;

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

/// Read config.json, inject clash_api settings, write config_runtime.json.
/// Returns extracted connection info.
pub fn prepare_runtime_config(base_dir: &Path) -> Result<ConfigInfo, AppError> {
    let config_path = base_dir.join("config.json");
    let raw = std::fs::read_to_string(&config_path)
        .map_err(|e| AppError::Config(format!("read config.json: {e}")))?;

    let mut config: Value =
        serde_json::from_str(&raw).map_err(|e| AppError::Config(format!("parse config: {e}")))?;

    let (api_address, api_secret) = inject_clash_api(&mut config);
    let proxy_server = extract_proxy_server(&config);

    let runtime_path = base_dir.join("config_runtime.json");
    let runtime_raw = serde_json::to_string_pretty(&config)?;
    std::fs::write(&runtime_path, runtime_raw)
        .map_err(|e| AppError::Config(format!("write runtime config: {e}")))?;

    info!(
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

/// Ensure `experimental.clash_api.external_controller` exists.
/// Returns (address, secret).
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

    // Ensure cache_file for connection persistence
    let cache_file = experimental
        .entry("cache_file")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .unwrap();

    cache_file
        .entry("enabled")
        .or_insert(Value::Bool(true));
    cache_file
        .entry("path")
        .or_insert_with(|| Value::String("cache.db".into()));

    (addr, secret)
}

/// Find the first HTTP/SOCKS/mixed inbound → "host:port"
fn extract_proxy_server(config: &Value) -> String {
    let inbounds = match config.get("inbounds").and_then(|v| v.as_array()) {
        Some(arr) => arr,
        None => return String::new(),
    };

    struct Entry {
        host: String,
        port: u16,
    }

    let mut mixed: Option<Entry> = None;
    let mut http: Option<Entry> = None;
    let mut socks: Option<Entry> = None;

    for raw in inbounds {
        let ib = match raw.as_object() {
            Some(o) => o,
            None => continue,
        };

        let typ = ib.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let host = ib
            .get("listen")
            .and_then(|v| v.as_str())
            .unwrap_or("127.0.0.1")
            .to_string();
        let port = ib
            .get("listen_port")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u16;

        if port == 0 {
            continue;
        }

        let entry = Entry { host, port };
        match typ {
            "mixed" if mixed.is_none() => mixed = Some(entry),
            "http" if http.is_none() => http = Some(entry),
            "socks" if socks.is_none() => socks = Some(entry),
            _ => {}
        }
    }

    let pick = mixed.or(http).or(socks);
    match pick {
        Some(e) => {
            let h = if e.host == "0.0.0.0" || e.host == "::" {
                "127.0.0.1"
            } else {
                &e.host
            };
            format!("{h}:{}", e.port)
        }
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_inject_clash_api_default() {
        let mut config: Value = serde_json::from_str(r#"{"inbounds":[]}"#).unwrap();
        let (addr, secret) = inject_clash_api(&mut config);
        assert_eq!(addr, "127.0.0.1:9090");
        assert_eq!(secret, "");
    }

    #[test]
    fn test_extract_proxy_mixed() {
        let config: Value = serde_json::from_str(
            r#"{"inbounds":[{"type":"mixed","listen":"0.0.0.0","listen_port":2080}]}"#,
        )
        .unwrap();
        assert_eq!(extract_proxy_server(&config), "127.0.0.1:2080");
    }
}
