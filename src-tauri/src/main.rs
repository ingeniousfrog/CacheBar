mod core;
mod tray_icon;

use core::{
    AnalysisNode, CleanResult, CleanScanResult, OptimizeResult, StatusSnapshot, UninstallResult,
};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, PhysicalPosition, WindowEvent, Wry};

struct PanelState {
    auto_hide: AtomicBool,
}

/// Panel corner radius — keep in sync with `rounded-[26px]` in App.tsx / styles.css.
#[cfg(target_os = "macos")]
const PANEL_CORNER_RADIUS: f64 = 26.0;

/// Clip the native window + WKWebView to a rounded rect so corner pixels are not
/// the default white WKWebView background. Requires `macOSPrivateApi` in
/// tauri.conf.json and the `macos-private-api` Cargo feature.
#[cfg(target_os = "macos")]
fn round_macos_window(window: &tauri::WebviewWindow<Wry>) {
    use cocoa::appkit::NSColor;
    use cocoa::base::{id, nil, NO, YES};
    use cocoa::foundation::NSString;
    use objc::{class, msg_send, sel, sel_impl};
    use tauri::utils::config::WindowEffectsConfig;
    use tauri::window::{Effect, EffectState};

    let _ = window.set_effects(Some(WindowEffectsConfig {
        effects: vec![Effect::WindowBackground],
        state: Some(EffectState::Active),
        radius: Some(PANEL_CORNER_RADIUS),
        color: None,
    }));

    let Ok(ns_window_ptr) = window.ns_window() else {
        return;
    };
    let ns_window = ns_window_ptr as id;
    let radius = PANEL_CORNER_RADIUS;

    unsafe {
        let _: () = msg_send![ns_window, setOpaque: NO];
        let _: () = msg_send![ns_window, setBackgroundColor: NSColor::clearColor(nil)];
        let _: () = msg_send![ns_window, setHasShadow: YES];

        let content_view: id = msg_send![ns_window, contentView];
        round_macos_view_tree(content_view, radius);
    }

    let _ = window.with_webview(move |platform_webview| {
        let webview = platform_webview.inner() as id;
        if webview.is_null() {
            return;
        }
        unsafe {
            let _: () = msg_send![webview, setOpaque: NO];
            let no: id = msg_send![class!(NSNumber), numberWithBool:0];
            let draws_key = NSString::alloc(nil).init_str("drawsBackground");
            let _: () = msg_send![webview, setValue:no forKey:draws_key];
            round_macos_view_tree(webview, radius);
        }
    });
}

#[cfg(target_os = "macos")]
unsafe fn round_macos_view_tree(view: cocoa::base::id, radius: f64) {
    use cocoa::appkit::NSColor;
    use cocoa::base::{id, nil, YES};
    use objc::{msg_send, sel, sel_impl};

    if view == nil {
        return;
    }

    let _: () = msg_send![view, setWantsLayer: YES];
    let layer: id = msg_send![view, layer];
    if layer != nil {
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMasksToBounds: YES];
        let clear: id = msg_send![NSColor::clearColor(nil), CGColor];
        let _: () = msg_send![layer, setBackgroundColor: clear];
    }

    let subviews: id = msg_send![view, subviews];
    let count: usize = msg_send![subviews, count];
    for index in 0..count {
        let child: id = msg_send![subviews, objectAtIndex: index];
        round_macos_view_tree(child, radius);
    }
}

#[tauri::command]
fn status() -> Result<StatusSnapshot, String> {
    core::status::status()
}

#[tauri::command]
fn scan_clean_targets() -> Result<CleanScanResult, String> {
    core::clean::scan_clean_targets()
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(target_os = "linux")]
    let program = "xdg-open";
    #[cfg(target_os = "windows")]
    let program = "cmd";

    let mut command = Command::new(program);
    #[cfg(target_os = "windows")]
    command.args(["/C", "start", "", &url]);
    #[cfg(not(target_os = "windows"))]
    command.arg(&url);

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("Unable to open URL: {err}"))
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

            let icon = tray_icon::load_tray_icon()?;

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
                #[cfg(target_os = "macos")]
                round_macos_window(&window);

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
            set_panel_auto_hide,
            open_url
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

    let panel_width = 380.0;
    let panel_height = 620.0;
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
    #[cfg(target_os = "macos")]
    round_macos_window(&window);
    let _ = window.show();
    let _ = window.set_focus();
}
