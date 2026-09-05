use crate::{
    state::AppState,
    store::{self, validate_path, Document, Files, Project, Result},
};
use serde_json::{json, Value};
use tauri::{ipc::Channel, State};

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> Result<Vec<Project>> {
    state.lock()?.store.list()
}
#[tauri::command]
pub fn create_project(state: State<'_, AppState>, name: String, brief: String) -> Result<Project> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 || brief.len() > 32000 {
        return Err("Invalid project name or brief".into());
    }
    let doc = Document::new(name.into(), brief);
    state.lock()?.store.put(&doc)?;
    Ok(doc.project)
}
#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    project_id: String,
    patch: Value,
) -> Result<Project> {
    let inner = state.lock()?;
    let mut doc = inner.store.get(&project_id)?;
    if let Some(name) = patch["name"].as_str() {
        if name.trim().is_empty() || name.len() > 200 {
            return Err("Invalid project name".into());
        }
        doc.project.name = name.trim().into();
    }
    if let Some(brief) = patch["brief"].as_str() {
        doc.project.brief = brief.into();
    }
    if let Some(model) = patch["primaryModel"].as_str() {
        doc.project.primary_model = model.into();
    }
    if let Some(model) = patch["subagentModel"].as_str() {
        doc.project.subagent_model = model.into();
    }
    doc.project.updated_at = store::now();
    inner.store.put(&doc)?;
    Ok(doc.project)
}
#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, project_id: String) -> Result<()> {
    let mut inner = state.lock()?;
    AppState::ensure_idle(&inner, &project_id)?;
    inner.store.get(&project_id)?;
    inner.services.remove(&project_id);
    let tx = inner.store.connection.transaction().map_err(store::err)?;
    tx.execute("DELETE FROM documents WHERE id=?", [&project_id])
        .map_err(store::err)?;
    tx.execute("DELETE FROM events WHERE project=?", [&project_id])
        .map_err(store::err)?;
    tx.commit().map_err(store::err)
}
#[tauri::command]
pub fn get_transcript(state: State<'_, AppState>, project_id: String) -> Result<Vec<Value>> {
    Ok(state.lock()?.store.get(&project_id)?.transcript)
}
#[tauri::command]
pub fn list_iterations(state: State<'_, AppState>, project_id: String) -> Result<Vec<Value>> {
    Ok(state.lock()?.store.get(&project_id)?.iterations.into_iter().map(|it|json!({"id":it.id,"run_id":it.run_id,"label":it.label,"summary":it.summary,"created_at":it.created_at})).collect())
}
#[tauri::command]
pub fn get_files(state: State<'_, AppState>, project_id: String) -> Result<Value> {
    let doc = state.lock()?.store.get(&project_id)?;
    Ok(json!({"revision":doc.revision,"files":doc.files}))
}
#[tauri::command]
pub fn edit_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    content: String,
    revision: String,
) -> Result<Value> {
    validate_path(&path)?;
    let inner = state.lock()?;
    AppState::ensure_idle(&inner, &project_id)?;
    let mut doc = inner.store.get(&project_id)?;
    doc.check_revision(&revision)?;
    let mut files = doc.files.clone();
    files.insert(path, content);
    doc.commit(files, "", "Manual edit")?;
    inner.store.put(&doc)?;
    Ok(json!({"revision":doc.revision,"files":doc.files}))
}
#[tauri::command]
pub fn revision_diff(
    state: State<'_, AppState>,
    project_id: String,
    iteration_id: String,
) -> Result<Value> {
    let doc = state.lock()?.store.get(&project_id)?;
    let it = doc
        .iterations
        .iter()
        .find(|v| v.id == iteration_id)
        .ok_or("Version not found")?;
    let paths: std::collections::BTreeSet<_> = it.files.keys().chain(doc.files.keys()).collect();
    let changes: Vec<_>=paths.into_iter().filter(|p|it.files.get(*p)!=doc.files.get(*p)).map(|p| {
        let a=it.files.get(p).map(String::as_str).unwrap_or(""); let b=doc.files.get(p).map(String::as_str).unwrap_or("");
        json!({"path":p,"kind":if !it.files.contains_key(p) {"added"} else if !doc.files.contains_key(p) {"deleted"} else {"modified"},
            "diff":similar::TextDiff::from_lines(a,b).unified_diff().header("version","current").to_string()})
    }).collect();
    Ok(json!({"changes":changes}))
}
#[tauri::command]
pub fn restore_revision(
    state: State<'_, AppState>,
    project_id: String,
    iteration_id: String,
    revision: String,
) -> Result<()> {
    let inner = state.lock()?;
    AppState::ensure_idle(&inner, &project_id)?;
    let mut doc = inner.store.get(&project_id)?;
    doc.check_revision(&revision)?;
    let it = doc
        .iterations
        .iter()
        .find(|v| v.id == iteration_id)
        .ok_or("Version not found")?
        .clone();
    doc.assets = it.assets;
    doc.commit(it.files, "", "Restored version")?;
    inner.store.put(&doc)
}
#[tauri::command]
pub fn set_project_options(
    state: State<'_, AppState>,
    project_id: String,
    favorite: bool,
    archived: bool,
    trashed: bool,
) -> Result<Project> {
    let inner = state.lock()?;
    AppState::ensure_idle(&inner, &project_id)?;
    let mut doc = inner.store.get(&project_id)?;
    doc.project.favorite = favorite;
    doc.project.archived = archived;
    doc.project.trashed = trashed;
    inner.store.put(&doc)?;
    Ok(doc.project)
}
#[tauri::command]
pub fn duplicate_project(state: State<'_, AppState>, project_id: String) -> Result<Project> {
    let inner = state.lock()?;
    let source = inner.store.get(&project_id)?;
    let mut doc = Document::new(
        format!("{} copy", source.project.name),
        source.project.brief,
    );
    doc.assets = source.assets;
    doc.commit(source.files, "", "Duplicated project")?;
    inner.store.put(&doc)?;
    Ok(doc.project)
}
#[tauri::command]
pub fn restore_draft(state: State<'_, AppState>, project_id: String, run_id: String) -> Result<()> {
    let inner = state.lock()?;
    AppState::ensure_idle(&inner, &project_id)?;
    let mut doc = inner.store.get(&project_id)?;
    let files = doc.drafts.get(&run_id).ok_or("Draft not found")?.clone();
    if let Some(assets) = doc.asset_drafts.get(&run_id) {
        doc.assets = assets.clone();
    }
    doc.commit(files, "", "Restored partial work")?;
    inner.store.put(&doc)
}
#[tauri::command]
pub fn subscribe_project(
    state: State<'_, AppState>,
    project_id: String,
    subscription_id: String,
    after: i64,
    on_event: Channel<Value>,
) -> Result<()> {
    let mut inner = state.lock()?;
    inner.store.get(&project_id)?;
    // Replay and registration share the emitter lock: no event can fall in between.
    for event in inner.store.events(&project_id, after)? {
        on_event.send(event).map_err(store::err)?;
    }
    inner
        .subscriptions
        .insert(subscription_id, (project_id, on_event));
    Ok(())
}
#[tauri::command]
pub fn unsubscribe_project(state: State<'_, AppState>, subscription_id: String) -> Result<()> {
    state.lock()?.subscriptions.remove(&subscription_id);
    Ok(())
}
#[tauri::command]
pub fn cancel_run(state: State<'_, AppState>, project_id: String) -> Result<()> {
    let inner = state.lock()?;
    let run = inner.runs.get(&project_id).ok_or("No active run")?;
    run.cancel.cancel();
    Ok(())
}
#[tauri::command]
pub fn answer_question(
    state: State<'_, AppState>,
    project_id: String,
    question_id: String,
    answer: String,
) -> Result<()> {
    let mut inner = state.lock()?;
    let run = inner.runs.get_mut(&project_id).ok_or("No active run")?;
    if run.question.as_ref().map(|(id, _)| id.as_str()) != Some(question_id.as_str()) {
        return Err("This question is no longer active".into());
    }
    let (_, sender) = run.question.take().ok_or("No active question")?;
    sender.send(answer).map_err(|_| "Run already ended".into())
}

pub fn materialize(
    root: &std::path::Path,
    files: &Files,
    assets: &std::collections::BTreeMap<String, Vec<u8>>,
) -> Result<()> {
    store::validate_files(files)?;
    for (name, bytes) in files
        .iter()
        .map(|(n, c)| (n, c.as_bytes()))
        .chain(assets.iter().map(|(n, c)| (n, c.as_slice())))
    {
        validate_path(name)?;
        let target = root.join(name);
        let mut cursor = root.to_path_buf();
        for part in std::path::Path::new(name).components() {
            cursor.push(part);
            if cursor
                .symlink_metadata()
                .is_ok_and(|m| m.file_type().is_symlink())
            {
                return Err("Symlinks are not allowed in project workspaces".into());
            }
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(store::err)?;
        }
        std::fs::write(target, bytes).map_err(store::err)?;
    }
    Ok(())
}
