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
fn pdf_crop(
    input: String,
    output: String,
    pages: Option<Vec<u32>>,
    crop_box: [f64; 4],
) -> Result<(), String> {
    pdf_ops::crop(Path::new(&input), Path::new(&output), pages.as_deref(), crop_box)
}

#[tauri::command]
fn pdf_delete_pages(input: String, output: String, pages: Vec<u32>) -> Result<(), String> {
    pdf_ops::delete(Path::new(&input), Path::new(&output), &pages)
}

#[tauri::command]
fn pdf_reorder(input: String, output: String, order: Vec<u32>) -> Result<(), String> {
    pdf_ops::reorder(Path::new(&input), Path::new(&output), &order)
}

/// Spawns the bundled Python engine sidecar with the given CLI args,
/// forwarding each JSON line it prints on stdout as a `pdf-convert-progress`
/// event so the frontend can show live status.
async fn run_pdf_engine(app: &tauri::AppHandle, args: Vec<String>) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .sidecar("pdf-engine")
        .map_err(|e| e.to_string())?
        .args(args)
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

#[tauri::command]
async fn convert_to_word(app: tauri::AppHandle, input: String, output: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["convert".into(), input, output]).await
}

#[tauri::command]
async fn pdf_to_images(
    app: tauri::AppHandle,
    input: String,
    out_dir: String,
    format: Option<String>,
    dpi: Option<u32>,
) -> Result<(), String> {
    let mut args = vec!["to-images".to_string(), input, out_dir];
    if let Some(f) = format {
        args.push("--format".into());
        args.push(f);
    }
    if let Some(d) = dpi {
        args.push("--dpi".into());
        args.push(d.to_string());
    }
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn images_to_pdf(app: tauri::AppHandle, output: String, images: Vec<String>) -> Result<(), String> {
    let mut args = vec!["from-images".to_string(), output];
    args.extend(images);
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn pdf_compress(app: tauri::AppHandle, input: String, output: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["compress".into(), input, output]).await
}

#[tauri::command]
async fn pdf_watermark(
    app: tauri::AppHandle,
    input: String,
    output: String,
    text: String,
    opacity: Option<f64>,
    font_size: Option<f64>,
    angle: Option<f64>,
) -> Result<(), String> {
    let mut args = vec!["watermark".to_string(), input, output, "--text".to_string(), text];
    if let Some(o) = opacity {
        args.push("--opacity".into());
        args.push(o.to_string());
    }
    if let Some(f) = font_size {
        args.push("--font-size".into());
        args.push(f.to_string());
    }
    if let Some(a) = angle {
        args.push("--angle".into());
        args.push(a.to_string());
    }
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn pdf_page_numbers(
    app: tauri::AppHandle,
    input: String,
    output: String,
    start: Option<i64>,
    position: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["page-numbers".to_string(), input, output];
    if let Some(s) = start {
        args.push("--start".into());
        args.push(s.to_string());
    }
    if let Some(p) = position {
        args.push("--position".into());
        args.push(p);
    }
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn pdf_encrypt(
    app: tauri::AppHandle,
    input: String,
    output: String,
    user_password: String,
    owner_password: Option<String>,
) -> Result<(), String> {
    let mut args = vec![
        "encrypt".to_string(),
        input,
        output,
        "--user-password".to_string(),
        user_password,
    ];
    if let Some(p) = owner_password {
        args.push("--owner-password".into());
        args.push(p);
    }
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn pdf_decrypt(app: tauri::AppHandle, input: String, output: String, password: String) -> Result<(), String> {
    run_pdf_engine(
        &app,
        vec!["decrypt".into(), input, output, "--password".into(), password],
    )
    .await
}

#[tauri::command]
async fn pdf_redact(app: tauri::AppHandle, input: String, output: String, regions: String) -> Result<(), String> {
    run_pdf_engine(
        &app,
        vec!["redact".into(), input, output, "--regions".into(), regions],
    )
    .await
}

#[tauri::command]
async fn pdf_split(
    app: tauri::AppHandle,
    input: String,
    out_dir: String,
    pages_per_file: Option<u32>,
) -> Result<(), String> {
    let mut args = vec!["split".to_string(), input, out_dir];
    if let Some(n) = pages_per_file {
        args.push("--pages-per-file".into());
        args.push(n.to_string());
    }
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn pdf_extract_text(app: tauri::AppHandle, input: String, output: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["extract-text".into(), input, output]).await
}

#[tauri::command]
async fn pdf_extract_images(app: tauri::AppHandle, input: String, out_dir: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["extract-images".into(), input, out_dir]).await
}

#[tauri::command]
async fn pdf_get_metadata(app: tauri::AppHandle, input: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["get-metadata".into(), input]).await
}

#[tauri::command]
async fn pdf_set_metadata(
    app: tauri::AppHandle,
    input: String,
    output: String,
    title: Option<String>,
    author: Option<String>,
    subject: Option<String>,
    keywords: Option<String>,
) -> Result<(), String> {
    let mut args = vec!["set-metadata".to_string(), input, output];
    if let Some(v) = title {
        args.push("--title".into());
        args.push(v);
    }
    if let Some(v) = author {
        args.push("--author".into());
        args.push(v);
    }
    if let Some(v) = subject {
        args.push("--subject".into());
        args.push(v);
    }
    if let Some(v) = keywords {
        args.push("--keywords".into());
        args.push(v);
    }
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn pdf_get_toc(app: tauri::AppHandle, input: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["get-toc".into(), input]).await
}

#[tauri::command]
async fn pdf_set_toc(app: tauri::AppHandle, input: String, output: String, toc: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["set-toc".into(), input, output, "--toc".into(), toc]).await
}

#[tauri::command]
async fn pdf_grayscale(app: tauri::AppHandle, input: String, output: String, dpi: Option<u32>) -> Result<(), String> {
    let mut args = vec!["grayscale".to_string(), input, output];
    if let Some(d) = dpi {
        args.push("--dpi".into());
        args.push(d.to_string());
    }
    run_pdf_engine(&app, args).await
}

#[tauri::command]
async fn pdf_remove_blank_pages(app: tauri::AppHandle, input: String, output: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["remove-blank-pages".into(), input, output]).await
}

