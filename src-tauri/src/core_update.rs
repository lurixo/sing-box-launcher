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

/// SagerNet and reF1nd are read from the GitHub Releases API on two channels:
/// `stable` uses `/releases/latest` (GitHub's newest non-prerelease — a single
/// fast fetch), `dev` lists the most recent releases and takes the highest
/// pre-release semver. Each is compared by semantic version.
const SAGERNET_RELEASES_API: &str =
    "https://api.github.com/repos/SagerNet/sing-box/releases";
const REF1ND_RELEASES_API: &str =
    "https://api.github.com/repos/reF1nd/sing-box-releases/releases";

/// How many recent releases to scan for the dev (pre-release) channel. Releases
/// come back newest-first, so the highest pre-release semver is always near the
/// top — 30 is plenty and far cheaper than the old per_page=100 full scan.
const DEV_SCAN_LIMIT: u32 = 30;

const BUILD_INFO_FILE: &str = "singbox-build-info.json";
const KERNEL_META_FILE: &str = "installed_kernel.json";
const CORE_FILE: &str = "sing-box.exe";
const CORE_OLD: &str = "sing-box.exe.old";
const STAGED_CORE: &str = "sing-box.exe.new";
const STAGED_BUILD_INFO: &str = "singbox-build-info.json.new";
const STAGED_META: &str = "installed_kernel.json.new";
const DOWNLOAD_TMP: &str = "sing-box.exe.download";
/// Durable rollback slot: the core that the last update REPLACED, kept across
/// sessions so the user can roll back to it. Distinct from the transient
/// `CORE_OLD` (which exists only mid-swap). Never touched by clear-cache or the
/// startup cleanup, so a rollback target survives a later update / cache clear.
const CORE_PREV: &str = "sing-box.exe.prev";
/// The lurixo build-info paired with `CORE_PREV` (so a rolled-back lurixo kernel
/// reports the right run_id). Absent when the previous core wasn't a lurixo build.
const BUILD_INFO_PREV: &str = "singbox-build-info.json.prev";
/// Transient used by `swap_files` for the build-info ↔ build-info.prev swap;
/// only present if a rollback was interrupted mid-swap (cleaned next launch).
const BUILD_INFO_SWAPTMP: &str = "singbox-build-info.json.swaptmp";

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

    fn releases_api_base(self) -> &'static str {
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

    /// Whether this source has separate stable/dev channels. lurixo ships a
    /// single pre-release pipeline, so the channel dimension only applies to the
    /// GitHub-Releases sources.
    fn has_channels(self) -> bool {
        matches!(self, Self::Sagernet | Self::Ref1nd)
    }
}

/// The release channel for the GitHub-Releases sources: `stable` tracks the
/// repo's published (non-prerelease) "latest", `dev` tracks the highest
/// pre-release. lurixo ignores this (single pipeline).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelChannel {
    Stable,
    Dev,
}

impl KernelChannel {
    fn from_setting(s: &str) -> Self {
        match s {
            "dev" => Self::Dev,
            _ => Self::Stable,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Dev => "dev",
        }
    }
}

/// The channel the user currently has selected (only meaningful for sources with
/// `has_channels()`).
fn current_channel(base_dir: &Path) -> KernelChannel {
    KernelChannel::from_setting(&settings::load_settings(base_dir).kernel_channel)
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
    let raw = check_client()
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
    /// "stable" / "dev" for the GitHub sources; empty for lurixo (single
    /// pipeline). `#[serde(default)]` keeps older meta files (pre-channel)
    /// readable — a missing channel is treated as "stable" when compared.
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub asset: String,
    /// The kernel this one replaced, retained for a one-step rollback. The backup
    /// binary lives at `CORE_PREV`; this records its identity. `None` until an
    /// update has replaced something. Only ONE level is kept (rollback is a
    /// reversible swap, not an unbounded undo stack).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<PreviousKernel>,
}

/// Identity of a retained previous kernel (the rollback target). A flat mirror of
/// the comparable `InstalledKernel` fields — deliberately without its own
/// `previous`, so the metadata never nests beyond one level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreviousKernel {
    pub source: String,
    pub version: String,
    #[serde(default)]
    pub channel: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub asset: String,
}

