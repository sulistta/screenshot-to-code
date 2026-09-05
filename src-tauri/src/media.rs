use crate::store::{self, Files, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{io::Cursor, path::PathBuf};

pub fn chromium() -> Option<PathBuf> {
    let names = if cfg!(target_os = "windows") {
        vec!["chrome.exe", "msedge.exe"]
    } else {
        vec![
            "chromium",
            "chromium-browser",
            "google-chrome",
            "google-chrome-stable",
        ]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            for name in &names {
                let candidate = directory.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    if cfg!(target_os = "macos") {
        let path = PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        let cache = PathBuf::from(home).join(".cache/ms-playwright");
        if let Ok(entries) = std::fs::read_dir(cache) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with("chromium-") {
                    for relative in ["chrome-linux/chrome", "chrome-linux64/chrome"] {
                        let path = entry.path().join(relative);
                        if path.is_file() {
                            return Some(path);
                        }
                    }
                }
            }
        }
    }
    None
}
pub fn crop(reference: &str, input: &Value) -> Result<Vec<u8>> {
    let encoded = reference.split_once(',').ok_or("Invalid reference")?.1;
    let bytes = STANDARD.decode(encoded).map_err(store::err)?;
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(store::err)?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(12000);
    limits.max_image_height = Some(12000);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(store::err)?;
    let coordinate = |name: &str| {
        input[name]
            .as_u64()
            .and_then(|v| u32::try_from(v).ok())
            .ok_or_else(|| format!("Invalid {name}"))
    };
    let x = coordinate("x")?;
    let y = coordinate("y")?;
    let width = coordinate("width")?;
    let height = coordinate("height")?;
    if width == 0
        || height == 0
        || x.saturating_add(width) > image.width()
        || y.saturating_add(height) > image.height()
    {
        return Err("Crop must be within the source image, in source pixels".into());
    }
    let mut output = Cursor::new(vec![]);
    image
        .crop_imm(x, y, width, height)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(store::err)?;
    Ok(output.into_inner())
}
pub async fn screenshot(files: &Files, assets: &store::Assets) -> Result<Value> {
    let browser =
        chromium().ok_or("Install Chromium or Google Chrome to enable visual verification")?;
    let directory = tempfile::tempdir().map_err(store::err)?;
    crate::commands::materialize(directory.path(), files, assets)?;
    if !files.contains_key("index.html") {
        return Err("Visual verification needs an index.html entry point".into());
    }
    let output = directory.path().join(".studio-screenshot.png");
    let mut command = tokio::process::Command::new(browser);
    command.env_clear();
    for name in ["PATH", "SYSTEMROOT", "WINDIR", "DISPLAY"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .env("HOME", directory.path())
        .args([
            "--headless",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-extensions",
            "--window-size=1440,1000",
            "--hide-scrollbars",
        ])
        .arg(format!(
            "--user-data-dir={}",
            directory.path().join(".chrome").display()
        ))
        .arg(format!("--screenshot={}", output.display()))
        .arg(
            reqwest::Url::from_file_path(directory.path().join("index.html"))
                .map_err(|_| "Invalid screenshot path")?
                .as_str(),
        )
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(std::time::Duration::from_secs(30), command.status())
        .await
        .map_err(|_| "Screenshot timed out")?
        .map_err(store::err)?;
    if !status.success() {
        return Err("Chromium could not capture the project preview".into());
    }
    let bytes = std::fs::read(output).map_err(store::err)?;
    Ok(
        json!({"image":format!("data:image/png;base64,{}",STANDARD.encode(bytes)),"width":1440,"height":1000}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn crop_rejects_out_of_bounds() {
        let mut bytes = Cursor::new(vec![]);
        image::DynamicImage::new_rgb8(8, 8)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        let source = format!(
            "data:image/png;base64,{}",
            STANDARD.encode(bytes.into_inner())
        );
        assert!(crop(&source, &json!({"x":7,"y":0,"width":4,"height":4})).is_err());
        assert!(crop(&source, &json!({"x":0,"y":0,"width":4,"height":4})).is_ok());
    }
}
