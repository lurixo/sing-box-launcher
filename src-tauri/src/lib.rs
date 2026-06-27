use tauri::Emitter;
mod accent;
mod app_update;
mod config;
mod core_update;
mod crash;
mod elevation;
mod error;
mod groups;
mod logbus;
mod manager;
mod native_api;
mod proxy;
mod settings;
mod tray;

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use tauri::Manager;
use tracing::info;

use crate::error::AppError;
use crate::native_api::NativeClient;

// ─── Debug file logger (works even with windows_subsystem = "windows") ──────

type DebugWriter = Option<Arc<Mutex<std::fs::File>>>;

fn open_debug_log() -> DebugWriter {
    let dir = manager::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("launcher-debug.log");
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .ok()
        .map(|f| Arc::new(Mutex::new(f)))
}

fn dlog(w: &DebugWriter, msg: &str) {
    if let Some(w) = w {
        if let Ok(mut f) = w.lock() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] {msg}");
            let _ = f.flush();
        }
    }
}

// ─── IPC Commands ───────────────────────────────────────────────────────────

#[tauri::command]
async fn start_core(
    mgr: tauri::State<'_, manager::Manager>,
    grp: tauri::State<'_, groups::Groups>,
    app: tauri::AppHandle,
) -> Result<config::ConfigInfo, AppError> {
    let mgr_arc = mgr.inner().clone();
    let mut mgr = mgr.lock().await;
    let info = mgr.start().await?;
    let generation = mgr.generation;

    tray::update_tray_icon(&app, true, false);
    let _ = app.emit("core-status-changed", mgr.status());

    // Load proxy groups in the background
    match NativeClient::new(&info.api_address, &info.api_secret) {
        Ok(client) => {
            // Stream live metrics (traffic/memory/connections) to the frontend.
            spawn_metrics_stream(client.clone(), mgr_arc, generation, app.clone());

            let grp = grp.inner().clone();
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut grp = grp.lock().await;
                match grp.load(client).await {
                    Ok(groups) => {
                        info!(count = groups.len(), "proxy groups loaded");
                        let _ = app2.emit("proxy-groups-updated", &groups);
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "failed to load proxy groups");
                    }
                }
            });
        }
        Err(e) => tracing::warn!(error = %e, "failed to create api client"),
    }

    Ok(info)
}

#[tauri::command]
async fn stop_core(
    mgr: tauri::State<'_, manager::Manager>,
    grp: tauri::State<'_, groups::Groups>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let mut mgr = mgr.lock().await;

    if mgr.proxy_enabled {
        mgr.proxy_enabled = false;
        let _ = proxy::set_system_proxy(false, "", "");
    }

    mgr.stop().await?;
    grp.lock().await.clear();

    tray::update_tray_icon(&app, false, false);
    let _ = app.emit("core-status-changed", mgr.status());
    Ok(())
}

#[tauri::command]
async fn restart_core(
    mgr: tauri::State<'_, manager::Manager>,
    grp: tauri::State<'_, groups::Groups>,
    app: tauri::AppHandle,
) -> Result<config::ConfigInfo, AppError> {
    {
        let mut mgr = mgr.lock().await;
        if mgr.proxy_enabled {
            mgr.proxy_enabled = false;
            let _ = proxy::set_system_proxy(false, "", "");
        }
        if mgr.running {
            mgr.stop().await?;
        }
        grp.lock().await.clear();
    }

    start_core(mgr, grp, app).await
}

