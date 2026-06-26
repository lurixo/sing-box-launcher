use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};
use tracing::error;

use crate::manager;

const TOOLTIP: &str = "sing-box launcher";

/// Minimal tray-menu localization — the app's only Rust-side i18n.
fn tr(lang: &str, key: &str) -> &'static str {
    let zh = lang == "zh-CN";
    match key {
        "show" => if zh { "显示窗口" } else { "Show Window" },
        "start" => if zh { "启动" } else { "Start" },
        "stop" => if zh { "停止" } else { "Stop" },
        "connections" => if zh { "活动连接" } else { "Active Connections" },
        "quit" => if zh { "退出" } else { "Quit" },
        "tip.stopped" => if zh { "sing-box launcher — 已停止" } else { "sing-box launcher — stopped" },
        "tip.proxy" => if zh { "sing-box launcher — 代理已启用" } else { "sing-box launcher — proxy enabled" },
        "tip.running" => if zh { "sing-box launcher — 运行中" } else { "sing-box launcher — running" },
        _ => "",
    }
}

/// The current UI language, read from persisted settings (defaults to zh-CN).
fn current_lang() -> String {
    crate::settings::load_settings(&manager::data_dir()).lang
}

/// Build the tray menu in the given language.
fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItemBuilder::with_id("show", tr(lang, "show")).build(app)?;
    let start = MenuItemBuilder::with_id("start", tr(lang, "start")).build(app)?;
    let stop = MenuItemBuilder::with_id("stop", tr(lang, "stop")).build(app)?;
    let connections = MenuItemBuilder::with_id("connections", tr(lang, "connections")).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", tr(lang, "quit")).build(app)?;

    MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&start)
        .item(&stop)
        .separator()
        .item(&connections)
        .separator()
        .item(&quit)
        .build()
}

/// Show and focus the main window.
fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Build and register the system tray.
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let lang = current_lang();
    let menu = build_menu(app, &lang)?;

    TrayIconBuilder::with_id("main-tray")
        .icon(tauri::include_image!("icons/32x32.png"))
        .tooltip(TOOLTIP)
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "show" => show_main(&app),
                "connections" => {
                    show_main(&app);
                    let _ = app.emit("navigate", "connections");
                }
                "start" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let mgr = app.state::<crate::manager::Manager>();
                        let mut mgr = mgr.lock().await;
                        if let Err(e) = mgr.start().await {
                            error!(error = %e, "tray start failed");
                        } else {
                            update_tray_icon(&app, true, false);
                            let _ = app.emit("core-status-changed", mgr.status());
                        }
                    });
                }
                "stop" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let mgr = app.state::<crate::manager::Manager>();
                        let mut mgr = mgr.lock().await;
                        if mgr.proxy_enabled {
                            mgr.proxy_enabled = false;
                            let _ = crate::proxy::set_system_proxy(false, "", "");
                        }
                        if let Err(e) = mgr.stop().await {
                            error!(error = %e, "tray stop failed");
                        }
                        let groups = app.state::<crate::groups::Groups>();
                        groups.lock().await.clear();
                        update_tray_icon(&app, false, false);
                        let _ = app.emit("core-status-changed", mgr.status());
                    });
                }
                "quit" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let mgr = app.state::<crate::manager::Manager>();
                        let mut mgr = mgr.lock().await;
                        if mgr.proxy_enabled {
                            mgr.proxy_enabled = false;
                            let _ = crate::proxy::set_system_proxy(false, "", "");
                        }
                        if mgr.running {
                            let _ = mgr.stop().await;
                        }
                        app.exit(0);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

/// Re-label the tray menu after a language change.
pub fn rebuild_tray_menu(app: &AppHandle, lang: &str) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_menu(app, lang) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Update the tray tooltip to reflect the current state. The branded icon is
/// fixed; only the tooltip text (and its language) changes.
pub fn update_tray_icon(app: &AppHandle, running: bool, proxy_enabled: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let lang = current_lang();
        let key = if !running {
            "tip.stopped"
        } else if proxy_enabled {
            "tip.proxy"
        } else {
            "tip.running"
        };
        let _ = tray.set_tooltip(Some(tr(&lang, key)));
    }
}
