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
/// Durable rollback build-info for the PORTABLE build: paired with the retained
/// `<exe>.prev`, so a rolled-back app reports the right version/built_at. Kept
/// across sessions (never cleaned), unlike the transient `.old`/`.new`.
const BUILD_INFO_PREV: &str = "maestro-build-info.json.prev";
/// Transient for the build-info ↔ build-info.prev swap (cleaned next launch).
const BUILD_INFO_SWAPTMP: &str = "maestro-build-info.json.swaptmp";
/// Durable record of the version an INSTALLED build updated AWAY from, written
/// just before running a new installer. An installed rollback re-downloads this
/// version's `*-setup.exe` and runs it. Survival across the NSIS reinstall is the
/// one real-machine caveat (see review notes); when absent, rollback is hidden.
const APP_PREV_RECORD: &str = "maestro-app-prev.json";
/// Staged-but-not-applied installer (`*-setup.exe`) for an installed build's
/// self-update, kept in base_dir so `cleanup_leftovers` can drop it next launch
/// (its in-memory integrity hash is gone after a restart).
const STAGED_SETUP: &str = "maestro-update-setup.exe";
/// Distribution-channel marker bundled into the data dir. Only the NSIS
/// installer ships it (contents "installer"); the portable build has none.
const CHANNEL_FILE: &str = "CHANNEL";
/// Releases page opened for installed builds (they update via a new installer,
/// not the portable in-place swap).
const RELEASES_PAGE: &str = "https://github.com/lurixo/Maestro/releases/latest";

/// True when this build was installed via the NSIS installer rather than run
/// from the portable zip. Installed builds must NOT self-update by swapping the
/// exe in place — that would desync the installer's uninstall registration and
/// leave a portable binary inside a tracked install. They update by downloading
/// a fresh installer instead.
pub fn is_installed(base_dir: &Path) -> bool {
    std::fs::read_to_string(base_dir.join(CHANNEL_FILE))
        .map(|s| s.trim().eq_ignore_ascii_case("installer"))
        .unwrap_or(false)
}

/// Build metadata for the app, mirroring singbox-build-info.json's schema.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppBuildInfo {
    pub version: String,
    #[serde(default)]
    pub windows_asset: String,
    #[serde(default)]
    pub windows_sha256: String,
    /// The published `*-setup.exe` asset name + its sha256, used by installed
    /// (NSIS) builds to verify the installer they download. `#[serde(default)]`
    /// keeps older releases (which lacked these) parseable.
    #[serde(default)]
    pub windows_setup_asset: String,
    #[serde(default)]
    pub windows_setup_sha256: String,
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

/// A SPECIFIC release by tag (e.g. `v0.3.1`) — used by the installed-build
/// rollback to fetch the exact previous version's installer.
async fn fetch_release_by_tag(tag: &str) -> Result<GhRelease, AppError> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/tags/{tag}");
    let raw = http_client()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| AppError::Update(format!("fetch release: {e}")))?
        .error_for_status()
        .map_err(|_| AppError::Update(format!("no release found for {tag}")))?
        .text()
        .await
        .map_err(|e| AppError::Update(format!("read release: {e}")))?;
    serde_json::from_str(&raw).map_err(|e| AppError::Update(format!("parse release: {e}")))
}

