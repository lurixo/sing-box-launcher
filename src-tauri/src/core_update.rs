use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tracing::info;

use crate::error::AppError;

const BUILD_INFO_URL: &str =
    "https://raw.githubusercontent.com/lurixo/sing-box-releases/dev/singbox-build-info.json";
const RELEASE_DOWNLOAD_BASE: &str = "https://github.com/lurixo/sing-box-releases/releases/download";
const BUILD_INFO_FILE: &str = "singbox-build-info.json";
const CORE_FILE: &str = "sing-box.exe";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BuildInfo {
    pub version: String,
    #[serde(default)]
    pub windows_asset: String,
    #[serde(default)]
    pub windows_sha256: String,
    #[serde(default)]
    pub built_at: String,
    #[serde(default)]
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoreInfo {
    pub present: bool,
    pub build: Option<BuildInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CoreUpdateCheck {
    pub current: Option<BuildInfo>,
    pub latest: BuildInfo,
    pub update_available: bool,
}

fn build_info_path(base_dir: &Path) -> PathBuf {
    base_dir.join(BUILD_INFO_FILE)
}

pub fn local_build_info(base_dir: &Path) -> Option<BuildInfo> {
    let raw = std::fs::read_to_string(build_info_path(base_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn run_id_num(info: &BuildInfo) -> Option<u64> {
    info.run_id.trim().parse().ok()
}

/// A build is newer when its run_id is larger (run_id increases monotonically
/// per release build), falling back to the build timestamp.
pub fn is_newer(remote: &BuildInfo, local: &BuildInfo) -> bool {
    match (run_id_num(remote), run_id_num(local)) {
        (Some(r), Some(l)) => r > l,
        _ => remote.built_at.as_str() > local.built_at.as_str(),
    }
}

fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("sing-box-launcher")
        .build()
        .unwrap_or_else(|_| Client::new())
}

async fn fetch_remote() -> Result<(BuildInfo, String), AppError> {
    let raw = http_client()
        .get(BUILD_INFO_URL)
        .send()
        .await
        .map_err(|e| AppError::Update(format!("fetch build info: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Update(format!("build info http: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Update(format!("read build info: {e}")))?;
    let info: BuildInfo =
        serde_json::from_str(&raw).map_err(|e| AppError::Update(format!("parse build info: {e}")))?;
    Ok((info, raw))
}

fn download_url(info: &BuildInfo) -> Result<String, AppError> {
    if info.windows_asset.is_empty() {
        return Err(AppError::Update("no windows asset in build info".into()));
    }
    Ok(format!(
        "{}/v{}/{}",
        RELEASE_DOWNLOAD_BASE, info.version, info.windows_asset
    ))
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn extract_core(zip_bytes: &[u8]) -> Result<Vec<u8>, AppError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| AppError::Update(format!("open archive: {e}")))?;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::Update(format!("read archive entry: {e}")))?;
        let name = file.name().replace('\\', "/");
        if name.ends_with("/sing-box.exe") || name == "sing-box.exe" {
            let mut buf = Vec::with_capacity(file.size() as usize);
            file.read_to_end(&mut buf)
                .map_err(|e| AppError::Update(format!("extract core: {e}")))?;
            return Ok(buf);
        }
    }
    Err(AppError::Update("sing-box.exe not found in archive".into()))
}

fn emit_progress(app: &tauri::AppHandle, stage: &str, message: &str) {
    let _ = app.emit(
        "core-update-progress",
        serde_json::json!({ "stage": stage, "message": message }),
    );
}

// ─── IPC Commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_core_info(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<CoreInfo, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    Ok(CoreInfo {
        present: base_dir.join(CORE_FILE).exists(),
        build: local_build_info(&base_dir),
    })
}

#[tauri::command]
pub async fn check_core_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<CoreUpdateCheck, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let (latest, _) = fetch_remote().await?;
    let current = local_build_info(&base_dir);
    let present = base_dir.join(CORE_FILE).exists();
    let update_available = match &current {
        Some(c) if present => is_newer(&latest, c),
        _ => true,
    };
    Ok(CoreUpdateCheck {
        current,
        latest,
        update_available,
    })
}

#[tauri::command]
pub async fn update_core(
    mgr: tauri::State<'_, crate::manager::Manager>,
    app: tauri::AppHandle,
) -> Result<BuildInfo, AppError> {
    let base_dir = {
        let mut m = mgr.lock().await;
        m.refresh_running();
        if m.running {
            return Err(AppError::Update("stop the core before updating".into()));
        }
        m.base_dir.clone()
    };

    emit_progress(&app, "checking", "Fetching latest build info");
    let (latest, raw_info) = fetch_remote().await?;
    let url = download_url(&latest)?;

    emit_progress(
        &app,
        "downloading",
        &format!("Downloading {}", latest.windows_asset),
    );
    let bytes = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Update(format!("download core: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Update(format!("download http: {e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::Update(format!("read download: {e}")))?;

    emit_progress(&app, "verifying", "Verifying checksum");
    if !latest.windows_sha256.is_empty() {
        let actual = sha256_hex(&bytes);
        if !actual.eq_ignore_ascii_case(&latest.windows_sha256) {
            return Err(AppError::Update(format!(
                "checksum mismatch: expected {}, got {actual}",
                latest.windows_sha256
            )));
        }
    }

    emit_progress(&app, "extracting", "Extracting core");
    let core_bytes = extract_core(&bytes)?;

    let tmp = base_dir.join("sing-box.exe.download");
    std::fs::write(&tmp, &core_bytes).map_err(|e| AppError::Update(format!("write core: {e}")))?;
    let final_path = base_dir.join(CORE_FILE);
    let _ = std::fs::remove_file(&final_path);
    std::fs::rename(&tmp, &final_path)
        .map_err(|e| AppError::Update(format!("install core: {e}")))?;

    std::fs::write(build_info_path(&base_dir), raw_info)
        .map_err(|e| AppError::Update(format!("write build info: {e}")))?;

    emit_progress(&app, "done", &format!("Updated to {}", latest.version));
    info!(version = %latest.version, run_id = %latest.run_id, "core updated");
    Ok(latest)
}
