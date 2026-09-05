use crate::{
    commands::materialize,
    state::AppState,
    store::{self, Files, Result},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read, Write},
};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

pub fn unpack(bytes: &[u8]) -> Result<(Files, BTreeMap<String, Vec<u8>>)> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Archive exceeds 64 MiB".into());
    }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(store::err)?;
    if zip.len() > 2000 {
        return Err("Archive has more than 2,000 entries".into());
    }
    let mut files = Files::new();
    let mut assets = BTreeMap::new();
    let mut total = 0;
    let mut paths = std::collections::HashSet::new();
    for index in 0..zip.len() {
        let mut file = zip.by_index(index).map_err(store::err)?;
        if file.is_dir() {
            continue;
        }
        let path = file.name().to_string();
        store::validate_path(&path)?;
        if !paths.insert(path.to_lowercase()) {
            return Err("Archive contains duplicate or case-colliding paths".into());
        }
        if file
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Archive symlinks are not allowed".into());
        }
        total += file.size();
        if total > 64 * 1024 * 1024 || file.size() > 20 * 1024 * 1024 {
            return Err("Expanded archive exceeds size limits".into());
        }
        let mut bytes = vec![];
        (&mut file)
            .take(20 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(store::err)?;
        if bytes.len() > 20 * 1024 * 1024 {
            return Err("Archive entry exceeds size limit".into());
        }
        match String::from_utf8(bytes) {
            Ok(text) => {
                files.insert(path, text);
            }
            Err(e) => {
                assets.insert(path, e.into_bytes());
            }
        }
    }
    store::validate_files(&files)?;
    Ok((files, assets))
}
#[tauri::command]
pub async fn import_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<bool> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Project archive", &["zip"])
            .blocking_pick_file();
        let Some(path) = path else { return Ok(false) };
        let path = path.into_path().map_err(store::err)?;
        if std::fs::metadata(&path).map_err(store::err)?.len() > 64 * 1024 * 1024 {
            return Err("Archive exceeds 64 MiB".into());
        }
        let bytes = std::fs::read(path).map_err(store::err)?;
        let (files, assets) = unpack(&bytes)?;
        let inner = state.lock()?;
        AppState::ensure_idle(&inner, &project_id)?;
        let mut doc = inner.store.get(&project_id)?;
        doc.assets = assets;
        doc.commit(files, "", "Imported archive")?;
        inner.store.put(&doc)?;
        Ok(true)
    })
    .await
    .map_err(store::err)?
}
#[tauri::command]
pub async fn export_project(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<bool> {
    let doc = state.lock()?.store.get(&project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(path) = app
            .dialog()
            .file()
            .add_filter("Project archive", &["zip"])
            .set_file_name("project.zip")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = path.into_path().map_err(store::err)?;
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, bytes) in doc
            .files
            .iter()
            .map(|(n, c)| (n, c.as_bytes()))
            .chain(doc.assets.iter().map(|(n, c)| (n, c.as_slice())))
        {
            store::validate_path(name)?;
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .map_err(store::err)?;
            zip.write_all(bytes).map_err(store::err)?;
        }
        let bytes = zip.finish().map_err(store::err)?.into_inner();
        std::fs::write(path, bytes).map_err(store::err)?;
        Ok(true)
    })
    .await
    .map_err(store::err)?
}
#[tauri::command]
pub async fn git_checkpoint(
    state: State<'_, AppState>,
    project_id: String,
    message: String,
) -> Result<Value> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let inner = state.lock()?;
        AppState::ensure_idle(&inner, &project_id)?;
        let doc = inner.store.get(&project_id)?;
        let root = state.data_dir.join("checkpoints").join(&doc.project.id);
        std::fs::create_dir_all(&root).map_err(store::err)?;
        // Remove old tracked files so a checkpoint reflects deletions as well.
        for entry in std::fs::read_dir(&root).map_err(store::err)? {
            let entry = entry.map_err(store::err)?;
            if entry.file_name() == ".git" {
                continue;
            }
            if entry.file_type().map_err(store::err)?.is_dir() {
                std::fs::remove_dir_all(entry.path()).map_err(store::err)?;
            } else {
                std::fs::remove_file(entry.path()).map_err(store::err)?;
            }
        }
        materialize(&root, &doc.files, &doc.assets)?;
        let git = |args: &[&str]| -> Result<String> {
            let output = std::process::Command::new("git")
                .arg("-c")
                .arg("core.hooksPath=/dev/null")
                .arg("-c")
                .arg("commit.gpgsign=false")
                .args(args)
                .current_dir(&root)
                .output()
                .map_err(store::err)?;
            if !output.status.success() {
                return Err(String::from_utf8_lossy(&output.stderr).into());
            }
            Ok(String::from_utf8_lossy(&output.stdout).trim().into())
        };
        git(&["init", "--quiet"])?;
        git(&["add", "--all"])?;
        git(&[
            "-c",
            "user.name=Studio",
            "-c",
            "user.email=studio@localhost",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            &message,
        ])?;
        Ok(json!({"commit":git(&["rev-parse","HEAD"])?}))
    })
    .await
    .map_err(store::err)?
}