/// Working-set memory of this GUI process, added to the core's reported memory
/// so the dashboard's "memory" reflects the Maestro+core total. 0 off-Windows.
#[cfg(target_os = "windows")]
fn gui_memory() -> u64 {
    use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::Threading::GetCurrentProcess;
    unsafe {
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        let cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        counters.cb = cb;
        if GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, cb).is_ok() {
            counters.WorkingSetSize as u64
        } else {
            0
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn gui_memory() -> u64 {
    0
}

/// Stream live core metrics to the frontend, reconnecting while this core
/// session runs. Tolerates a slow API boot and transient stream drops (like
/// the group-load retry); exits deterministically on stop or restart by
/// watching `running` and the start `generation`.
fn spawn_metrics_stream(
    client: NativeClient,
    mgr: manager::Manager,
    generation: u64,
    app: tauri::AppHandle,
) {
    tauri::async_runtime::spawn(async move {
        let alive = |m: &manager::ManagerInner| m.running && m.generation == generation;
        loop {
            if !alive(&*mgr.lock().await) {
                break;
            }
            match client.status_stream(1000).await {
                Ok(mut stream) => {
                    // Throttle to ~1/sec even if the core pushes faster — the
                    // frontend renders at 1 Hz, so a flood would only waste IPC
                    // and (historically) feed a repaint storm.
                    let mut last_emit: Option<std::time::Instant> = None;
                    while let Ok(Some(st)) = stream.message().await {
                        let now = std::time::Instant::now();
                        if last_emit.map_or(true, |t| now.duration_since(t) >= std::time::Duration::from_millis(950)) {
                            last_emit = Some(now);
                            // Show the Maestro+core total: add this GUI process's
                            // working set to the core's reported memory.
                            let mut metrics = native_api::map_status(st);
                            metrics.memory = metrics.memory.saturating_add(gui_memory());
                            let _ = app.emit("metrics-tick", metrics);
                        }
                    }
                }
                Err(e) => tracing::debug!(error = %e, "status stream open failed; retrying"),
            }
            if !alive(&*mgr.lock().await) {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        tracing::debug!("metrics stream stopped");
    });
}

#[tauri::command]
async fn get_status(mgr: tauri::State<'_, manager::Manager>) -> Result<manager::CoreStatus, AppError> {
    let mut mgr = mgr.lock().await;
    Ok(mgr.status())
}

#[tauri::command]
async fn toggle_system_proxy(
    mgr: tauri::State<'_, manager::Manager>,
    app: tauri::AppHandle,
) -> Result<bool, AppError> {
    let mut mgr = mgr.lock().await;

    if !mgr.running {
        return Err(AppError::NotRunning);
    }
    if mgr.proxy_server.is_empty() {
        return Err(AppError::NoSystemProxyServer);
    }

    if mgr.proxy_enabled {
        proxy::set_system_proxy(false, "", "")?;
        mgr.proxy_enabled = false;
    } else {
        proxy::set_system_proxy(true, &mgr.proxy_server, proxy::PROXY_BYPASS)?;
        mgr.proxy_enabled = true;
    }

    tray::update_tray_icon(&app, true, mgr.proxy_enabled);
    let _ = app.emit("core-status-changed", mgr.status());

    Ok(mgr.proxy_enabled)
}

#[tauri::command]
async fn get_proxy_groups(
    grp: tauri::State<'_, groups::Groups>,
) -> Result<Vec<native_api::ProxyGroup>, AppError> {
    let grp = grp.lock().await;
    Ok(grp.groups.clone())
}

#[tauri::command]
async fn switch_proxy(
    grp: tauri::State<'_, groups::Groups>,
    app: tauri::AppHandle,
    group: String,
    node: String,
) -> Result<(), AppError> {
    let mut grp = grp.lock().await;
    grp.switch(&group, &node).await?;
    let _ = app.emit("proxy-groups-updated", &grp.groups);
    Ok(())
}

#[tauri::command]
async fn test_group_delay(
    grp: tauri::State<'_, groups::Groups>,
    group: String,
) -> Result<HashMap<String, i32>, AppError> {
    let client = {
        let grp = grp.lock().await;
        grp.client
            .clone()
            .ok_or_else(|| AppError::ClashApi("not connected".into()))?
    };
    client.test_group_delay(&group).await
}

#[tauri::command]
async fn get_outbound_ip(
    mgr: tauri::State<'_, manager::Manager>,
    grp: tauri::State<'_, groups::Groups>,
) -> Result<Vec<native_api::OutboundIpInfo>, AppError> {
    // Privacy gate (defense-in-depth; the UI also skips the call): the outbound-IP
    // card is opt-in AND only works on a lurixo kernel. When the toggle is off or
    // the installed kernel isn't lurixo, fire NO OutboundTrace gRPC / third-party
    // request — just return an empty result.
    let base_dir = mgr.lock().await.base_dir.clone();
    let settings = settings::load_settings(&base_dir);
    if !settings.outbound_ip_card || !core_update::is_lurixo_kernel(&base_dir) {
        return Ok(Vec::new());
    }
    let client = {
        let grp = grp.lock().await;
        grp.client
            .clone()
            .ok_or_else(|| AppError::ClashApi("not connected".into()))?
    };
    client.get_outbound_ip().await
}

async fn api_client(
    grp: &tauri::State<'_, groups::Groups>,
) -> Result<NativeClient, AppError> {
    grp.lock()
        .await
        .client
        .clone()
        .ok_or_else(|| AppError::ClashApi("not connected".into()))
}

#[tauri::command]
async fn get_clash_mode(
    grp: tauri::State<'_, groups::Groups>,
) -> Result<native_api::ClashModeInfo, AppError> {
    api_client(&grp).await?.get_clash_mode().await
}

#[tauri::command]
async fn set_clash_mode(
    grp: tauri::State<'_, groups::Groups>,
    mode: String,
) -> Result<(), AppError> {
    api_client(&grp).await?.set_clash_mode(&mode).await
}

#[tauri::command]
async fn get_connections(
    grp: tauri::State<'_, groups::Groups>,
) -> Result<Vec<native_api::ConnInfo>, AppError> {
    api_client(&grp).await?.get_connections().await
}

#[tauri::command]
async fn close_connection(
    grp: tauri::State<'_, groups::Groups>,
    id: String,
) -> Result<(), AppError> {
    api_client(&grp).await?.close_connection(&id).await
}

#[tauri::command]
async fn close_all_connections(grp: tauri::State<'_, groups::Groups>) -> Result<(), AppError> {
    api_client(&grp).await?.close_all_connections().await
}

#[tauri::command]
async fn open_base_dir(mgr: tauri::State<'_, manager::Manager>) -> Result<(), AppError> {
    let mgr = mgr.lock().await;
    let dir = mgr.base_dir.clone();
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("explorer").arg(&dir).spawn();
    }
    Ok(())
}

/// Open the folder containing the sing-box core, selecting the exe.
#[tauri::command]
async fn open_core_location(mgr: tauri::State<'_, manager::Manager>) -> Result<(), AppError> {
    let base = mgr.lock().await.base_dir.clone();
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let core = base.join("sing-box.exe");
        // raw_arg so only the path is quoted — `/select,"<path>"` survives spaces.
        let _ = if core.exists() {
            std::process::Command::new("explorer")
                .raw_arg(format!("/select,\"{}\"", core.display()))
                .spawn()
        } else {
            std::process::Command::new("explorer").arg(&base).spawn()
        };
    }
    Ok(())
}

/// Apply a previously staged kernel download: stop the running core (Windows
/// can't replace a running exe), swap the staged binary into place, then
/// relaunch the core if it had been running. Gated behind a user confirmation
/// in the UI (the download itself does not restart anything).
#[tauri::command]
async fn apply_staged_kernel(
    mgr: tauri::State<'_, manager::Manager>,
    grp: tauri::State<'_, groups::Groups>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let was_running = {
        let mut m = mgr.lock().await;
        m.refresh_running();
        let running = m.running;
        if m.proxy_enabled {
            m.proxy_enabled = false;
            let _ = proxy::set_system_proxy(false, "", "");
        }
        if m.running {
            m.stop().await?;
        }
        grp.lock().await.clear();
        let expected = m.staged_core_sha.clone();
        // apply_staged returns the sha of the core it set aside as the rollback
        // backup; hold it in memory so a same-session rollback can re-verify.
        let prev_sha = core_update::apply_staged(&m.base_dir, expected.as_deref())?;
        m.staged_core_sha = None;
        m.prev_core_sha = prev_sha;
        running
    };

    tray::update_tray_icon(&app, false, false);

    if was_running {
        // Bring the core back up on the freshly installed kernel.
        start_core(mgr, grp, app).await.map(|_| ())
    } else {
        let _ = app.emit("core-status-changed", mgr.lock().await.status());
        Ok(())
    }
}

/// Roll the kernel back to the retained previous version: stop the core, swap the
/// backup into place (re-verified against the in-session anchor when present),
/// then relaunch if it had been running. Mirrors `apply_staged_kernel`; the
/// rollback is offered in the UI, never forced.
#[tauri::command]
async fn rollback_kernel(
    mgr: tauri::State<'_, manager::Manager>,
    grp: tauri::State<'_, groups::Groups>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let was_running = {
        let mut m = mgr.lock().await;
        m.refresh_running();
        let running = m.running;
        if m.proxy_enabled {
            m.proxy_enabled = false;
            let _ = proxy::set_system_proxy(false, "", "");
        }
        if m.running {
            m.stop().await?;
        }
        grp.lock().await.clear();
        let expected = m.prev_core_sha.clone();
        // The swap returns the sha of the version we rolled away from (now the
        // backup); re-anchor it so a roll-forward stays verifiable this session.
        let new_prev_sha = core_update::rollback(&m.base_dir, expected.as_deref())?;
        m.prev_core_sha = new_prev_sha;
        running
    };

    tray::update_tray_icon(&app, false, false);

    if was_running {
        start_core(mgr, grp, app).await.map(|_| ())
    } else {
        let _ = app.emit("core-status-changed", mgr.lock().await.status());
        Ok(())
    }
}