/// Download + parse the `maestro-build-info.json` asset of a given release.
async fn build_info_of(rel: &GhRelease) -> Result<AppBuildInfo, AppError> {
    let url = {
        let asset = rel
            .assets
            .iter()
            .find(|a| a.name == BUILD_INFO_FILE)
            .ok_or_else(|| AppError::Update("no maestro-build-info.json in release".into()))?;
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
    serde_json::from_str(&raw).map_err(|e| AppError::Update(format!("parse build info: {e}")))
}

/// Pull the build-info of the newest release.
async fn fetch_remote_build_info() -> Result<(AppBuildInfo, GhRelease), AppError> {
    let rel = fetch_latest_release().await?;
    let info = build_info_of(&rel).await?;
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
///
/// Validation runs on the PARSED URL, not the raw string: a raw `starts_with`
/// check is defeated by `…/Maestro/releases/download/v1/../../../attacker/…`,
/// which begins with the prefix yet, once reqwest applies WHATWG path
/// normalization (collapsing `..`/`.` segments and their percent-encoded /
/// backslash forms), resolves to a different repo. Parsing with the same `url`
/// crate reqwest uses makes the host + normalized path we check exactly what
/// will be requested.
fn ensure_release_url(url: &str) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::Update("refusing to download update from an unparsable URL".into()))?;
    let host_ok = parsed.scheme() == "https"
        && parsed
            .host_str()
            .map(|h| h.eq_ignore_ascii_case("github.com"))
            .unwrap_or(false);
    let expected = format!("/{REPO}/releases/download/");
    if host_ok && parsed.path().starts_with(&expected) {
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

/// Download with live byte-progress emitted to the UI (mirrors core_update's
/// streaming download). Uses `Response::chunk()` — no stream feature/dependency
/// — and throttles progress events to ~every 512 KB.
async fn download_streamed(app: &tauri::AppHandle, url: &str, label: &str) -> Result<Vec<u8>, AppError> {
    let mut resp = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Update(format!("download update: {e}")))?
        .error_for_status()
        .map_err(|e| AppError::Update(format!("download http: {e}")))?;
    let total = resp.content_length();
    let mut buf: Vec<u8> = Vec::with_capacity(total.unwrap_or(0) as usize);
    let mut received: u64 = 0;
    let mut last_emit: u64 = 0;
    emit_download_progress(app, label, 0, total);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Update(format!("read download: {e}")))?
    {
        buf.extend_from_slice(&chunk);
        received += chunk.len() as u64;
        if received - last_emit >= 512 * 1024 || Some(received) == total {
            last_emit = received;
            emit_download_progress(app, label, received, total);
        }
    }
    Ok(buf)
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

/// Like `emit_progress` but carries byte counts so the UI can draw a real
/// progress bar. `total` is None when the server sends no Content-Length.
fn emit_download_progress(app: &tauri::AppHandle, label: &str, received: u64, total: Option<u64>) {
    let _ = app.emit(
        "app-update-progress",
        serde_json::json!({
            "stage": "downloading",
            "message": format!("Downloading {label}"),
            "received": received,
            "total": total,
        }),
    );
}

/// Append a suffix to a path's filename (e.g. Maestro.exe -> Maestro.exe.new).
fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_os_string();
    s.push(suffix);
    PathBuf::from(s)
}

/// Swap two paths, treating a missing file as a valid "absent" state, so the
/// portable build-info stays paired with its binary across a rollback swap.
/// Best-effort: the build-info is non-authoritative for safety, so a failed leg
/// only risks a stale version display.
fn swap_files(a: &Path, b: &Path, tmp: &Path) {
    let _ = std::fs::remove_file(tmp);
    if a.exists() {
        let _ = std::fs::rename(a, tmp); // a -> tmp
    }
    if b.exists() {
        let _ = std::fs::remove_file(a);
        let _ = std::fs::rename(b, a); // b -> a
    }
    if tmp.exists() {
        let _ = std::fs::remove_file(b);
        let _ = std::fs::rename(tmp, b); // tmp -> b
    }
}

// ─── apply / cleanup ─────────────────────────────────────────────────────────

/// Swap the staged app binary into place and spawn a detached relauncher that
/// waits for THIS process to exit, then starts the new exe. Windows permits
/// renaming a running exe (it just can't be deleted/overwritten), so we move
/// the live exe aside and the staged one in.
///
/// The replaced exe is PROMOTED to the durable `<exe>.prev` slot (its build-info
/// recorded too) so a portable build can roll back to it. Returns the sha256 of
/// that retained backup — the in-memory anchor a same-session rollback re-checks
/// it against.
pub fn apply_staged(base_dir: &Path, expected_sha: Option<&str>) -> Result<Option<String>, AppError> {
    if is_installed(base_dir) {
        return Err(AppError::Update(
            "this is an installed build — update it by downloading the latest installer from \
             the GitHub releases page, not the portable self-updater"
                .into(),
        ));
    }
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

    // Promote the replaced exe to the durable rollback slot, and capture its sha
    // so a same-session rollback can re-verify it (only one previous is kept).
    let prev = with_suffix(&cur, ".prev");
    let _ = std::fs::remove_file(&prev);
    let prev_sha = if std::fs::rename(&old, &prev).is_ok() {
        std::fs::read(&prev).ok().map(|b| sha256_hex(&b))
    } else {
        None
    };

    // Pair the outgoing build-info with the backup, then install the staged one.
    // (Windows fs::rename replaces an existing file; a failed leg keeps the old
    // build-info intact so we never end up with none.)
    let prev_bi = base_dir.join(BUILD_INFO_PREV);
    let _ = std::fs::remove_file(&prev_bi);
    let cur_bi = build_info_path(base_dir);
    if cur_bi.exists() {
        let _ = std::fs::rename(&cur_bi, &prev_bi);
    }
    let staged_bi = base_dir.join(STAGED_BUILD_INFO);
    if staged_bi.exists() {
        let _ = std::fs::rename(&staged_bi, &cur_bi);
    }

    if spawn_relauncher(&cur) {
        info!("app update applied; relauncher spawned");
    } else {
        info!("app update applied; relauncher not spawned — manual restart needed");
    }
    Ok(prev_sha)
}

