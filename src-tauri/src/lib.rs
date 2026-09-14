mod pdf_ops;

use std::path::{Path, PathBuf};
use tauri::Emitter;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn pdf_page_count(input: String) -> Result<u32, String> {
    pdf_ops::page_count(Path::new(&input))
}

#[tauri::command]
fn pdf_merge(inputs: Vec<String>, output: String) -> Result<(), String> {
    let paths: Vec<PathBuf> = inputs.into_iter().map(PathBuf::from).collect();
    pdf_ops::merge(&paths, Path::new(&output))
}

#[tauri::command]
fn pdf_extract(input: String, output: String, pages: String) -> Result<(), String> {
    pdf_ops::extract(Path::new(&input), Path::new(&output), &pages)
}

#[tauri::command]
fn pdf_rotate(
    input: String,
    output: String,
    pages: Option<Vec<u32>>,
    degrees: i64,
) -> Result<(), String> {
    pdf_ops::rotate(Path::new(&input), Path::new(&output), pages.as_deref(), degrees)
}

#[tauri::command]
fn pdf_delete_pages(input: String, output: String, pages: Vec<u32>) -> Result<(), String> {
    pdf_ops::delete(Path::new(&input), Path::new(&output), &pages)
}

#[tauri::command]
fn pdf_reorder(input: String, output: String, order: Vec<u32>) -> Result<(), String> {
    pdf_ops::reorder(Path::new(&input), Path::new(&output), &order)
}

#[tauri::command]
async fn convert_to_word(app: tauri::AppHandle, input: String, output: String) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("pdf-engine")
        .map_err(|e| e.to_string())?
        .args(["convert", &input, &output])
        .spawn()
        .map_err(|e| e.to_string())?;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                for line in String::from_utf8_lossy(&bytes).lines() {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                        let _ = app.emit("pdf-convert-progress", value);
                    }
                }
            }
            CommandEvent::Error(err) => return Err(err),
            CommandEvent::Terminated(payload) => {
                if payload.code != Some(0) {
                    return Err(format!("pdf-engine exited with code {:?}", payload.code));
                }
            }
            _ => {}
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            greet,
            pdf_page_count,
            pdf_merge,
            pdf_extract,
            pdf_rotate,
            pdf_delete_pages,
            pdf_reorder,
            convert_to_word,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
