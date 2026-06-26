//! Maestro application self-update — distinct from the sing-box kernel update in
//! `core_update.rs`. The running portable app learns its own build timestamp
//! from a bundled `maestro-build-info.json`, checks the newest GitHub release
//! (pre-release included), and — by user-confirmed restart — swaps its own exe.
//!
//! Update decision is TIMESTAMP-ONLY (`built_at`), never the version number.
//! Downloads are sha256-verified against the release's published hash.

use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tracing::info;

use crate::error::AppError;

/// Newest releases of the app repo, pre-release included (sorted newest-first).
const RELEASES_API: &str = "https://api.github.com/repos/lurixo/Maestro/releases?per_page=10";
/// The repo every app download MUST come from (pinned in the asset URL).
const REPO: &str = "lurixo/Maestro";
/// Bundled build-info filename (lives in base_dir, i.e. data/), and the same
/// name published as a release asset.
const BUILD_INFO_FILE: &str = "maestro-build-info.json";
/// The app binary name inside the portable zip.
const APP_EXE: &str = "Maestro.exe";
/// Staged-but-not-applied build-info (next to the live one in base_dir).
const STAGED_BUILD_INFO: &str = "maestro-build-info.json.new";

/// Build metadata for the app, mirroring singbox-build-info.json's schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppBuildInfo {
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

fn build_info_path(base_dir: &Path) -> PathBuf {
    base_dir.join(BUILD_INFO_FILE)
}

fn local_build_info(base_dir: &Path) -> Option<AppBuildInfo> {
    let raw = std::fs::read_to_string(build_info_path(base_dir)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// TIMESTAMP-ONLY precedence: a remote build is newer strictly when its
/// `built_at` (ISO-8601 UTC, lexicographically == chronologically ordered) is
/// greater than the local one. The version number is intentionally ignored.
fn is_newer(remote: &AppBuildInfo, local: &AppBuildInfo) -> bool {
    !remote.built_at.is_empty() && remote.built_at.as_str() > local.built_at.as_str()
}

// ─── GitHub Releases API ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct GhRelease {
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    #[serde(default)]
    name: String,
    #[serde(default)]
    browser_download_url: String,
}

/// The newest published release (pre-release included).
async fn fetch_latest_release() -> Result<GhRelease, AppError> {
    let raw = http_client()
        .get(RELEASES_API)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Update(format!("fetch releases: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Update(format!("releases http: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Update(format!("read releases: {e}")))?;
    let releases: Vec<GhRelease> =
        serde_json::from_str(&raw).map_err(|e| AppError::Update(format!("parse releases: {e}")))?;
    releases
        .into_iter()
        .next()
        .ok_or_else(|| AppError::Update("no app releases found".into()))
}

/// Pull the `maestro-build-info.json` asset of the newest release.
async fn fetch_remote_build_info() -> Result<(AppBuildInfo, GhRelease), AppError> {
    let rel = fetch_latest_release().await?;
    let url = {
        let asset = rel
            .assets
            .iter()
            .find(|a| a.name == BUILD_INFO_FILE)
            .ok_or_else(|| AppError::Update("no maestro-build-info.json in latest release".into()))?;
        ensure_release_url(&asset.browser_download_url)?;
        asset.browser_download_url.clone()
    };
    let raw = http_client()
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Update(format!("fetch build info: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Update(format!("build info http: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Update(format!("read build info: {e}")))?;
    let info: AppBuildInfo =
        serde_json::from_str(&raw).map_err(|e| AppError::Update(format!("parse build info: {e}")))?;
    Ok((info, rel))
}

// ─── shared helpers ──────────────────────────────────────────────────────────

fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("maestro")
        .redirect(github_redirect_policy())
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// Follow redirects only while they stay on GitHub's own hosts (github.com →
/// objects.githubusercontent.com), so a hijacked redirect can't bounce the
/// download elsewhere.
fn github_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        let host = attempt.url().host_str().unwrap_or("").to_ascii_lowercase();
        let ok = host == "github.com" || host.ends_with(".githubusercontent.com");
        if !ok {
            attempt.error("redirect to a non-GitHub host")
        } else if attempt.previous().len() > 10 {
            attempt.error("too many redirects")
        } else {
            attempt.follow()
        }
    })
}

/// Pin a release-asset URL to the exact repo it must come from, not just the
/// github.com host: `https://github.com/lurixo/Maestro/releases/download/…`.
fn ensure_release_url(url: &str) -> Result<(), AppError> {
    let prefix = format!("https://github.com/{REPO}/releases/download/");
    if url.starts_with(&prefix) {
        Ok(())
    } else {
        Err(AppError::Update(
            "refusing to download update from an unexpected URL".into(),
        ))
    }
}