#[tauri::command]
async fn pdf_unify_page_size(
    app: tauri::AppHandle,
    input: String,
    output: String,
    width: f64,
    height: f64,
) -> Result<(), String> {
    run_pdf_engine(
        &app,
        vec![
            "unify-page-size".into(),
            input,
            output,
            "--width".into(),
            width.to_string(),
            "--height".into(),
            height.to_string(),
        ],
    )
    .await
}

#[tauri::command]
async fn pdf_strip_text(app: tauri::AppHandle, input: String, output: String, text: String) -> Result<(), String> {
    run_pdf_engine(&app, vec!["strip-text".into(), input, output, "--text".into(), text]).await
}

/// macOS's file picker can't be drilled into a `.app` bundle (it's a
/// package, selectable only as a whole), so users naturally end up picking
/// e.g. "LibreOffice.app" or "Google Chrome.app" rather than the real
/// binary hidden inside it. Resolve that automatically via the bundle's own
/// Info.plist (CFBundleExecutable) — the authoritative name macOS itself
/// uses to launch the app.
///
/// This used to just take "the sole file under Contents/MacOS", which broke
/// LibreOffice specifically: its bundle has 9+ helper binaries in there
/// (gengal, regview, uno, xpdfimport, ...), and `read_dir` order isn't
/// alphabetical or otherwise guaranteed — in practice it picked `regview`
/// instead of `soffice`, which macOS then SIGKILLed as an invalid code
/// signature the moment it was spawned standalone with soffice's args.
/// Chrome/Edge only happened to have one file there, which is why that case
/// worked and this one didn't.
fn resolve_app_binary(path: &Path) -> PathBuf {
    if path.extension().and_then(|e| e.to_str()) != Some("app") {
        return path.to_path_buf();
    }
    let info_plist = path.join("Contents/Info.plist");
    if let Ok(output) = std::process::Command::new("plutil")
        .args(["-extract", "CFBundleExecutable", "raw"])
        .arg(&info_plist)
        .output()
    {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !name.is_empty() {
                return path.join("Contents/MacOS").join(name);
            }
        }
    }
    // Fallback for the unlikely case plutil is unavailable: bundles with a
    // single executable under Contents/MacOS (true for Chrome/Edge) still
    // resolve correctly this way.
    let macos_dir = path.join("Contents/MacOS");
    if let Ok(entries) = std::fs::read_dir(&macos_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                return p;
            }
        }
    }
    macos_dir
}