fn to_previous(k: &InstalledKernel) -> PreviousKernel {
    PreviousKernel {
        source: k.source.clone(),
        version: k.version.clone(),
        channel: k.channel.clone(),
        tag: k.tag.clone(),
        asset: k.asset.clone(),
    }
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
        channel: String::new(),
        tag: String::new(),
        asset: String::new(),
        previous: None,
    })
}

// ─── GitHub Releases API (SagerNet / reF1nd) ─────────────────────────────────

#[derive(Debug, Deserialize)]
struct GhRelease {
    #[serde(default)]
    tag_name: String,
    /// GitHub's pre-release flag — drives the stable/dev channel split.
    #[serde(default)]
    prerelease: bool,
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

/// Fetch the latest release for a source on the given channel and return it with
/// its parsed version. `stable` hits `/releases/latest` (one fast fetch, no
/// pre-releases); `dev` scans the most recent releases and takes the highest
/// pre-release semver.
async fn fetch_latest_release(
    src: KernelSource,
    channel: KernelChannel,
) -> Result<(Version, GhRelease), AppError> {
    let base = src.releases_api_base();
    match channel {
        KernelChannel::Stable => {
            // GitHub's "latest" endpoint already excludes pre-releases — exactly
            // the stable channel, and a single object instead of a 100-item list.
            let url = format!("{base}/latest");
            let raw = check_client()
                .get(&url)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
                .map_err(|e| AppError::Update(format!("fetch release: {e}")))?
                .error_for_status()
                .map_err(|_| AppError::Update("no stable release found for this source".into()))?
                .text()
                .await
                .map_err(|e| AppError::Update(format!("read release: {e}")))?;
            let rel: GhRelease = serde_json::from_str(&raw)
                .map_err(|e| AppError::Update(format!("parse release: {e}")))?;
            let v = parse_tag(&rel.tag_name)
                .ok_or_else(|| AppError::Update("latest release has no parseable version".into()))?;
            Ok((v, rel))
        }
        KernelChannel::Dev => {
            let url = format!("{base}?per_page={DEV_SCAN_LIMIT}");
            let raw = check_client()
                .get(&url)
                .header("Accept", "application/vnd.github+json")
                .send()
                .await
                .map_err(|e| AppError::Update(format!("fetch releases: {e}")))?
                .error_for_status()
                .map_err(|e| AppError::Update(format!("releases http: {e}")))?
                .text()
                .await
                .map_err(|e| AppError::Update(format!("read releases: {e}")))?;
            let releases: Vec<GhRelease> = serde_json::from_str(&raw)
                .map_err(|e| AppError::Update(format!("parse releases: {e}")))?;

            let mut best: Option<(Version, GhRelease)> = None;
            for rel in releases {
                if !rel.prerelease {
                    continue; // dev channel = pre-releases only
                }
                if let Some(v) = parse_tag(&rel.tag_name) {
                    match &best {
                        Some((bv, _)) if *bv >= v => {}
                        _ => best = Some((v, rel)),
                    }
                }
            }
            best.ok_or_else(|| AppError::Update("no pre-release (dev) builds found".into()))
        }
    }
}

// ─── shared helpers ──────────────────────────────────────────────────────────

fn build_client(overall: Duration) -> Client {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(overall)
        .user_agent("maestro")
        .redirect(github_redirect_policy())
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// Short-lived client for metadata checks (release JSON / build-info). A tight
/// 20s deadline so a flaky network can't hang the "check for updates" spinner
/// for the old 180s — the request is small and either answers fast or is retried.
fn check_client() -> Client {
    build_client(Duration::from_secs(20))
}

/// Generous client for the actual core download (tens of MB). The body is read
/// incrementally with progress, so the only deadline that matters is this
/// overall ceiling against a wholly stalled transfer.
fn download_client() -> Client {
    build_client(Duration::from_secs(600))
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
///
/// Validation runs on the PARSED URL, not the raw string. A raw `starts_with`
/// check can be defeated by `…/<repo>/releases/download/v1/../../../attacker/…`
/// which begins with the prefix yet, once reqwest applies WHATWG path
/// normalization (collapsing `..`/`.` segments, including their percent-encoded
/// and backslash forms), actually resolves to a different repo. We parse with
/// the same `url` crate reqwest uses, so the host + normalized path we check are
/// exactly what will be requested.
fn ensure_release_url(url: &str, repo: &str) -> Result<(), AppError> {
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| AppError::Update("refusing to download core from an unparsable URL".into()))?;
    let host_ok = parsed.scheme() == "https"
        && parsed
            .host_str()
            .map(|h| h.eq_ignore_ascii_case("github.com"))
            .unwrap_or(false);
    let expected = format!("/{repo}/releases/download/");
    if host_ok && parsed.path().starts_with(&expected) {
        Ok(())
    } else {
        Err(AppError::Update(
            "refusing to download core from an unexpected URL".into(),
        ))
    }
}

/// Download the asset, reading the body chunk-by-chunk so we can emit live
/// byte-progress (`received`/`total`) to the UI instead of blocking on one
/// opaque `.bytes()` read. Uses `Response::chunk()` — no extra stream feature
/// or dependency needed. Progress is throttled to ~every 512 KB to avoid an
/// event storm on fast links.
async fn download_streamed(
    app: &tauri::AppHandle,
    url: &str,
    label: &str,
) -> Result<Vec<u8>, AppError> {
    let mut resp = download_client()
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::Update(format!("download core: {e}")))?
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

/// Like `emit_progress` but carries byte counts so the UI can draw a real
/// progress bar. `total` is None when the server sends no Content-Length.
fn emit_download_progress(app: &tauri::AppHandle, label: &str, received: u64, total: Option<u64>) {
    let _ = app.emit(
        "core-update-progress",
        serde_json::json!({
            "stage": "downloading",
            "message": format!("Downloading {label}"),
            "received": received,
            "total": total,
        }),
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

// ─── apply / rollback / discard / clear (called from lib.rs command wrappers) ─

/// Swap two paths, treating a missing file as a valid "absent" state, so a
/// binary's paired build-info stays in step across a rollback swap. Best-effort:
/// the build-info is non-authoritative (metadata drives the UI), so a failed leg
/// only risks a stale version display until the next update check.
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

/// Swap the staged kernel into place. The caller MUST have stopped the core
/// first. Re-verifies the staged `.new` bytes against `expected_sha` (captured
/// at download in this elevated process's memory — a non-elevated process could
/// have rewritten the on-disk `.new` since), then moves the live core ASIDE to
/// `.old` (transient, for failure rollback) before swapping the new one in.
///
/// On success the replaced core is PROMOTED to the durable `CORE_PREV` slot (its
/// build-info + identity recorded too) so the user can roll back to it later.
/// Returns the sha256 of that retained backup — the in-memory anchor a same-
/// session rollback re-verifies it against — or `None` when nothing was replaced
/// (first install).
pub fn apply_staged(base_dir: &Path, expected_sha: Option<&str>) -> Result<Option<String>, AppError> {
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

    // The on-disk metadata still describes the core we're about to replace; keep
    // its identity (sans its OWN previous — one level only) as the new rollback
    // target. Read it BEFORE the swap overwrites the meta file below.
    let replaced = installed_kernel(base_dir);

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

    // Promote the replaced core to the durable rollback slot (overwriting any
    // older backup — only the immediately previous version is retained), and
    // record the sha so a same-session rollback can re-verify it.
    let prev = base_dir.join(CORE_PREV);
    let _ = std::fs::remove_file(&prev);
    let prev_sha = if old.exists() && std::fs::rename(&old, &prev).is_ok() {
        std::fs::read(&prev).ok().map(|b| sha256_hex(&b))
    } else {
        None
    };

    // Pair the replaced core's build-info with the backup: move the outgoing
    // build-info to `.prev`, then install the staged one (lurixo sources stage a
    // build-info; SagerNet/reF1nd don't, leaving the live build-info absent).
    let prev_bi = base_dir.join(BUILD_INFO_PREV);
    let _ = std::fs::remove_file(&prev_bi);
    let cur_bi = build_info_path(base_dir);
    if cur_bi.exists() {
        let _ = std::fs::rename(&cur_bi, &prev_bi);
    }
    let staged_bi = base_dir.join(STAGED_BUILD_INFO);
    if staged_bi.exists() {
        std::fs::rename(&staged_bi, &cur_bi)
            .map_err(|e| AppError::Update(format!("apply build info: {e}")))?;
    }

    // Write the new metadata with the retained previous recorded. (If there's no
    // staged meta — shouldn't happen, download always writes one — leave the old
    // meta in place rather than fabricate one.)
    let staged_meta = base_dir.join(STAGED_META);
    if staged_meta.exists() {
        let raw = std::fs::read_to_string(&staged_meta)
            .map_err(|e| AppError::Update(format!("read staged kernel meta: {e}")))?;
        let mut meta: InstalledKernel = serde_json::from_str(&raw)
            .map_err(|e| AppError::Update(format!("parse staged kernel meta: {e}")))?;
        meta.previous = replaced.as_ref().map(to_previous);
        let out = serde_json::to_string_pretty(&meta)
            .map_err(|e| AppError::Update(format!("serialize kernel meta: {e}")))?;
        std::fs::write(meta_path(base_dir), out)
            .map_err(|e| AppError::Update(format!("apply kernel meta: {e}")))?;
        let _ = std::fs::remove_file(&staged_meta);
    }
    Ok(prev_sha)
}

/// Roll the kernel back to the retained previous version: a SYMMETRIC swap of the
/// live binary with the `CORE_PREV` backup (and their build-info + metadata), so
/// the operation is itself reversible (the version rolled away from becomes the
/// new backup, allowing a roll-forward). The caller MUST have stopped the core.
///
/// `expected_prev_sha` is the in-memory anchor captured when the backup was made;
/// when present (same session) the backup is re-verified before it becomes the
/// admin-run core. When absent (the `.prev` survived a restart) the swap proceeds
/// — a cross-session backup has no in-memory anchor by design, so its integrity
/// rests on the data dir's filesystem ACLs (a known residual, see review notes).
/// Returns the sha of the NEW backup (the version rolled away from) to re-anchor.
pub fn rollback(base_dir: &Path, expected_prev_sha: Option<&str>) -> Result<Option<String>, AppError> {
    let prev = base_dir.join(CORE_PREV);
    if !prev.exists() {
        return Err(AppError::Update("no previous kernel to roll back to".into()));
    }
    let current = installed_kernel(base_dir)
        .ok_or_else(|| AppError::Update("no installed-kernel metadata".into()))?;
    let target = current
        .previous
        .clone()
        .ok_or_else(|| AppError::Update("no previous kernel recorded".into()))?;

    if let Some(expected) = expected_prev_sha {
        let bytes = std::fs::read(&prev)
            .map_err(|e| AppError::Update(format!("read previous core: {e}")))?;
        if !sha256_hex(&bytes).eq_ignore_ascii_case(expected) {
            return Err(AppError::Update(
                "previous kernel failed integrity check; rollback refused".into(),
            ));
        }
    }

    // Swap live <-> prev through the shared transient (CORE_OLD), so an
    // interrupted rollback recovers via the same cleanup_leftovers path as an
    // interrupted apply (live missing + `.old` present -> restore).
    let live = base_dir.join(CORE_FILE);
    let old = base_dir.join(CORE_OLD);
    let _ = std::fs::remove_file(&old);
    if live.exists() {
        std::fs::rename(&live, &old)
            .map_err(|e| AppError::Update(format!("set aside current core: {e}")))?;
    }
    if let Err(e) = std::fs::rename(&prev, &live) {
        if old.exists() {
            let _ = std::fs::rename(&old, &live);
        }
        return Err(AppError::Update(format!("restore previous core: {e}")));
    }
    // The version rolled away from becomes the new backup (roll-forward target).
    let new_prev_sha = if old.exists() && std::fs::rename(&old, &prev).is_ok() {
        std::fs::read(&prev).ok().map(|b| sha256_hex(&b))
    } else {
        None
    };

    // Keep the build-info paired with the binary across the swap.
    swap_files(
        &build_info_path(base_dir),
        &prev_bi_path(base_dir),
        &base_dir.join(BUILD_INFO_SWAPTMP),
    );

    // Rebuild metadata: previous becomes current, current becomes previous.
    let new_meta = InstalledKernel {
        source: target.source,
        version: target.version,
        channel: target.channel,
        tag: target.tag,
        asset: target.asset,
        previous: Some(to_previous(&current)),
    };
    let raw = serde_json::to_string_pretty(&new_meta)
        .map_err(|e| AppError::Update(format!("serialize kernel meta: {e}")))?;
    std::fs::write(meta_path(base_dir), raw)
        .map_err(|e| AppError::Update(format!("write kernel meta: {e}")))?;
    Ok(new_prev_sha)
}

fn prev_bi_path(base_dir: &Path) -> PathBuf {
    base_dir.join(BUILD_INFO_PREV)
}

/// Drop a staged-but-not-applied download (user cancelled the restart prompt).
/// The durable rollback backup (`CORE_PREV`) is deliberately left intact.
pub fn discard_staged(base_dir: &Path) {
    for n in [STAGED_CORE, STAGED_BUILD_INFO, STAGED_META, DOWNLOAD_TMP] {
        let _ = std::fs::remove_file(base_dir.join(n));
    }
}

/// Startup recovery: if a prior apply/rollback was interrupted (live core missing
/// but a `.old` backup present) restore it, then discard any cross-session staged
/// artifacts. A `.new` from a previous session can no longer be integrity-checked
/// (its in-memory hash is gone), so it is dropped rather than trusted. The durable
/// rollback backup (`CORE_PREV` + its build-info) is PRESERVED across sessions.
pub fn cleanup_leftovers(base_dir: &Path) {
    let live = base_dir.join(CORE_FILE);
    let old = base_dir.join(CORE_OLD);
    if !live.exists() && old.exists() {
        let _ = std::fs::rename(&old, &live);
    }
    for n in [
        CORE_OLD,
        STAGED_CORE,
        STAGED_BUILD_INFO,
        STAGED_META,
        DOWNLOAD_TMP,
        BUILD_INFO_SWAPTMP,
    ] {
        let _ = std::fs::remove_file(base_dir.join(n));
    }
}

/// Clear cache: delete cache.db plus any leftover/staged downloaded-core
/// artifacts, keeping the in-use sing-box.exe and its metadata. The caller must
/// have stopped the core (cache.db is locked while it runs). Returns how many
/// files were actually removed.
///
/// The durable rollback backup (`CORE_PREV` + `BUILD_INFO_PREV`) is intentionally
/// NOT cleared here — clearing the cache must never destroy a rollback target.
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
    /// The channel the installed kernel came from ("stable"/"dev"; empty for
    /// lurixo). Lets the UI tell when the in-use track differs from the selected.
    pub channel: String,
    pub version: Option<String>,
    /// The installed build's release tag (e.g. `v1.14.0-alpha.35`), for the
    /// "view build TAG" affordance. None when nothing is installed.
    pub tag: Option<String>,
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
        channel: installed
            .as_ref()
            .map(|k| k.channel.clone())
            .unwrap_or_default(),
        version: if present {
            installed.as_ref().map(|k| k.version.clone())
        } else {
            None
        },
        tag: if present {
            installed
                .as_ref()
                .map(|k| k.tag.clone())
                .filter(|t| !t.is_empty())
        } else {
            None
        },
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct CoreUpdateCheck {
    /// The selected source the check ran against.
    pub source: String,
    /// The selected channel the check ran against ("stable"/"dev"; empty lurixo).
    pub channel: String,
    pub current_version: Option<String>,
    pub latest_version: String,
    /// The latest build's release tag (verbatim, e.g. `v1.14.0-alpha.35`).
    pub latest_tag: String,
    pub update_available: bool,
}

/// Compare the installed kernel's track to the selected (source, channel). A
/// mismatch means "you've switched tracks" — the check should always offer the
/// selected track's build regardless of version ordering (cross-track version
/// comparison is meaningless), and the UI greys "check" in favour of "download".
fn track_changed(installed: Option<&InstalledKernel>, src: KernelSource, channel: KernelChannel) -> bool {
    let Some(k) = installed else { return true };
    if k.source != src.as_str() {
        return true;
    }
    // Channel only distinguishes tracks for the GitHub sources.
    if src.has_channels() {
        let installed_channel = if k.channel.is_empty() { "stable" } else { k.channel.as_str() };
        if installed_channel != channel.as_str() {
            return true;
        }
    }
    false
}

#[tauri::command]
pub async fn check_core_update(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<CoreUpdateCheck, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    let src = current_source(&base_dir);
    let channel = current_channel(&base_dir);
    let present = base_dir.join(CORE_FILE).exists();
    let installed = installed_kernel(&base_dir);
    let current_version = installed.as_ref().map(|k| k.version.clone());
    // Switching source OR channel must always offer to install the selected
    // track, even when its latest version isn't strictly newer than what's
    // installed (comparing across tracks is meaningless).
    let changed = track_changed(installed.as_ref(), src, channel);
    let channel_str = if src.has_channels() { channel.as_str().to_string() } else { String::new() };

    match src {
        KernelSource::Lurixo => {
            let (latest, _) = fetch_lurixo_remote().await?;
            let local = local_build_info(&base_dir);
            let update_available = changed
                || match &local {
                    Some(l) if present => lurixo_is_newer(&latest, l),
                    _ => true,
                };
            let latest_tag = format!("v{}", latest.version);
            Ok(CoreUpdateCheck {
                source: "lurixo".into(),
                channel: channel_str,
                current_version,
                latest_version: latest.version,
                latest_tag,
                update_available,
            })
        }
        _ => {
            // Latest build on the selected channel, compared to what's installed.
            let (latest, rel) = fetch_latest_release(src, channel).await?;
            let current_semver = current_version.as_deref().and_then(parse_tag);
            let update_available = changed
                || match (present, current_semver) {
                    (true, Some(c)) => latest > c,
                    _ => true,
                };
            Ok(CoreUpdateCheck {
                source: src.as_str().into(),
                channel: channel_str,
                current_version,
                latest_version: latest.to_string(),
                latest_tag: rel.tag_name.clone(),
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

/// The kernel a rollback would restore (the retained previous version), surfaced
/// so the UI can offer "roll back to vX.Y".
#[derive(Debug, Clone, Serialize)]
pub struct RollbackTarget {
    pub source: String,
    pub version: String,
    pub channel: String,
    pub tag: String,
}

/// Report the available kernel-rollback target, or None when there's nothing to
/// roll back to (no retained backup binary, or no recorded previous version).
#[tauri::command]
pub async fn get_kernel_rollback(
    mgr: tauri::State<'_, crate::manager::Manager>,
) -> Result<Option<RollbackTarget>, AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    // A rollback needs BOTH the backup binary and the metadata describing it.
    if !base_dir.join(CORE_PREV).exists() {
        return Ok(None);
    }
    let target = installed_kernel(&base_dir)
        .and_then(|k| k.previous)
        .map(|p| RollbackTarget {
            source: p.source,
            version: p.version,
            channel: p.channel,
            tag: p.tag,
        });
    Ok(target)
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
    let channel = current_channel(&base_dir);

    emit_progress(&app, "checking", "Fetching latest release");
    match src {
        KernelSource::Lurixo => {
            let (latest, raw_info) = fetch_lurixo_remote().await?;
            let url = lurixo_download_url(&latest)?;
            ensure_release_url(&url, src.repo())?;

            let bytes = download_streamed(&app, &url, &latest.windows_asset).await?;

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
                    channel: String::new(),
                    tag: format!("v{}", latest.version),
                    asset: latest.windows_asset.clone(),
                    previous: None,
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
            let (version, rel) = fetch_latest_release(src, channel).await?;
            let asset = pick_windows_asset(&rel)
                .ok_or_else(|| AppError::Update("no windows-amd64 asset in latest release".into()))?;
            let (asset_name, asset_url) = (asset.name.clone(), asset.browser_download_url.clone());
            ensure_release_url(&asset_url, src.repo())?;

            // SagerNet/reF1nd publish no upstream checksum; integrity rests on the
            // repository-pinned HTTPS download above plus the in-session re-verify
            // of the staged bytes at apply time.
            let bytes = download_streamed(&app, &asset_url, &asset_name).await?;

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
                    channel: channel.as_str().into(),
                    tag: rel.tag_name.clone(),
                    asset: asset_name,
                    previous: None,
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
