use tauri::Emitter;
mod accent;
mod config;
mod core_update;
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
                    while let Ok(Some(st)) = stream.message().await {
                        let _ = app.emit("metrics-tick", native_api::map_status(st));
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

    if !mgr.running || mgr.proxy_server.is_empty() {
        return Err(AppError::NotRunning);
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
    grp: tauri::State<'_, groups::Groups>,
) -> Result<Vec<native_api::OutboundIpInfo>, AppError> {
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

/// Disable the system proxy, stop the core, and exit the process. Shared by
/// every quit path: the tray Quit item and the window-close handler when the
/// user has not opted to minimize to tray.
pub fn shutdown_and_exit(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mgr = app.state::<manager::Manager>();
        let mut m = mgr.lock().await;
        if m.proxy_enabled {
            m.proxy_enabled = false;
            let _ = proxy::set_system_proxy(false, "", "");
        }
        if m.running {
            let _ = m.stop().await;
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
        "sing-box.log",
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let data_dir = manager::data_dir();
    let _ = std::fs::create_dir_all(&data_dir);
    migrate_legacy_layout(&manager::resolve_base_dir(), &data_dir);

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
    dlog(&dl, &format!("base_dir = {}", base_dir.display()));
    info!(base_dir = %base_dir.display(), "starting Maestro");

    // Check if silent start is enabled
    let app_settings = settings::load_settings(&base_dir);
    let silent = app_settings.silent_start;
    let allow_multiple = app_settings.allow_multiple;
    dlog(&dl, &format!("silent_start = {silent}, allow_multiple = {allow_multiple}"));

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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
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
            settings::set_log_persist,
            settings::set_lang,
            settings::set_allow_multiple,
            settings::set_close_to_tray,
            logbus::get_logs,
            logbus::clear_logs,
            proxy::enable_uwp_loopback,
            core_update::get_core_info,
            core_update::check_core_update,
            core_update::update_core,
            elevation::is_admin,
        ])
        .setup(move |app| {
            dlog(&dl_setup, "setup: entering closure");
            logbus_setup.attach(app.handle().clone());

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