/// Converts via a user-supplied LibreOffice install (never bundled with the
/// app). LibreOffice only lets you pick an output *directory*, not an exact
/// filename, so we let it write its own name and then move the result to
/// the requested `output` path. `infilter` forces the import filter (needed
/// to open a PDF as an editable Writer document instead of Draw); leave it
/// `None` for normal Office-format inputs, which LibreOffice already detects
/// correctly on its own.
async fn run_libreoffice_convert(
    app: &tauri::AppHandle,
    soffice_path: &str,
    input: &str,
    output: &str,
    convert_to: &str,
    infilter: Option<&str>,
) -> Result<(), String> {
    let input_path = Path::new(input);
    let output_path = Path::new(output);
    let out_dir = output_path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let stem = input_path
        .file_stem()
        .ok_or("invalid input path")?
        .to_string_lossy()
        .to_string();
    let out_ext = convert_to.split(':').next().unwrap_or(convert_to);

    let soffice_bin = resolve_app_binary(Path::new(soffice_path));
    if !soffice_bin.exists() {
        return Err(format!(
            "在 {} 找不到 LibreOffice 可执行文件，请确认选择的是 LibreOffice.app 或 soffice 本体",
            soffice_bin.display()
        ));
    }

    let mut args = vec!["--headless".to_string()];
    if let Some(f) = infilter {
        args.push(format!("--infilter={f}"));
    }
    args.push("--convert-to".to_string());
    args.push(convert_to.to_string());
    args.push("--outdir".to_string());
    args.push(out_dir.to_string_lossy().to_string());
    args.push(input.to_string());

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

    let produced = out_dir.join(format!("{stem}.{out_ext}"));
    if produced != output_path {
        std::fs::rename(&produced, output_path)
            .map_err(|e| format!("failed to move converted file: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
async fn convert_to_word_libreoffice(
    app: tauri::AppHandle,
    soffice_path: String,
    input: String,
    output: String,
) -> Result<(), String> {
    run_libreoffice_convert(
        &app,
        &soffice_path,
        &input,
        &output,
        "docx:MS Word 2007 XML",
        Some("writer_pdf_import"),
    )
    .await
}

/// Word/PowerPoint/Excel -> PDF. Unlike the PDF-import direction, this is
/// LibreOffice's actual strong suit (no infilter trick needed, no text-box
/// fallback quality issue).
#[tauri::command]
async fn convert_office_to_pdf(
    app: tauri::AppHandle,
    soffice_path: String,
    input: String,
    output: String,
) -> Result<(), String> {
    run_libreoffice_convert(&app, &soffice_path, &input, &output, "pdf", None).await
}

/// Renders a URL (or local .html file path) to PDF via a user-supplied
/// Chromium-family browser's own headless printing — never bundled, same
/// "bring your own" pattern as LibreOffice. This gives real browser
/// rendering (full CSS/JS) instead of LibreOffice's much weaker HTML
/// engine, and Chrome/Edge are already installed on most machines.
#[tauri::command]
async fn convert_url_to_pdf(
    app: tauri::AppHandle,
    browser_path: String,
    url: String,
    output: String,
) -> Result<(), String> {
    let browser_bin = resolve_app_binary(Path::new(&browser_path));
    if !browser_bin.exists() {
        return Err(format!(
            "在 {} 找不到浏览器可执行文件，请确认选择的是 Chrome/Edge 应用本体",
            browser_bin.display()
        ));
    }

    let args = vec![
        "--headless=new".to_string(),
        "--disable-gpu".to_string(),
        format!("--print-to-pdf={output}"),
        url,
    ];

    let result = app
        .shell()
        .command(&browser_bin)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to launch browser at {}: {e}", browser_bin.display()))?;

    if !result.status.success() {
        return Err(format!(
            "browser exited with {:?}: {}",
            result.status.code(),
            String::from_utf8_lossy(&result.stderr)
        ));
    }
    if !Path::new(&output).exists() {
        return Err("browser did not produce a PDF file".to_string());
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
            pdf_crop,
            pdf_delete_pages,
            pdf_reorder,
            convert_to_word,
            pdf_to_images,
            images_to_pdf,
            pdf_compress,
            pdf_watermark,
            pdf_page_numbers,
            pdf_encrypt,
            pdf_decrypt,
            pdf_redact,
            pdf_split,
            pdf_extract_text,
            pdf_extract_images,
            pdf_get_metadata,
            pdf_set_metadata,
            pdf_get_toc,
            pdf_set_toc,
            pdf_grayscale,
            pdf_remove_blank_pages,
            pdf_unify_page_size,
            pdf_strip_text,
            convert_to_word_libreoffice,
            convert_office_to_pdf,
            convert_url_to_pdf,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    // Regression test for the regview incident: resolve_app_binary must use
    // the bundle's real CFBundleExecutable, not "whichever file read_dir
    // happens to return first" out of LibreOffice's many Contents/MacOS
    // binaries. Skips (rather than fails) when LibreOffice isn't installed,
    // e.g. on a CI runner.
    #[test]
    #[cfg(target_os = "macos")]
    fn resolve_app_binary_finds_libreoffice_soffice_via_plist() {
        let app = Path::new("/Applications/LibreOffice.app");
        if !app.exists() {
            return;
        }
        assert_eq!(resolve_app_binary(app), app.join("Contents/MacOS/soffice"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn resolve_app_binary_passes_through_non_app_paths() {
        assert_eq!(resolve_app_binary(Path::new("/usr/bin/true")), PathBuf::from("/usr/bin/true"));
    }
}