/// Roll the PORTABLE app back to the retained previous exe: a symmetric swap of
/// the running exe with `<exe>.prev` (and their build-info), so the rollback is
/// itself reversible (roll-forward). Spawns the same detached relauncher as
/// `apply_staged`; the caller quits afterward. `expected_prev_sha` is the
/// in-session anchor — when present the backup is re-verified before it becomes
/// the admin-run exe; absent (survived a restart) the swap proceeds, its
/// integrity resting on the data dir's ACLs (residual, see review notes).
/// Returns the sha of the new backup (the version rolled away from).
pub fn rollback_portable(base_dir: &Path, expected_prev_sha: Option<&str>) -> Result<Option<String>, AppError> {
    if is_installed(base_dir) {
        return Err(AppError::Update(
            "this is an installed build — roll back via the installer, not the exe swap".into(),
        ));
    }
    let cur = std::env::current_exe().map_err(|e| AppError::Update(format!("current exe: {e}")))?;
    let prev = with_suffix(&cur, ".prev");
    if !prev.exists() {
        return Err(AppError::Update("no previous version to roll back to".into()));
    }
    if let Some(expected) = expected_prev_sha {
        let bytes = std::fs::read(&prev)
            .map_err(|e| AppError::Update(format!("read previous exe: {e}")))?;
        if !sha256_hex(&bytes).eq_ignore_ascii_case(expected) {
            return Err(AppError::Update(
                "previous version failed integrity check; rollback refused".into(),
            ));
        }
    }
    // Swap running exe <-> .prev through the shared transient (.old), so an
    // interrupted rollback recovers via the same cleanup_leftovers path.
    let old = with_suffix(&cur, ".old");
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&cur, &old).map_err(|e| AppError::Update(format!("move running exe: {e}")))?;
    if let Err(e) = std::fs::rename(&prev, &cur) {
        let _ = std::fs::rename(&old, &cur);
        return Err(AppError::Update(format!("restore previous exe: {e}")));
    }
    let new_prev_sha = if std::fs::rename(&old, &prev).is_ok() {
        std::fs::read(&prev).ok().map(|b| sha256_hex(&b))
    } else {
        None
    };

    swap_files(
        &build_info_path(base_dir),
        &base_dir.join(BUILD_INFO_PREV),
        &base_dir.join(BUILD_INFO_SWAPTMP),
    );

    if spawn_relauncher(&cur) {
        info!("app rollback applied; relauncher spawned");
    } else {
        info!("app rollback applied; relauncher not spawned — manual restart needed");
    }
    Ok(new_prev_sha)
}

/// Snapshot the current build-info as the installed-build rollback record, just
/// before a new installer replaces this version. No-op (best effort) if there's
/// no local build-info to record.
pub fn record_app_rollback(base_dir: &Path) {
    let src = build_info_path(base_dir);
    if src.exists() {
        let _ = std::fs::copy(&src, base_dir.join(APP_PREV_RECORD));
    }
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
/// gone), so it is discarded rather than re-prompted and trusted. The durable
/// rollback backup (`<exe>.prev` + `BUILD_INFO_PREV`) and the installed-build
/// rollback record are PRESERVED across sessions.
pub fn cleanup_leftovers(base_dir: &Path) {
    if let Ok(cur) = std::env::current_exe() {
        let _ = std::fs::remove_file(with_suffix(&cur, ".old"));
        let _ = std::fs::remove_file(with_suffix(&cur, ".new"));
    }
    let _ = std::fs::remove_file(base_dir.join(STAGED_BUILD_INFO));
    let _ = std::fs::remove_file(base_dir.join(BUILD_INFO_SWAPTMP));
    // A staged installer can't be re-verified after a restart (its in-memory sha
    // is gone), so drop it rather than trust it.
    let _ = std::fs::remove_file(base_dir.join(STAGED_SETUP));
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
    /// Installed (NSIS) build: the UI points the user at the installer download
    /// instead of the portable in-place self-update.
    pub installed: bool,
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
        installed: is_installed(&base_dir),
    })
}

/// Open the GitHub releases page in the default browser — used by installed
/// builds, which update via a new installer rather than the in-place swap.
#[tauri::command]
pub fn open_releases_page() -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        // `cmd /C start "" <url>` hands the URL to the default browser. The empty
        // "" is start's window-title argument so the URL isn't consumed as one.
        std::process::Command::new("cmd")
            .args(["/C", "start", "", RELEASES_PAGE])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| AppError::Update(format!("open releases page: {e}")))?;
    }
    Ok(())
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

