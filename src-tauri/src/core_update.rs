use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::time::Duration;

use reqwest::Client;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Emitter;
use tracing::info;

use crate::error::AppError;
use crate::settings;

// ─── Sources ─────────────────────────────────────────────────────────────────

/// lurixo keeps its own pre-release pipeline: a static build-info JSON on the
/// repo's dev branch points at the matching release asset. We compare builds by
/// the monotonic CI run_id — unchanged from before.
const LURIXO_BUILD_INFO_URL: &str =
    "https://raw.githubusercontent.com/lurixo/sing-box-releases/dev/singbox-build-info.json";
const LURIXO_RELEASE_BASE: &str = "https://github.com/lurixo/sing-box-releases/releases/download";

/// SagerNet and reF1nd are read straight from the GitHub Releases API (all
/// releases, pre-release and latest alike) and compared by semantic version.
const SAGERNET_RELEASES_API: &str =
    "https://api.github.com/repos/SagerNet/sing-box/releases?per_page=100";
const REF1ND_RELEASES_API: &str =
    "https://api.github.com/repos/reF1nd/sing-box-releases/releases?per_page=100";

const BUILD_INFO_FILE: &str = "singbox-build-info.json";
const KERNEL_META_FILE: &str = "installed_kernel.json";
const CORE_FILE: &str = "sing-box.exe";
const CORE_OLD: &str = "sing-box.exe.old";
const STAGED_CORE: &str = "sing-box.exe.new";
const STAGED_BUILD_INFO: &str = "singbox-build-info.json.new";
const STAGED_META: &str = "installed_kernel.json.new";
const DOWNLOAD_TMP: &str = "sing-box.exe.download";

/// The three kernel download sources selectable in Settings → Core.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelSource {
    Lurixo,
    Sagernet,
    Ref1nd,
}

impl KernelSource {
    fn from_setting(s: &str) -> Self {
        match s {
            "sagernet" => Self::Sagernet,
            "ref1nd" => Self::Ref1nd,
            _ => Self::Lurixo,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Lurixo => "lurixo",
            Self::Sagernet => "sagernet",
            Self::Ref1nd => "ref1nd",
        }
    }

    fn releases_api(self) -> &'static str {
        match self {
            Self::Sagernet => SAGERNET_RELEASES_API,
            Self::Ref1nd => REF1ND_RELEASES_API,
            Self::Lurixo => "",
        }
    }

    /// The `owner/repo` a download for this source MUST come from — used to pin
    /// the asset URL to the exact repository (not just the github.com host).
    fn repo(self) -> &'static str {
        match self {
            Self::Lurixo => "lurixo/sing-box-releases",
            Self::Sagernet => "SagerNet/sing-box",
            Self::Ref1nd => "reF1nd/sing-box-releases",
        }
    }
}

/// The source the user currently has selected.
fn current_source(base_dir: &Path) -> KernelSource {
    KernelSource::from_setting(&settings::load_settings(base_dir).kernel_source)
}

// ─── lurixo build-info (unchanged mechanism) ─────────────────────────────────

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

/// A lurixo build is newer when its run_id is larger (run_id increases
/// monotonically per release build), falling back to the build timestamp.
fn lurixo_is_newer(remote: &BuildInfo, local: &BuildInfo) -> bool {
    match (run_id_num(remote), run_id_num(local)) {
        (Some(r), Some(l)) => r > l,
        _ => remote.built_at.as_str() > local.built_at.as_str(),
    }
}

async fn fetch_lurixo_remote() -> Result<(BuildInfo, String), AppError> {
    let raw = http_client()
        .get(LURIXO_BUILD_INFO_URL)
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

fn lurixo_download_url(info: &BuildInfo) -> Result<String, AppError> {
    if info.windows_asset.is_empty() {
        return Err(AppError::Update("no windows asset in build info".into()));
    }
    Ok(format!(
        "{}/v{}/{}",
        LURIXO_RELEASE_BASE, info.version, info.windows_asset
    ))
}

// ─── installed-kernel metadata (our own, source-aware) ───────────────────────

/// Records which source + version is currently on disk, so the version display
/// and the SagerNet/reF1nd update check know what to compare against regardless
/// of which source was used last.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledKernel {
    pub source: String,
    pub version: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub asset: String,
}