/// Drop a staged-but-not-applied kernel download (user cancelled the restart).
#[tauri::command]
async fn discard_staged_kernel(
    mgr: tauri::State<'_, manager::Manager>,
) -> Result<(), AppError> {
    let base_dir = mgr.lock().await.base_dir.clone();
    core_update::discard_staged(&base_dir);
    Ok(())
}

/// Clear cache.db and any leftover downloaded-core artifacts, keeping the
/// in-use core. Refuses while the core runs (cache.db is locked); the UI
/// disables the button in that case too. Returns the number of files removed.
#[tauri::command]
async fn clear_kernel_cache(
    mgr: tauri::State<'_, manager::Manager>,
) -> Result<u32, AppError> {
    let mut m = mgr.lock().await;
    m.refresh_running();
    if m.running {
        return Err(AppError::Update("stop the core before clearing the cache".into()));
    }
    Ok(core_update::clear_cache(&m.base_dir))
}

/// Apply a staged Maestro self-update: swap the app binary, spawn a detached
/// relauncher that waits for this process to exit and starts the new exe, then
/// quit. Gated behind a UI confirmation (the download itself does not restart).
#[tauri::command]
async fn apply_app_update(
    mgr: tauri::State<'_, manager::Manager>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let (base_dir, expected) = {
        let m = mgr.lock().await;
        (m.base_dir.clone(), m.staged_app_sha.clone())
    };
    // apply_staged returns the sha of the exe it set aside as the rollback
    // backup; hold it in memory so a same-session rollback can re-verify.
    let prev_sha = app_update::apply_staged(&base_dir, expected.as_deref())?;
    {
        let mut m = mgr.lock().await;
        m.staged_app_sha = None;
        m.prev_app_sha = prev_sha;
    }
    // New exe is in place and a relauncher is waiting on our exit; quit now
    // (honoring exit-core-on-close) so it can bring the new version up.
    shutdown_and_exit(&app);
    Ok(())
}