fn read_tree(root: &std::path::Path) -> Result<(Files, BTreeMap<String, Vec<u8>>)> {
    fn visit(
        root: &std::path::Path,
        dir: &std::path::Path,
        files: &mut Files,
        assets: &mut BTreeMap<String, Vec<u8>>,
        total: &mut u64,
    ) -> Result<()> {
        for entry in std::fs::read_dir(dir).map_err(store::err)? {
            let entry = entry.map_err(store::err)?;
            let kind = entry.file_type().map_err(store::err)?;
            if kind.is_symlink() {
                return Err("Project folders must not contain symlinks".into());
            }
            if matches!(
                entry.file_name().to_str(),
                Some(".git" | "node_modules" | ".venv" | ".runtime-home")
            ) {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(store::err)?
                .to_string_lossy()
                .replace('\\', "/");
            store::validate_path(&relative)?;
            if kind.is_dir() {
                visit(root, &path, files, assets, total)?;
            } else if kind.is_file() {
                *total += entry.metadata().map_err(store::err)?.len();
                if *total > 64 * 1024 * 1024 || files.len() + assets.len() >= 2000 {
                    return Err("Folder exceeds import limits".into());
                }
                let bytes = std::fs::read(&path).map_err(store::err)?;
                match String::from_utf8(bytes) {
                    Ok(text) => {
                        files.insert(relative, text);
                    }
                    Err(e) => {
                        assets.insert(relative, e.into_bytes());
                    }
                }
            }
        }
        Ok(())
    }
    let mut files = Files::new();
    let mut assets = BTreeMap::new();
    visit(root, root, &mut files, &mut assets, &mut 0)?;
    store::validate_files(&files)?;
    Ok((files, assets))
}
/// Import is a data conversion only. No Python module or external service is
/// loaded. The selected folder remains untouched and receives a fresh ID.
pub fn import_folder(root: &std::path::Path) -> Result<store::Document> {
    let structured = root.join("project.json").is_file() && root.join("workspace").is_dir();
    let metadata: Value = if structured {
        serde_json::from_slice(&std::fs::read(root.join("project.json")).map_err(store::err)?)
            .map_err(store::err)?
    } else {
        json!({})
    };
    let name = metadata["name"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(|| {
            root.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
    let mut doc = store::Document::new(name, metadata["brief"].as_str().unwrap_or("").into());
    let (files, assets) = read_tree(&if structured {
        root.join("workspace")
    } else {
        root.to_path_buf()
    })?;
    doc.assets = assets;
    if structured {
        let session = root.join("sessions/main.json");
        if session.is_file() {
            let messages: Vec<Value> =
                serde_json::from_slice(&std::fs::read(session).map_err(store::err)?)
                    .map_err(store::err)?;
            doc.transcript=messages.into_iter().map(|m|json!({"role":m["role"],"text":m["text"],"images":m["images"].as_array().cloned().unwrap_or_default(),"runId":m["run_id"],"createdAt":m["created_at"]})).collect();
        }
        doc.project.primary_model = metadata["primary_model"].as_str().unwrap_or("").into();
        doc.project.subagent_model = metadata["subagent_model"].as_str().unwrap_or("").into();
        let versions = root.join("iterations");
        if versions.is_dir() {
            let mut directories = std::fs::read_dir(versions)
                .map_err(store::err)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(store::err)?;
            directories.sort_by_key(|e| e.file_name());
            for directory in directories {
                let path = directory.path();
                let metadata = path.join("iteration.json");
                if !metadata.is_file() {
                    continue;
                }
                let data: Value =
                    serde_json::from_slice(&std::fs::read(metadata).map_err(store::err)?)
                        .map_err(store::err)?;
                let source = path.join("files");
                if !source.is_dir() {
                    continue;
                }
                let (files, assets) = read_tree(&source)?;
                doc.iterations.push(store::Iteration {
                    id: store::id(),
                    run_id: data["run_id"].as_str().unwrap_or("").into(),
                    label: data["label"].as_str().unwrap_or("Imported version").into(),
                    summary: data["summary"].as_str().unwrap_or("").into(),
                    created_at: data["created_at"].as_str().unwrap_or("").into(),
                    files,
                    assets,
                });
            }
        }
    }
    doc.commit(files, "", "Imported project folder")?;
    Ok(doc)
}
#[tauri::command]
pub async fn import_project_folder(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<store::Project>> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(root) = app.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        let root = root.into_path().map_err(store::err)?;
        let doc = import_folder(&root)?;
        state.lock()?.store.put(&doc)?;
        Ok(Some(doc.project))
    })
    .await
    .map_err(store::err)?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn archive(name: &str) -> Vec<u8> {
        let mut zip = zip::ZipWriter::new(Cursor::new(vec![]));
        zip.start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"test").unwrap();
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn zip_slip_is_rejected_before_writing() {
        assert!(unpack(&archive("../outside")).is_err());
        assert!(unpack(&archive("src/app.ts")).is_ok());
    }
    #[test]
    fn folder_conversion_preserves_history_and_does_not_modify_source() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("workspace")).unwrap();
        std::fs::create_dir_all(dir.path().join("sessions")).unwrap();
        std::fs::create_dir_all(dir.path().join("iterations/i0001/files")).unwrap();
        std::fs::write(
            dir.path().join("project.json"),
            r#"{"id":"old","name":"Existing project","brief":"Keep me"}"#,
        )
        .unwrap();
        std::fs::write(dir.path().join("workspace/index.html"), "current").unwrap();
        std::fs::write(dir.path().join("sessions/main.json"),r#"[{"role":"user","text":"Build","created_at":"2026-01-01","run_id":"r1","images":[]}]"#).unwrap();
        std::fs::write(
            dir.path().join("iterations/i0001/iteration.json"),
            r#"{"label":"First","run_id":"r1","summary":"Initial","created_at":"2026-01-01"}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("iterations/i0001/files/index.html"),
            "first",
        )
        .unwrap();
        let imported = import_folder(dir.path()).unwrap();
        assert_ne!(imported.project.id, "old");
        assert_eq!(imported.project.name, "Existing project");
        assert_eq!(imported.files["index.html"], "current");
        assert_eq!(imported.iterations[0].files["index.html"], "first");
        assert_eq!(imported.transcript[0]["runId"], "r1");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("workspace/index.html")).unwrap(),
            "current"
        );
    }
}