fn meta_path(base_dir: &Path) -> PathBuf {
    base_dir.join(KERNEL_META_FILE)
}

/// The kernel currently installed: prefer our own metadata file, else fall back
/// to the bundled lurixo build-info (first launch, before any in-app update).
fn installed_kernel(base_dir: &Path) -> Option<InstalledKernel> {
    if let Ok(raw) = std::fs::read_to_string(meta_path(base_dir)) {
        if let Ok(k) = serde_json::from_str::<InstalledKernel>(&raw) {
            return Some(k);
        }
    }
    local_build_info(base_dir).map(|b| InstalledKernel {
        source: "lurixo".into(),
        version: b.version,
        tag: String::new(),
        asset: String::new(),
    })
}

// ─── GitHub Releases API (SagerNet / reF1nd) ─────────────────────────────────

#[derive(Debug, Deserialize)]
struct GhRelease {
    #[serde(default)]
    tag_name: String,
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

/// Parse a release tag (`v1.14.0-alpha.35`, `v1.13.14-reF1nd.1`, …) into a
/// semantic version, tolerating a leading `v`.
fn parse_tag(tag: &str) -> Option<Version> {
    Version::parse(tag.trim().trim_start_matches(['v', 'V'])).ok()
}

/// Pick the Windows amd64 zip from a release: prefer the amd64v3 micro-arch
/// build (what the lurixo core ships), else the baseline amd64 — never the
/// legacy-windows-7 / 386 / arm64 variants.
fn pick_windows_asset(rel: &GhRelease) -> Option<&GhAsset> {
    rel.assets
        .iter()
        .find(|a| a.name.ends_with("-windows-amd64v3.zip"))
        .or_else(|| rel.assets.iter().find(|a| a.name.ends_with("-windows-amd64.zip")))
}

/// Fetch all releases (pre-release and latest) for a source and return the one
/// with the highest semantic version, alongside its parsed version.
async fn fetch_latest_release(src: KernelSource) -> Result<(Version, GhRelease), AppError> {
    let raw = http_client()
        .get(src.releases_api())
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

    let mut best: Option<(Version, GhRelease)> = None;
    for rel in releases {
        if let Some(v) = parse_tag(&rel.tag_name) {
            match &best {
                Some((bv, _)) if *bv >= v => {}
                _ => best = Some((v, rel)),
            }
        }
    }
    best.ok_or_else(|| AppError::Update("no parseable releases found".into()))
}

// ─── shared helpers ──────────────────────────────────────────────────────────

fn http_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("maestro")
        .redirect(github_redirect_policy())
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// Follow redirects only while they stay on GitHub's own hosts, so a tampered
/// API response (or hijacked redirect) cannot bounce the download to an
/// attacker-controlled host. Asset downloads legitimately hop
/// github.com → objects.githubusercontent.com.
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

/// Pin a release-asset URL to the EXACT repository it must come from, not just
/// the github.com host (which is open to anyone — host-only pinning is no
/// integrity boundary): `https://github.com/<owner>/<repo>/releases/download/…`.
fn ensure_release_url(url: &str, repo: &str) -> Result<(), AppError> {
    let prefix = format!("https://github.com/{repo}/releases/download/");
    if url.starts_with(&prefix) {
        Ok(())
    } else {
        Err(AppError::Update(
            "refusing to download core from an unexpected URL".into(),
        ))
    }
}

async fn download_bytes(url: &str) -> Result<Vec<u8>, AppError> {
    let bytes = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Update(format!("download core: {e}")))?
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

/// Write the freshly extracted core to a staging file next to the live one,
/// WITHOUT touching the running `sing-box.exe` (Windows can't replace a running
/// exe — the swap happens later in `apply_staged`, after the core is stopped).
fn stage_core(base_dir: &Path, core_bytes: &[u8]) -> Result<(), AppError> {
    let tmp = base_dir.join(DOWNLOAD_TMP);
    std::fs::write(&tmp, core_bytes).map_err(|e| AppError::Update(format!("write core: {e}")))?;
    let staged = base_dir.join(STAGED_CORE);
    let _ = std::fs::remove_file(&staged);
    std::fs::rename(&tmp, &staged).map_err(|e| AppError::Update(format!("stage core: {e}")))?;
    Ok(())
}

fn stage_meta(base_dir: &Path, meta: &InstalledKernel) -> Result<(), AppError> {
    let raw = serde_json::to_string_pretty(meta)
        .map_err(|e| AppError::Update(format!("serialize kernel meta: {e}")))?;
    std::fs::write(base_dir.join(STAGED_META), raw)
        .map_err(|e| AppError::Update(format!("stage kernel meta: {e}")))?;
    Ok(())
}

// ─── apply / discard / clear (called from lib.rs command wrappers) ───────────

/// Swap the staged kernel into place. The caller MUST have stopped the core
/// first. Re-verifies the staged `.new` bytes against `expected_sha` (captured
/// at download in this elevated process's memory — a non-elevated process could
/// have rewritten the on-disk `.new` since), then moves the live core ASIDE to
/// `.old` (for rollback) before swapping the new one in.
pub fn apply_staged(base_dir: &Path, expected_sha: Option<&str>) -> Result<(), AppError> {
    let staged = base_dir.join(STAGED_CORE);
    if !staged.exists() {
        return Err(AppError::Update("no downloaded core to apply".into()));
    }
    if let Some(expected) = expected_sha {
        let bytes = std::fs::read(&staged)
            .map_err(|e| AppError::Update(format!("read staged core: {e}")))?;
        if !sha256_hex(&bytes).eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_file(&staged);
            return Err(AppError::Update(
                "staged core failed integrity check; discarded".into(),
            ));
        }
    }