async fn download_bytes(url: &str) -> Result<Vec<u8>, AppError> {
    let bytes = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Update(format!("download update: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Update(format!("download http: {e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::Update(format!("read download: {e}")))?;
    Ok(bytes.to_vec())
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// Extract a named top-level file from a zip (matches `name` or `*/name`).
fn extract_named(zip_bytes: &[u8], name: &str) -> Result<Vec<u8>, AppError> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|e| AppError::Update(format!("open archive: {e}")))?;
    let suffix = format!("/{name}");
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| AppError::Update(format!("read archive entry: {e}")))?;
        let entry = file.name().replace('\\', "/");
        if entry == name || entry.ends_with(&suffix) {
            let mut buf = Vec::with_capacity(file.size() as usize);
            file.read_to_end(&mut buf)
                .map_err(|e| AppError::Update(format!("extract {name}: {e}")))?;
            return Ok(buf);
        }
    }
    Err(AppError::Update(format!("{name} not found in archive")))
}

fn emit_progress(app: &tauri::AppHandle, stage: &str, message: &str) {
    let _ = app.emit(
        "app-update-progress",
        serde_json::json!({ "stage": stage, "message": message }),
    );
}

/// Append a suffix to a path's filename (e.g. Maestro.exe -> Maestro.exe.new).
fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

// ─── apply / cleanup ─────────────────────────────────────────────────────────

/// Swap the staged app binary into place and spawn a detached relauncher that
/// waits for THIS process to exit, then starts the new exe. Windows permits
/// renaming a running exe (it just can't be deleted/overwritten), so we move
/// the live exe aside (.old, cleaned next launch) and the staged one in.
pub fn apply_staged(base_dir: &Path, expected_sha: Option<&str>) -> Result<(), AppError> {
    let cur = std::env::current_exe().map_err(|e| AppError::Update(format!("current exe: {e}")))?;
    let staged = with_suffix(&cur, ".new");
    if !staged.exists() {
        return Err(AppError::Update("no downloaded update to apply".into()));
    }
    // Re-verify the staged bytes against the hash captured at download (held in
    // this elevated process's memory — not the on-disk build-info, which a
    // non-elevated process could rewrite alongside the `.new`) before it becomes
    // the admin-run exe.
    if let Some(expected) = expected_sha {
        let bytes = std::fs::read(&staged)
            .map_err(|e| AppError::Update(format!("read staged update: {e}")))?;
        if !sha256_hex(&bytes).eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&staged);
            return Err(AppError::Update(
                "staged update failed integrity check; discarded".into(),
            ));
        }
    }
    let old = with_suffix(&cur, ".old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&cur, &old).map_err(|e| AppError::Update(format!("move running exe: {e}")))?;
    if let Err(e) = std::fs::rename(&staged, &cur) {
        // Roll back so the app is still runnable.
        let _ = std::fs::rename(&old, &cur);
        return Err(AppError::Update(format!("install new exe: {e}")));
    }

    // Swap the bundled build-info so the new run knows its own built_at. A
    // single rename (Windows fs::rename replaces an existing file) keeps the old
    // build-info intact if it fails, so we never end up with none.
    let staged_bi = base_dir.join(STAGED_BUILD_INFO);
    if staged_bi.exists() {
        let _ = std::fs::rename(&staged_bi, build_info_path(base_dir));
    }

    if spawn_relauncher(&cur) {
        info!("app update applied; relauncher spawned");
    } else {
        info!("app update applied; relauncher not spawned — manual restart needed");
    }
    Ok(())
}

/// Detached helper: poll until THIS process has fully exited, then start the new
/// exe. Waiting for the old instance to be *gone* (rather than a fixed timeout)
/// is what keeps the single-instance guard from redirecting — and discarding —
/// the relaunch. Returns whether the helper was spawned.
#[cfg(target_os = "windows")]
fn spawn_relauncher(exe: &Path) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;
    const DETACHED_PROCESS: u32 = 0x00000008;
    let pid = std::process::id();
    // Single-quote the path for PowerShell; escape any embedded single quotes.
    let path = exe.display().to_string().replace('\'', "''");
    let script = format!(
        "for ($i=0; $i -lt 600; $i++) {{ if (-not (Get-Process -Id {pid} -ErrorAction SilentlyContinue)) {{ break }}; Start-Sleep -Milliseconds 200 }}; Start-Process -FilePath '{path}'"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|e| tracing::warn!(error = %e, "failed to spawn app-update relauncher"))
        .is_ok()
}

#[cfg(not(target_os = "windows"))]
fn spawn_relauncher(_exe: &Path) -> bool {
    false
}

/// Startup cleanup: drop a leftover `<exe>.old` from a completed self-update,
/// plus any cross-session staged `<exe>.new` + build-info. A `.new` from a
/// previous session can no longer be integrity-verified (its in-memory hash is
/// gone), so it is discarded rather than re-prompted and trusted.
pub fn cleanup_leftovers(base_dir: &Path) {
    if let Ok(cur) = std::env::current_exe() {
        let _ = std::fs::remove_file(with_suffix(&cur, ".old"));
        let _ = std::fs::remove_file(with_suffix(&cur, ".new"));
    }
    let _ = std::fs::remove_file(base_dir.join(STAGED_BUILD_INFO));
}

