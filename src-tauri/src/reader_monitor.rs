//! Narrow native monitor dimensions for Reader controls, in the WebView's CSS pixels.
use serde::Serialize;

#[derive(Serialize)]
pub struct ReaderMonitorSize {
    width: f64,
    height: f64,
}

#[tauri::command]
pub fn get_reader_monitor_size(window: tauri::WebviewWindow) -> Option<ReaderMonitorSize> {
    let monitor = window.current_monitor().ok()??;
    let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
    Some(ReaderMonitorSize {
        width: size.width,
        height: size.height,
    })
}