#[derive(Debug, Clone, Serialize)]
pub struct AppRollback {
    pub version: String,
    pub built_at: String,
    /// installed build → rollback re-downloads + runs the previous setup.exe;
    /// portable build → rollback swaps the retained `<exe>.prev` in place.
    pub installed: bool,
}

/// Report the available app-rollback target, or None when there's nothing to roll
/// back to. Installed build: the recorded previous version (re-downloaded on
/// rollback). Portable build: the retained `<exe>.prev` (version read from the
/// paired `BUILD_INFO_PREV`).
#[tauri::command]
pub async fn get_app_rollback(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<Option<AppRollback>, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    if is_installed(&base_dir) {
        return Ok(read_app_rollback(&base_dir).map(|b| AppRollback {
            version: b.version,
            built_at: b.built_at,
            installed: true,
        }));
    }
    // Portable: the retained backup exe must be present.
    let cur = std::env::current_exe().map_err(|e| AppError::Update(format!("current exe: {e}")))?;
    if !with_suffix(&cur, ".prev").exists() {
        return Ok(None);
    }
    let info = std::fs::read_to_string(base_dir.join(BUILD_INFO_PREV))
        .ok()
        .and_then(|raw| serde_json::from_str::<AppBuildInfo>(&raw).ok());
    Ok(Some(AppRollback {
        version: info.as_ref().map(|b| b.version.clone()).unwrap_or_default(),
        built_at: info.map(|b| b.built_at).unwrap_or_default(),
        installed: false,
    }))
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
    let _ = std::fs::remove_file(base_dir.join(STAGED_SETUP));
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

// ─── Installed-build self-update (download + run a new NSIS setup.exe) ────────

/// Download `remote`'s `*-setup.exe` from `rel`, verify its sha256 against the
/// release build-info, stage it in base_dir, and record the verified hash in
/// memory so apply can re-check the on-disk bytes. Shared by the forward update
/// (latest release) and the rollback (a specific previous release by tag).
async fn stage_installer(
    mgr: &tauri::State<'_, crate::manager::Manager>,
    app: &tauri::AppHandle,
    base_dir: &Path,
    remote: &AppBuildInfo,
    rel: &GhRelease,
) -> Result<StagedApp, AppError> {
    // A missing installer hash means we cannot vouch for the setup.exe bytes —
    // refuse rather than run an unverified installer (it executes on the machine).
    if remote.windows_setup_sha256.is_empty() || remote.windows_setup_asset.is_empty() {
        return Err(AppError::Update(
            "release build-info has no installer checksum; refusing to update".into(),
        ));
    }
    let url = {
        let asset = rel
            .assets
            .iter()
            .find(|a| a.name == remote.windows_setup_asset)
            .ok_or_else(|| {
                AppError::Update(format!("release asset {} not found", remote.windows_setup_asset))
            })?;
        // Pin to the exact lurixo/Maestro release-download path (not just the host).
        ensure_release_url(&asset.browser_download_url)?;
        asset.browser_download_url.clone()
    };

    let bytes = download_streamed(app, &url, &remote.windows_setup_asset).await?;

    emit_progress(app, "verifying", "Verifying checksum");
    let actual = sha256_hex(&bytes);
    if !actual.eq_ignore_ascii_case(&remote.windows_setup_sha256) {
        return Err(AppError::Update(format!(
            "checksum mismatch: expected {}, got {actual}",
            remote.windows_setup_sha256
        )));
    }

    let setup_path = base_dir.join(STAGED_SETUP);
    let _ = std::fs::remove_file(&setup_path);
    std::fs::write(&setup_path, &bytes).map_err(|e| AppError::Update(format!("stage installer: {e}")))?;
    mgr.lock().await.staged_setup_sha = Some(actual);

    emit_progress(app, "done", &format!("Downloaded {}", remote.version));
    Ok(StagedApp {
        version: remote.version.clone(),
        built_at: remote.built_at.clone(),
    })
}

/// Download the newest release's `*-setup.exe`, verify its sha256 against the
/// release build-info, and stage it in base_dir. The installer (not an in-place
/// exe swap) is what installed builds run to upgrade — it carries the NSIS
/// uninstall-and-reinstall logic that keeps the install registration intact.
#[tauri::command]
pub async fn download_installer_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
    app: tauri::AppHandle,
) -> Result<StagedApp, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    // This path is only for installed (NSIS) builds; the portable build swaps
    // its own exe via download_app_update.
    if !is_installed(&base_dir) {
        return Err(AppError::Update(
            "not an installed build — use the portable self-update".into(),
        ));
    }

    emit_progress(&app, "checking", "Fetching latest Maestro release");
    let (remote, rel) = fetch_remote_build_info().await?;
    let staged = stage_installer(&mgr, &app, &base_dir, &remote, &rel).await?;
    info!(version = %remote.version, "installer update staged");
    Ok(staged)
}

