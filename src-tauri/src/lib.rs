use tauri::Emitter;
mod accent;
mod clash;
mod config;
mod error;
mod groups;
mod manager;
mod proxy;
mod tray;

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use tauri::Manager;
use tracing::info;

use crate::clash::ClashClient;
use crate::error::AppError;

// ─── Debug file logger (works even with windows_subsystem = "windows") ──────

type DebugWriter = Option<Arc<Mutex<std::fs::File>>>;

fn open_debug_log() -> DebugWriter {
    let dir = manager::resolve_base_dir();
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
    let mut mgr = mgr.lock().await;
    let info = mgr.start().await?;

    tray::update_tray_icon(&app, true, false);
    let _ = app.emit("core-status-changed", mgr.status());

    // Load proxy groups in the background
    let client = ClashClient::new(&info.api_address, &info.api_secret);
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

    Ok(info)
}

#[tauri::command]
async fn stop_core(
    mgr: tauri::State<'_, manager::Manager>,
    grp: tauri::State<'_, groups::Groups>,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    let mut mgr = mgr.lock().await;

    // Disable system proxy if enabled
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
    // Stop
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

    // Start
    start_core(mgr, grp, app).await
}

#[tauri::command]
async fn get_status(mgr: tauri::State<'_, manager::Manager>) -> Result<manager::CoreStatus, AppError> {
    let mgr = mgr.lock().await;
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
) -> Result<Vec<clash::ProxyGroup>, AppError> {
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
    let grp = grp.lock().await;
    grp.test_delay(&group).await
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

// ─── App Setup ──────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Open debug log file FIRST (before anything that could panic)
    let dl = open_debug_log();
    dlog(&dl, &format!("=== sing-box-launcher starting (pid {}) ===", std::process::id()));

    // Initialize tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "sing_box_launcher_lib=debug".parse().unwrap()),
        )
        .init();

    dlog(&dl, "tracing subscriber initialized");

    let base_dir = manager::resolve_base_dir();
    dlog(&dl, &format!("base_dir = {}", base_dir.display()));
    info!(base_dir = %base_dir.display(), "starting sing-box launcher");

    let mgr = manager::new_manager(base_dir);
    let grp = groups::new_groups();

    dlog(&dl, "building tauri app...");

    let dl_setup = dl.clone();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(mgr)
        .manage(grp)
        .invoke_handler(tauri::generate_handler![
            start_core,
            stop_core,
            restart_core,
            get_status,
            toggle_system_proxy,
            get_proxy_groups,
            switch_proxy,
            test_group_delay,
            open_base_dir,
            accent::get_system_accent,
        ])
        .setup(move |app| {
            dlog(&dl_setup, "setup: entering closure");

            // Set up system tray
            match tray::setup_tray(app.handle()) {
                Ok(_) => dlog(&dl_setup, "setup: tray OK"),
                Err(e) => {
                    dlog(&dl_setup, &format!("setup: tray FAILED: {e}"));
                    return Err(e);
                }
            }

            // Show window on startup
            match app.get_webview_window("main") {
                Some(w) => {
                    let _ = w.show();
                    dlog(&dl_setup, "setup: window shown");
                }
                None => {
                    dlog(&dl_setup, "setup: WARNING main window not found");
                }
            }

            dlog(&dl_setup, "setup: complete");
            Ok(())
        })
        .on_window_event(|window, event| {
            // Minimize to tray on close
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| {
            dlog(&dl, &format!("tauri::Builder::run() FAILED: {e}"));
            panic!("error running tauri application: {e}");
        });

    dlog(&dl, "run() exiting normally");
}
