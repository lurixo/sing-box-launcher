use tauri::{
    menu::{Menu, MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

use crate::manager;

const TOOLTIP: &str = "Maestro";

/// Minimal tray-menu localization — the app's only Rust-side i18n.
fn tr(lang: &str, key: &str) -> &'static str {
    let zh = lang == "zh-CN";
    match key {
        "stop" => if zh { "停止内核" } else { "Stop Core" },
        "start" => if zh { "启动内核" } else { "Start Core" },
        "connections" => if zh { "活动连接" } else { "Active Connections" },
        "restart" => if zh { "重启" } else { "Restart" },
        "quit" => if zh { "退出" } else { "Quit" },
        "tip.stopped" => if zh { "Maestro — 已停止" } else { "Maestro — stopped" },
        "tip.proxy" => if zh { "Maestro — 代理已启用" } else { "Maestro — proxy enabled" },
        "tip.running" => if zh { "Maestro — 运行中" } else { "Maestro — running" },
        _ => "",
    }
}

/// The current UI language, read from persisted settings (defaults to zh-CN).
fn current_lang() -> String {
    crate::settings::load_settings(&manager::data_dir()).lang
}

/// Build the tray (right-click) menu in the given language. Order top→bottom:
/// stop / start / connections / restart / quit. Left-click raises the window
/// instead of opening this menu, so there is no "show window" item.
fn build_menu(app: &AppHandle, lang: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let stop = MenuItemBuilder::with_id("stop", tr(lang, "stop")).build(app)?;
    let start = MenuItemBuilder::with_id("start", tr(lang, "start")).build(app)?;
    let connections = MenuItemBuilder::with_id("connections", tr(lang, "connections")).build(app)?;
    let restart = MenuItemBuilder::with_id("restart", tr(lang, "restart")).build(app)?;
    let quit = MenuItemBuilder::with_id("quit", tr(lang, "quit")).build(app)?;

    MenuBuilder::new(app)
        .item(&stop)
        .item(&start)
        .item(&connections)
        .item(&restart)
        .separator()
        .item(&quit)
        .build()
}

/// Show, un-minimize and bring the main window to the foreground. The
/// un-minimize + brief topmost toggle is required on Windows: `show()` alone
/// does not restore a window the user minimized to the taskbar.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.set_always_on_top(true);
        let _ = w.set_always_on_top(false);
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
        // Left-click raises the window (see on_tray_icon_event); the context
        // menu opens only on right-click.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                // Route core control through the frontend so the full start flow
                // (metrics + group streams) runs, not just a bare process spawn.
                "start" => { let _ = app.emit("tray-action", "start"); }
                "stop" => { let _ = app.emit("tray-action", "stop"); }
                "restart" => {
                    // Surface the window so the stop→start transition is visible.
                    show_main(&app);
                    let _ = app.emit("tray-action", "restart");
                }
                "connections" => {
                    show_main(&app);
                    let _ = app.emit("navigate", "connections");
                }
                "quit" => crate::shutdown_and_exit(&app),
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