// ─── IPC Commands ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AppInfo {
    pub version: String,
    pub built_at: String,
}

#[tauri::command]
pub async fn get_app_info(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<AppInfo, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let b = local_build_info(&base_dir);
    Ok(AppInfo {
        version: b.as_ref().map(|x| x.version.clone()).unwrap_or_default(),
        built_at: b.map(|x| x.built_at).unwrap_or_default(),
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct AppUpdateCheck {
    pub current_built_at: String,
    pub latest_version: String,
    pub latest_built_at: String,
    pub update_available: bool,
}

#[tauri::command]
pub async fn check_app_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<AppUpdateCheck, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let (remote, _) = fetch_remote_build_info().await?;
    let local = local_build_info(&base_dir);
    let current_built_at = local.as_ref().map(|x| x.built_at.clone()).unwrap_or_default();
    let update_available = match &local {
        Some(l) => is_newer(&remote, l),
        None => true, // no local build-info (dev build) → allow updating to latest
    };
    Ok(AppUpdateCheck {
        current_built_at,
        latest_version: remote.version,
        latest_built_at: remote.built_at,
        update_available,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct StagedApp {
    pub version: String,
    pub built_at: String,
}

/// Report a staged-but-not-applied app update from a prior session.
#[tauri::command]
pub async fn get_staged_app_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<Option<StagedApp>, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let cur = std::env::current_exe().map_err(|e| AppError::Update(format!("current exe: {e}")))?;
    if !with_suffix(&cur, ".new").exists() {
        return Ok(None);
    }
    let staged = std::fs::read_to_string(base_dir.join(STAGED_BUILD_INFO))
        .ok()
        .and_then(|raw| serde_json::from_str::<AppBuildInfo>(&raw).ok())
        .map(|b| StagedApp {
            version: b.version,
            built_at: b.built_at,
        });
    Ok(staged)
}

#[tauri::command]
pub async fn discard_app_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<(), AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    if let Ok(cur) = std::env::current_exe() {
        let _ = std::fs::remove_file(with_suffix(&cur, ".new"));
    }
    let _ = std::fs::remove_file(base_dir.join(STAGED_BUILD_INFO));
    Ok(())
}

/// Download the newest release's portable zip, verify the app binary's sha256,
/// and stage it (the running exe is untouched until `apply_app_update`). The
/// staged update applies only the app binary + its build-info, never the
/// kernel, settings or configs.
#[tauri::command]
pub async fn download_app_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
    app: tauri::AppHandle,
) -> Result<StagedApp, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();

    emit_progress(&app, "checking", "Fetching latest Maestro release");
    let (remote, rel) = fetch_remote_build_info().await?;
    if remote.windows_sha256.is_empty() {
        return Err(AppError::Update(
            "release build-info has no sha256; refusing to update".into(),
        ));
    }
    let url = {
        let asset = rel
            .assets
            .iter()
            .find(|a| a.name == remote.windows_asset)
            .ok_or_else(|| {
                AppError::Update(format!("release asset {} not found", remote.windows_asset))
            })?;
        ensure_release_url(&asset.browser_download_url)?;
        asset.browser_download_url.clone()
    };

    emit_progress(&app, "downloading", &format!("Downloading {}", remote.windows_asset));
    let bytes = download_bytes(&url).await?;

    emit_progress(&app, "extracting", "Extracting Maestro");
    let exe = extract_named(&bytes, APP_EXE)?;

    emit_progress(&app, "verifying", "Verifying checksum");
    let actual = sha256_hex(&exe);
    if !actual.eq_ignore_ascii_case(&remote.windows_sha256) {
        return Err(AppError::Update(format!(
            "checksum mismatch: expected {}, got {actual}",
            remote.windows_sha256
        )));
    }

    // Stage the new exe next to the running one, and the build-info in base_dir.
    let cur = std::env::current_exe().map_err(|e| AppError::Update(format!("current exe: {e}")))?;
    let staged_exe = with_suffix(&cur, ".new");
    let _ = std::fs::remove_file(&staged_exe);
    std::fs::write(&staged_exe, &exe).map_err(|e| AppError::Update(format!("stage exe: {e}")))?;
    let raw = serde_json::to_string_pretty(&remote)
        .map_err(|e| AppError::Update(format!("serialize build info: {e}")))?;
    std::fs::write(base_dir.join(STAGED_BUILD_INFO), raw)
        .map_err(|e| AppError::Update(format!("stage build info: {e}")))?;
    // Remember the verified hash in-process so apply can re-check the staged
    // bytes against it (rather than the rewritable on-disk build-info).
    mgr.lock().await.staged_app_sha = Some(actual);

    emit_progress(&app, "done", &format!("Downloaded {}", remote.version));
    info!(version = %remote.version, built_at = %remote.built_at, "app update staged");
    Ok(StagedApp {
        version: remote.version,
        built_at: remote.built_at,
    })
}