/// Download the PREVIOUS installed version's `*-setup.exe` (the version recorded
/// when the last in-app installer update ran) and stage it for an installed-build
/// rollback. The exact release is located by tag (`v{version}`) so the recorded
/// version is what's downloaded; its setup.exe is verified against THAT release's
/// build-info before `apply_installer_update` runs it (`/P /R`, with
/// `allowDowngrades` letting NSIS install the older version over the newer).
#[tauri::command]
pub async fn download_installer_rollback(
    mgr: tauri::State<'_, crate::manager::Manager>,
    app: tauri::AppHandle,
) -> Result<StagedApp, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    if !is_installed(&base_dir) {
        return Err(AppError::Update(
            "not an installed build — use the portable rollback".into(),
        ));
    }
    let prev = read_app_rollback(&base_dir)
        .ok_or_else(|| AppError::Update("no previous version recorded to roll back to".into()))?;
    let tag = format!("v{}", prev.version);

    emit_progress(&app, "checking", &format!("Fetching Maestro {tag}"));
    let rel = fetch_release_by_tag(&tag).await?;
    // Use the OLD release's own build-info for the setup hash (not the local one).
    let remote = build_info_of(&rel).await?;
    let staged = stage_installer(&mgr, &app, &base_dir, &remote, &rel).await?;
    info!(version = %remote.version, "installer rollback staged");
    Ok(staged)
}

/// Read the installed-build rollback record (the version we updated away from).
fn read_app_rollback(base_dir: &Path) -> Option<AppBuildInfo> {
    let raw = std::fs::read_to_string(base_dir.join(APP_PREV_RECORD)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// Re-verify the staged installer against the in-memory hash and return BOTH the
/// path AND an open read handle. The handle is opened denying write+delete
/// sharing (Windows `FILE_SHARE_READ` only) and the caller MUST keep it alive
/// across `spawn_installer` — that is what closes the verify→execute TOCTOU: with
/// the deny-write/deny-delete handle held, no other (lower-privileged) process
/// can swap or delete the file between this hash and CreateProcess, so the bytes
/// verified here are provably the bytes executed. `expected_sha` is mandatory: a
/// staged installer with no in-memory anchor is refused, never run unverified.
pub fn verify_staged_setup(base_dir: &Path, expected_sha: &str) -> Result<(std::fs::File, PathBuf), AppError> {
    let setup = base_dir.join(STAGED_SETUP);
    if !setup.exists() {
        return Err(AppError::Update("no downloaded installer to apply".into()));
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.read(true);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x0000_0001; // deny FILE_SHARE_WRITE + FILE_SHARE_DELETE
        opts.share_mode(FILE_SHARE_READ);
    }
    let mut f = opts
        .open(&setup)
        .map_err(|e| AppError::Update(format!("open staged installer: {e}")))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| AppError::Update(format!("read staged installer: {e}")))?;
    if !sha256_hex(&bytes).eq_ignore_ascii_case(expected_sha) {
        drop(f);
        let _ = std::fs::remove_file(&setup);
        return Err(AppError::Update(
            "staged installer failed integrity check; discarded".into(),
        ));
    }
    Ok((f, setup))
}

/// Run the staged NSIS installer in passive mode and detach it. `/P` shows a
/// small progress window (NOT silent — `/S` can hang on a non-silent uninstaller
/// during upgrade), `/R` relaunches Maestro once install completes. The installer
/// waits for this process to exit (CheckIfAppIsRunning) before swapping files.
///
/// IMPORTANT: detached but WITHOUT `CREATE_NO_WINDOW` — passive mode needs to
/// show its progress UI, and we want the user to see the upgrade running.
#[cfg(target_os = "windows")]
pub fn spawn_installer(setup: &Path) -> Result<(), AppError> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x00000008;
    std::process::Command::new(setup)
        .args(["/P", "/R"])
        .creation_flags(DETACHED_PROCESS)
        .spawn()
        .map_err(|e| AppError::Update(format!("run installer: {e}")))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn spawn_installer(_setup: &Path) -> Result<(), AppError> {
    Err(AppError::Update("installer update is Windows-only".into()))
}