/// Roll the PORTABLE app back to the retained previous exe: swap the backup into
/// place (re-verified against the in-session anchor when present), spawn the
/// relauncher, then quit. Mirrors `apply_app_update`; offered, never forced.
#[tauri::command]
async fn rollback_app(
    mgr: tauri::State<'_, manager::Manager>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let (base_dir, expected) = {
        let m = mgr.lock().await;
        (m.base_dir.clone(), m.prev_app_sha.clone())
    };
    let new_prev_sha = app_update::rollback_portable(&base_dir, expected.as_deref())?;
    mgr.lock().await.prev_app_sha = new_prev_sha;
    shutdown_and_exit(&app);
    Ok(())
}

/// Apply a staged installer update (installed/NSIS builds): re-verify the
/// downloaded setup.exe against the in-memory hash, spawn it in passive mode
/// (`/P /R` — small progress window, auto-relaunch), then quit so the installer
/// can replace the running install. The installer carries its own uninstall-and-
/// reinstall logic; Maestro does NOT swap its own exe for installed builds.
#[tauri::command]
async fn apply_installer_update(
    mgr: tauri::State<'_, manager::Manager>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let (base_dir, expected) = {
        let m = mgr.lock().await;
        (m.base_dir.clone(), m.staged_setup_sha.clone())
    };
    // Re-assert this is an installed build (symmetry with apply_staged's guard)
    // and require the in-memory integrity anchor — never run an installer we did
    // not verify this session.
    if !app_update::is_installed(&base_dir) {
        return Err(AppError::Update("not an installed build".into()));
    }
    let expected = expected.ok_or_else(|| {
        AppError::Update("no verified installer staged; download it again".into())
    })?;
    // Keep the deny-write/deny-delete handle (`_guard`) open across spawn so the
    // verified bytes are the executed bytes (closes the verify→execute TOCTOU).
    let (_guard, setup) = app_update::verify_staged_setup(&base_dir, &expected)?;
    // Only AFTER the installer is verified (we're committed to running it) record
    // the version it replaces, so a failed verify doesn't leave a stale rollback
    // record offering a "rollback" to the still-current version. Written while the
    // local build-info still describes THIS version; whether it survives the NSIS
    // reinstall is a real-machine caveat.
    app_update::record_app_rollback(&base_dir);
    app_update::spawn_installer(&setup)?;
    drop(_guard);
    mgr.lock().await.staged_setup_sha = None;
    // The installer waits for us to exit (CheckIfAppIsRunning) and then `/R`
    // relaunches the upgraded app.
    shutdown_and_exit(&app);
    Ok(())
}

