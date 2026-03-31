use tauri::{
use tauri::Emitter;
    image::Image,
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use tracing::error;

use crate::manager;

/// Tray icon colors for different states
const COLOR_STOPPED: (u8, u8, u8) = (150, 150, 150); // gray
const COLOR_RUNNING: (u8, u8, u8) = (29, 185, 84);   // green
const COLOR_PROXY: (u8, u8, u8) = (0, 120, 212);     // blue (Windows accent)

/// Build and register the system tray
pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItemBuilder::with_id("show", "Show Window").build(app)?;
    let start = MenuItemBuilder::with_id("start", "Start").build(app)?;
    let stop = MenuItemBuilder::with_id("stop", "Stop").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&start)
        .item(&stop)
        .separator()
        .item(&quit)
        .build()?;

    let icon = make_icon(COLOR_STOPPED.0, COLOR_STOPPED.1, COLOR_STOPPED.2);

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("sing-box launcher")
        .menu(&menu)
        .on_menu_event(move |app, event| {
            let app = app.clone();
            match event.id().as_ref() {
                "show" => {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
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
                        // Clean up before exit
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
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;

    Ok(())
}

/// Update tray icon color based on state
pub fn update_tray_icon(app: &AppHandle, running: bool, proxy_enabled: bool) {
    let (r, g, b) = if !running {
        COLOR_STOPPED
    } else if proxy_enabled {
        COLOR_PROXY
    } else {
        COLOR_RUNNING
    };

    let icon = make_icon(r, g, b);
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_icon(Some(icon));
        let tooltip = if !running {
            "sing-box launcher — stopped"
        } else if proxy_enabled {
            "sing-box launcher — proxy enabled"
        } else {
            "sing-box launcher — running"
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

/// Generate a solid-color circular icon as an Image
fn make_icon(r: u8, g: u8, b: u8) -> Image<'static> {
    const SIZE: usize = 64;
    let mut rgba = vec![0u8; SIZE * SIZE * 4];

    let cx = SIZE as f64 / 2.0;
    let cy = SIZE as f64 / 2.0;
    let rad = SIZE as f64 / 2.0 - 4.0;

    for y in 0..SIZE {
        for x in 0..SIZE {
            let dx = x as f64 - cx + 0.5;
            let dy = y as f64 - cy + 0.5;
            let d2 = dx * dx + dy * dy;

            let offset = (y * SIZE + x) * 4;
            if d2 <= rad * rad {
                rgba[offset] = r;
                rgba[offset + 1] = g;
                rgba[offset + 2] = b;
                rgba[offset + 3] = 255;
            } else if d2 <= (rad + 1.5) * (rad + 1.5) {
                rgba[offset] = r;
                rgba[offset + 1] = g;
                rgba[offset + 2] = b;
                rgba[offset + 3] = 128;
            }
        }
    }

    Image::new_owned(rgba, SIZE as u32, SIZE as u32)
}