    let live = base_dir.join(CORE_FILE);
    let old = base_dir.join(CORE_OLD);
    let _ = std::fs::remove_file(&old);
    // Move the live core aside (don't delete) so a failed swap can roll back —
    // a freshly written 30-50MB exe is a realistic AV/indexer lock target.
    if live.exists() {
        std::fs::rename(&live, &old)
            .map_err(|e| AppError::Update(format!("set aside current core: {e}")))?;
    }
    if let Err(e) = std::fs::rename(&staged, &live) {
        if old.exists() {
            let _ = std::fs::rename(&old, &live); // roll back to the working core
        }
        return Err(AppError::Update(format!("install core: {e}")));
    }
    let _ = std::fs::remove_file(&old); // success → drop the backup

    // Remove the destination before each rename: on Windows fs::rename fails if
    // the target already exists, so a second update would otherwise silently
    // leave stale metadata (wrong version/source in the UI and update check).
    let staged_bi = base_dir.join(STAGED_BUILD_INFO);
    if staged_bi.exists() {
        let dst = build_info_path(base_dir);
        let _ = std::fs::remove_file(&dst);
        std::fs::rename(&staged_bi, &dst)
            .map_err(|e| AppError::Update(format!("apply build info: {e}")))?;
    }
    let staged_meta = base_dir.join(STAGED_META);
    if staged_meta.exists() {
        let dst = meta_path(base_dir);
        let _ = std::fs::remove_file(&dst);
        std::fs::rename(&staged_meta, &dst)
            .map_err(|e| AppError::Update(format!("apply kernel meta: {e}")))?;
    }
    Ok(())
}

/// Drop a staged-but-not-applied download (user cancelled the restart prompt).
pub fn discard_staged(base_dir: &Path) {
    for n in [STAGED_CORE, STAGED_BUILD_INFO, STAGED_META, DOWNLOAD_TMP] {
        let _ = std::fs::remove_file(base_dir.join(n));
    }
}

/// Startup recovery: if a prior apply was interrupted (live core missing but a
/// `.old` backup present) restore it, then discard any cross-session staged
/// artifacts. A `.new` from a previous session can no longer be integrity-
/// checked (its in-memory hash is gone), so it is dropped rather than trusted.
pub fn cleanup_leftovers(base_dir: &Path) {
    let live = base_dir.join(CORE_FILE);
    let old = base_dir.join(CORE_OLD);
    if !live.exists() && old.exists() {
        let _ = std::fs::rename(&old, &live);
    }
    for n in [CORE_OLD, STAGED_CORE, STAGED_BUILD_INFO, STAGED_META, DOWNLOAD_TMP] {
        let _ = std::fs::remove_file(base_dir.join(n));
    }
}

