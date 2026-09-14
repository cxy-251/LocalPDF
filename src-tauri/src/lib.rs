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

/// macOS's file picker can't be drilled into a `.app` bundle (it's a package,
/// selectable only as a whole), so users naturally end up picking
/// "LibreOffice.app" itself rather than the real binary inside it. Resolve
/// that automatically instead of asking the user to find the hidden path.
fn resolve_soffice_binary(path: &Path) -> PathBuf {
    if path.extension().and_then(|e| e.to_str()) == Some("app") {
        path.join("Contents/MacOS/soffice")
    } else {
        path.to_path_buf()
    }
}

/// Converts via a user-supplied LibreOffice install (never bundled with the
/// app). LibreOffice only lets you pick an output *directory*, not an exact
/// filename, so we let it write its own name and then move the result to
/// the requested `output` path.
#[tauri::command]
async fn convert_to_word_libreoffice(
    app: tauri::AppHandle,
    soffice_path: String,
    input: String,
    output: String,
) -> Result<(), String> {
    let input_path = Path::new(&input);
    let output_path = Path::new(&output);
    let out_dir = output_path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    let stem = input_path
        .file_stem()
        .ok_or("invalid input path")?
        .to_string_lossy()
        .to_string();

    let soffice_bin = resolve_soffice_binary(Path::new(&soffice_path));
    if !soffice_bin.exists() {
        return Err(format!(
            "在 {} 找不到 LibreOffice 可执行文件，请确认选择的是 LibreOffice.app 或 soffice 本体",
            soffice_bin.display()
        ));
    }

    let args = vec![
        "--headless".to_string(),
        "--infilter=writer_pdf_import".to_string(),
        "--convert-to".to_string(),
        "docx:MS Word 2007 XML".to_string(),
        "--outdir".to_string(),
        out_dir.to_string_lossy().to_string(),
        input.clone(),
    ];

    let result = app
        .shell()
        .command(&soffice_bin)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to launch LibreOffice at {}: {e}", soffice_bin.display()))?;

    if !result.status.success() {
        return Err(format!(
            "LibreOffice exited with {:?}: {}",
            result.status.code(),
            String::from_utf8_lossy(&result.stderr)
        ));
    }

    let produced = out_dir.join(format!("{stem}.docx"));
    if produced != output_path {
        std::fs::rename(&produced, output_path)
            .map_err(|e| format!("failed to move converted file: {e}"))?;
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
            convert_to_word_libreoffice,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
