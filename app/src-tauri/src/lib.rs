/// LEGION: начальный serial-порт из переменной окружения LEGION_PORT.
/// Легитимный хук для автоматизации/тестов и headless-сценариев.
#[tauri::command]
fn legion_default_port() -> Option<String> {
  std::env::var("LEGION_PORT").ok().filter(|v| !v.is_empty())
}

#[cfg(debug_assertions)]
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    // LEGION: USB-UART транспорт к ESP32 (факт T2: serialplugin v3 + serialport 4.5)
    .plugin(tauri_plugin_serialplugin::init())
    .invoke_handler(tauri::generate_handler![legion_default_port])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      // DEV: авто-открытие DevTools (только debug-сборки; cfg-gated, т.к.
      // get_webview_window требует трейт Manager — импорт тоже cfg-gated)
      #[cfg(debug_assertions)]
      if let Some(w) = app.get_webview_window("main") {
        w.open_devtools();
      }
      let _ = app;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