/// Clear cache: delete cache.db plus any leftover/staged downloaded-core
/// artifacts, keeping the in-use sing-box.exe and its metadata. The caller must
/// have stopped the core (cache.db is locked while it runs). Returns how many
/// files were actually removed.
pub fn clear_cache(base_dir: &Path) -> u32 {
    let mut removed = 0u32;
    for n in ["cache.db", STAGED_CORE, STAGED_BUILD_INFO, STAGED_META, DOWNLOAD_TMP] {
        let p = base_dir.join(n);
        if p.exists() && std::fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    removed
}

// ─── IPC Commands ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct CoreInfo {
    pub present: bool,
    /// The source the installed kernel came from ("lurixo" by default).
    pub source: String,
    pub version: Option<String>,
}

#[tauri::command]
pub async fn get_core_info(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<CoreInfo, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let present = base_dir.join(CORE_FILE).exists();
    let installed = installed_kernel(&base_dir);
    Ok(CoreInfo {
        present,
        source: installed
            .as_ref()
            .map(|k| k.source.clone())
            .unwrap_or_else(|| "lurixo".into()),
        version: if present {
            installed.map(|k| k.version)
        } else {
            None
        },
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct CoreUpdateCheck {
    /// The selected source the check ran against.
    pub source: String,
    pub current_version: Option<String>,
    pub latest_version: String,
    pub update_available: bool,
}

#[tauri::command]
pub async fn check_core_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<CoreUpdateCheck, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let src = current_source(&base_dir);
    let present = base_dir.join(CORE_FILE).exists();
    let installed = installed_kernel(&base_dir);
    let current_version = installed.as_ref().map(|k| k.version.clone());
    // Switching to a different source must always offer to install it, even when
    // its latest version isn't strictly newer than what's installed — comparing
    // versions across sources is meaningless (e.g. SagerNet 1.13 vs lurixo 1.14).
    let source_changed = installed
        .as_ref()
        .map(|k| k.source != src.as_str())
        .unwrap_or(true);

    match src {
        KernelSource::Lurixo => {
            let (latest, _) = fetch_lurixo_remote().await?;
            let local = local_build_info(&base_dir);
            let update_available = source_changed
                || match &local {
                    Some(l) if present => lurixo_is_newer(&latest, l),
                    _ => true,
                };
            Ok(CoreUpdateCheck {
                source: "lurixo".into(),
                current_version,
                latest_version: latest.version,
                update_available,
            })
        }
        _ => {
            // Highest semantic version across all of the source's releases
            // (pre-release + latest), compared to what's installed.
            let (latest, _) = fetch_latest_release(src).await?;
            let current_semver = current_version.as_deref().and_then(parse_tag);
            let update_available = source_changed
                || match (present, current_semver) {
                    (true, Some(c)) => latest > c,
                    _ => true,
                };
            Ok(CoreUpdateCheck {
                source: src.as_str().into(),
                current_version,
                latest_version: latest.to_string(),
                update_available,
            })
        }
    }
}

/// Result of staging a download — surfaced to the UI so it can prompt the user
/// to confirm the restart before the new kernel is applied.
#[derive(Debug, Clone, Serialize)]
pub struct StagedKernel {
    pub source: String,
    pub version: String,
}

/// Report a previously staged-but-not-applied download (a `sing-box.exe.new`
/// from a prior session), so the UI can re-open the restart-confirm prompt
/// instead of orphaning the staged files. Returns None when nothing is staged.
#[tauri::command]
pub async fn get_staged_kernel(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<Option<StagedKernel>, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    if !base_dir.join(STAGED_CORE).exists() {
        return Ok(None);
    }
    let staged = std::fs::read_to_string(base_dir.join(STAGED_META))
        .ok()
        .and_then(|raw| serde_json::from_str::<InstalledKernel>(&raw).ok())
        .map(|k| StagedKernel {
            source: k.source,
            version: k.version,
        });
    Ok(staged)
}

/// Download the latest core for the selected source and stage it next to the
/// live binary WITHOUT applying it. The core can stay running during the
/// download; the swap + restart happens in `apply_staged_kernel` after the user
/// confirms.
#[tauri::command]
pub async fn download_kernel(
    mgr: tauri::State<'_, crate::manager::Manager>,
    app: tauri::AppHandle,
) -> Result<StagedKernel, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let src = current_source(&base_dir);

    emit_progress(&app, "checking", "Fetching latest release");
    match src {
        KernelSource::Lurixo => {
            let (latest, raw_info) = fetch_lurixo_remote().await?;
            let url = lurixo_download_url(&latest)?;
            ensure_release_url(&url, src.repo())?;

            emit_progress(&app, "downloading", &format!("Downloading {}", latest.windows_asset));
            let bytes = download_bytes(&url).await?;

            emit_progress(&app, "verifying", "Verifying checksum");
            // lurixo is the trusted default source: a missing checksum means we
            // cannot vouch for the bytes, so refuse rather than install blindly.
            if latest.windows_sha256.is_empty() {
                return Err(AppError::Update(
                    "lurixo build-info has no sha256; refusing to update".into(),
                ));
            }
            let actual = sha256_hex(&bytes);
            if !actual.eq_ignore_ascii_case(&latest.windows_sha256) {
                return Err(AppError::Update(format!(
                    "checksum mismatch: expected {}, got {actual}",
                    latest.windows_sha256
                )));
            }

            emit_progress(&app, "extracting", "Extracting core");
            let core = extract_core(&bytes)?;
            stage_core(&base_dir, &core)?;
            mgr.lock().await.staged_core_sha = Some(sha256_hex(&core));
            std::fs::write(base_dir.join(STAGED_BUILD_INFO), &raw_info)
                .map_err(|e| AppError::Update(format!("stage build info: {e}")))?;
            stage_meta(
                &base_dir,
                &InstalledKernel {
                    source: "lurixo".into(),
                    version: latest.version.clone(),
                    tag: format!("v{}", latest.version),
                    asset: latest.windows_asset.clone(),
                },
            )?;

            emit_progress(&app, "done", &format!("Downloaded {}", latest.version));
            info!(version = %latest.version, run_id = %latest.run_id, "lurixo kernel staged");
            Ok(StagedKernel {
                source: "lurixo".into(),
                version: latest.version,
            })
        }
        _ => {
            let (version, rel) = fetch_latest_release(src).await?;
            let asset = pick_windows_asset(&rel)
                .ok_or_else(|| AppError::Update("no windows-amd64 asset in latest release".into()))?;
            let (asset_name, asset_url) = (asset.name.clone(), asset.browser_download_url.clone());
            ensure_release_url(&asset_url, src.repo())?;

            emit_progress(&app, "downloading", &format!("Downloading {asset_name}"));
            // SagerNet/reF1nd publish no upstream checksum; integrity rests on the
            // repository-pinned HTTPS download above plus the in-session re-verify
            // of the staged bytes at apply time.
            let bytes = download_bytes(&asset_url).await?;

            emit_progress(&app, "extracting", "Extracting core");
            let core = extract_core(&bytes)?;
            stage_core(&base_dir, &core)?;
            mgr.lock().await.staged_core_sha = Some(sha256_hex(&core));
            // These sources have no lurixo build-info; drop any stale staged one.
            let _ = std::fs::remove_file(base_dir.join(STAGED_BUILD_INFO));
            stage_meta(
                &base_dir,
                &InstalledKernel {
                    source: src.as_str().into(),
                    version: version.to_string(),
                    tag: rel.tag_name.clone(),
                    asset: asset_name,
                },
            )?;

            emit_progress(&app, "done", &format!("Downloaded {version}"));
            info!(source = %src.as_str(), version = %version, "kernel staged");
            Ok(StagedKernel {
                source: src.as_str().into(),
                version: version.to_string(),
            })
        }
    }
}