/// Disable the system proxy, stop the core, and exit the process. Shared by
/// every quit path: the tray Quit item and the window-close handler when the
/// user has not opted to minimize to tray.
pub fn shutdown_and_exit(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mgr = app.state::<manager::Manager>();
        let mut m = mgr.lock().await;
        // Honor "exit core on close": when off, leave the core (and its system
        // proxy) running in the background and just close the GUI.
        if settings::load_settings(&m.base_dir).exit_core_on_close {
            if m.proxy_enabled {
                m.proxy_enabled = false;
                let _ = proxy::set_system_proxy(false, "", "");
            }
            if m.running {
                let _ = m.stop().await;
            }
        }
        app.exit(0);
    });
}

// ─── App Setup ──────────────────────────────────────────────────────────────

/// Move files from the old flat layout (next to the exe) into `data/` so an
/// in-place upgrade keeps the user's settings, configs and core.
fn migrate_legacy_layout(exe_dir: &std::path::Path, data_dir: &std::path::Path) {
    if exe_dir == data_dir {
        return;
    }
    for name in [
        "settings.json",
        "cache.db",
        "config_runtime.json",
        "launcher-debug.log",
        "sing-box.exe",
        "EnableLoopback.exe",
        "singbox-build-info.json",
        "config.json",
        "configs",
    ] {
        let src = exe_dir.join(name);
        let dst = data_dir.join(name);
        if src.exists() && !dst.exists() {
            let _ = std::fs::rename(&src, &dst);
        }
    }
}

