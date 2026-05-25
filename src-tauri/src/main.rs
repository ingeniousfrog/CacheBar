mod core;

use core::{
    AnalysisNode, CleanEntry, CleanResult, OptimizeResult, StatusSnapshot, UninstallResult,
};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WindowEvent, Wry};

struct PanelState {
    auto_hide: AtomicBool,
}

#[tauri::command]
fn status() -> Result<StatusSnapshot, String> {
    core::status::status()
}

#[tauri::command]
fn scan_clean_targets() -> Result<Vec<CleanEntry>, String> {
    core::clean::scan_clean_targets()
}

#[tauri::command]
fn clean_selected(paths: Vec<String>) -> Result<CleanResult, String> {
    core::clean::clean_selected(paths)
}

#[tauri::command]
fn uninstall(app_path: String) -> Result<UninstallResult, String> {
    core::uninstall::uninstall(app_path)
}

#[tauri::command]
fn optimize() -> OptimizeResult {
    core::optimize::optimize()
}

#[tauri::command]
fn analyse(path: String) -> Result<Vec<AnalysisNode>, String> {
    core::analyse::analyse(path)
}

#[tauri::command]
fn quit_app(app: AppHandle<Wry>) {
    app.exit(0);
}

#[tauri::command]
fn set_panel_auto_hide(app: AppHandle<Wry>, enabled: bool) {
    app.state::<PanelState>()
        .auto_hide
        .store(enabled, Ordering::Relaxed);
}

fn main() {
    tauri::Builder::default()
        .manage(PanelState {
            auto_hide: AtomicBool::new(true),
        })
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let icon = Image::from_bytes(include_bytes!("../icons/icon.png"))?;

            TrayIconBuilder::with_id("cachebar")
                .icon(icon)
                .tooltip("CacheBar")
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle(), position);
                    }
                })
                .build(app)?;

            if let Some(window) = app.get_webview_window("main") {
                let panel = window.clone();
                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    let should_auto_hide = app_handle
                        .state::<PanelState>()
                        .auto_hide
                        .load(Ordering::Relaxed);
                    if should_auto_hide && matches!(event, WindowEvent::Focused(false)) {
                        let _ = panel.hide();
                    }
                });
                let _ = window.hide();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            status,
            scan_clean_targets,
            clean_selected,
            uninstall,
            optimize,
            analyse,
            quit_app,
            set_panel_auto_hide
        ])
        .run(tauri::generate_context!())
        .expect("failed to run CacheBar");
}

fn toggle_panel(app: &AppHandle<Wry>, position: PhysicalPosition<f64>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };

    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }

    let panel_width = 430.0;
    let panel_height = 760.0;
    let mut x = (position.x - panel_width / 2.0).max(8.0);
    let mut y = (position.y + 10.0).max(8.0);

    if let Ok(Some(monitor)) = window.current_monitor() {
        let monitor_origin = monitor.position();
        let monitor_size = monitor.size();
        let max_x = monitor_origin.x as f64 + monitor_size.width as f64 - panel_width - 8.0;
        let max_y = monitor_origin.y as f64 + monitor_size.height as f64 - panel_height - 8.0;
        x = x.min(max_x.max(8.0));
        y = y.min(max_y.max(8.0));
    }

    let _ = window.set_position(PhysicalPosition::new(x, y));
    let _ = window.show();
    let _ = window.set_focus();
}