/// Remove core logs left on disk by older builds that persisted them. Logs are
/// now kept only in memory, so any `sing-box.log`(+rotated `.1`/`.2`) is stale
/// and may contain prior-session network destinations — drop it on startup.
fn purge_stale_core_logs(dir: &std::path::Path) {
    for name in ["sing-box.log", "sing-box.log.1", "sing-box.log.2"] {
        let _ = std::fs::remove_file(dir.join(name));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = manager::data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    migrate_legacy_layout(&manager::resolve_base_dir(), &data_dir);
    // Recover from an interrupted apply and drop cross-session staged artifacts
    // (a `.new` from a previous session can no longer be integrity-verified).
    app_update::cleanup_leftovers(&data_dir);
    core_update::cleanup_leftovers(&data_dir);
    // Purge stale on-disk core logs from both the data dir and the legacy
    // flat-layout location (next to the exe), where pre-data/-layout builds
    // wrote them. A direct upgrade from a flat build is the common path, so the
    // old sing-box.log(+rotations) must be cleaned there too — not just migrated.
    purge_stale_core_logs(&data_dir);
    purge_stale_core_logs(&manager::resolve_base_dir());

    let dl = open_debug_log();
    dlog(&dl, &format!("=== Maestro starting (pid {}) ===", std::process::id()));

    let logbus = logbus::LogBus::new();
    {
        use tracing_subscriber::prelude::*;
        let filter = tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| "sing_box_launcher_lib=debug".parse().unwrap());
        tracing_subscriber::registry()
            .with(filter)
            .with(logbus::BusLayer::new(logbus.clone()))
            .init();
    }

    dlog(&dl, "tracing subscriber initialized");

    let base_dir = data_dir;
    config::ensure_configs_dir(&base_dir);
    // Install the crash handler (panic hook + dump context) before the app is
    // built, so a panic anywhere in setup is captured.
    crash::install(base_dir.clone(), logbus.clone());
    dlog(&dl, &format!("base_dir = {}", base_dir.display()));
    info!(base_dir = %base_dir.display(), "starting Maestro");

    // Check if silent start is enabled
    let app_settings = settings::load_settings(&base_dir);
    let silent = app_settings.silent_start;
    let allow_multiple = app_settings.allow_multiple;
    dlog(&dl, &format!("silent_start = {silent}, allow_multiple = {allow_multiple}"));

    // Crash backstop (dormant by default): if enabled, ask WebView2 to skip GPU
    // compositing — must be set before the webview is created.
    if app_settings.disable_gpu_compositing {
        // SAFETY: run() is still single-threaded here (before the Tauri builder,
        // webview, and async runtime start), so mutating the environment is sound.
        unsafe {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu-compositing");
        }
        dlog(&dl, "disable_gpu_compositing on — WebView2 GPU compositing disabled");
    }

    // Autostart (boot) launch: delay the whole app so the desktop stays clear
    // until the network/other services are likely ready. The marker arg is set
    // only on the autostart entry; manual launches don't carry it. Sleeping
    // here — before the UAC relaunch, which forwards only --elevated — delays
    // the app exactly once.
    let autostarted = std::env::args().any(|a| a == "--autostarted");
    if autostarted && app_settings.startup_delay_secs > 0 {
        let d = app_settings.startup_delay_secs.min(3600);
        dlog(&dl, &format!("autostart launch — delaying {d}s before init"));
        std::thread::sleep(std::time::Duration::from_secs(d as u64));
    }

    // Relaunch elevated (UAC) before building the app so the core can use TUN
    if elevation::should_exit_for_elevation(app_settings.run_as_admin) {
        dlog(&dl, "relaunching elevated; exiting unelevated instance");
        std::process::exit(0);
    }

    let mgr = manager::new_manager(base_dir, logbus.clone());
    let grp = groups::new_groups();

    dlog(&dl, "building tauri app...");

    let dl_setup = dl.clone();
    let logbus_setup = logbus.clone();

    // Single-instance guard (unless the user opted into multiple instances):
    // a second launch focuses the existing window instead of opening another.
    let mut builder = tauri::Builder::default();
    if !allow_multiple {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_main(app);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            // Marker arg so the app can detect a boot/autostart launch and apply
            // the configured startup delay (see run() above).
            Some(vec!["--autostarted".into()]),
        ))
        .manage(mgr)
        .manage(grp)
        .manage(logbus)
        .invoke_handler(tauri::generate_handler![
            start_core,
            stop_core,
            restart_core,
            get_status,
            toggle_system_proxy,
            get_proxy_groups,
            switch_proxy,
            test_group_delay,
            get_outbound_ip,
            get_clash_mode,
            set_clash_mode,
            get_connections,
            close_connection,
            close_all_connections,
            open_base_dir,
            open_core_location,
            accent::get_system_accent,
            config::list_configs,
            config::get_config,
            config::save_config,
            config::check_and_format_config,
            config::create_config,
            config::delete_config,
            config::rename_config,
            settings::get_settings,
            settings::set_silent_start,
            settings::set_active_config,
            settings::set_run_as_admin,
            settings::set_log_level,
            settings::set_lang,
            settings::set_allow_multiple,
            settings::set_close_to_tray,
            settings::set_auto_start_core,
            settings::set_exit_core_on_close,
            settings::set_startup_delay,
            settings::set_disable_gpu_compositing,
            settings::set_kernel_source,
            settings::set_kernel_channel,
            settings::set_outbound_ip_card,
            logbus::get_logs,
            logbus::clear_logs,
            logbus::export_logs,
            proxy::enable_uwp_loopback,
            core_update::get_core_info,
            core_update::check_core_update,
            core_update::get_staged_kernel,
            core_update::get_kernel_rollback,
            core_update::download_kernel,
            apply_staged_kernel,
            rollback_kernel,
            discard_staged_kernel,
            clear_kernel_cache,
            app_update::get_app_info,
            app_update::check_app_update,
            app_update::download_app_update,
            app_update::get_staged_app_update,
            app_update::get_app_rollback,
            app_update::discard_app_update,
            app_update::open_releases_page,
            app_update::download_installer_update,
            app_update::download_installer_rollback,
            apply_app_update,
            apply_installer_update,
            rollback_app,
            elevation::is_admin,
        ])
        .setup(move |app| {
            dlog(&dl_setup, "setup: entering closure");
            logbus_setup.attach(app.handle().clone());
            // Surface a crash dump captured in a previous session (if any).
            crash::surface_pending();

            match tray::setup_tray(app.handle()) {
                Ok(_) => dlog(&dl_setup, "setup: tray OK"),
                Err(e) => {
                    dlog(&dl_setup, &format!("setup: tray FAILED: {e}"));
                    return Err(e);
                }
            }

            // Show window only if NOT silent start
            if silent {
                dlog(&dl_setup, "setup: silent start — window hidden");
            } else {
                match app.get_webview_window("main") {
                    Some(w) => {
                        let _ = w.show();
                        dlog(&dl_setup, "setup: window shown");
                    }
                    None => {
                        dlog(&dl_setup, "setup: WARNING main window not found");
                    }
                }
            }

            dlog(&dl_setup, "setup: complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let close_to_tray = settings::load_settings(&manager::data_dir()).close_to_tray;
                if close_to_tray {
                    let _ = window.hide();
                } else {
                    shutdown_and_exit(window.app_handle());
                }
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            dlog(&dl, &format!("tauri::Builder::run() FAILED: {e}"));
            panic!("error running tauri application: {e}");
        });

    dlog(&dl, "run() exiting normally");
}
