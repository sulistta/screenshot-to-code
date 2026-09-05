use crate::{
    state::AppState,
    store::{self, Result},
};
use serde_json::{json, Value};
use std::borrow::Cow;
use tauri::{
    http::{Request, Response},
    Manager, UriSchemeContext,
};

const POLICY: &str = "default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' https: 'unsafe-inline'; connect-src https:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'; sandbox allow-scripts allow-forms allow-downloads";

pub fn resolve(state: &AppState, path: &str) -> Result<(Vec<u8>, String)> {
    let decoded = percent_encoding::percent_decode_str(path.trim_start_matches('/'))
        .decode_utf8()
        .map_err(store::err)?;
    let mut segments = decoded.splitn(3, '/');
    let project = segments.next().ok_or("Missing project")?;
    let revision = segments.next().ok_or("Missing revision")?;
    let path = segments
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("index.html");
    store::validate_path(path)?;
    let inner = state.lock()?;
    let doc = inner.store.get(project)?;
    let (files, assets) = if revision == "current" {
        (&doc.files, &doc.assets)
    } else {
        let it = doc
            .iterations
            .iter()
            .find(|it| it.id == revision)
            .ok_or("Version not found")?;
        (&it.files, &it.assets)
    };
    let bytes = files
        .get(path)
        .map(|s| s.as_bytes().to_vec())
        .or_else(|| assets.get(path).cloned())
        .ok_or("File not found")?;
    Ok((
        bytes,
        mime_guess::from_path(path)
            .first_or_octet_stream()
            .to_string(),
    ))
}
pub fn serve(
    context: UriSchemeContext<'_, tauri::Wry>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let result = if request.method() != "GET" && request.method() != "HEAD" {
        Err("Method not allowed".into())
    } else {
        resolve(
            &context.app_handle().state::<AppState>(),
            request.uri().path(),
        )
    };
    let (status, body, mime) = match result {
        Ok((mut bytes, mime)) => {
            if mime == "text/html"
                && request
                    .uri()
                    .query()
                    .is_some_and(|q| q.split('&').any(|s| s == "inspect=true"))
            {
                bytes.extend_from_slice(include_bytes!("inspector.html"));
            }
            (200, bytes, mime)
        }
        Err(_) => (404, b"Preview file not found".to_vec(), "text/plain".into()),
    };
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", POLICY)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Owned(if request.method() == "HEAD" {
            vec![]
        } else {
            body
        }))
        .expect("static response headers")
}
#[tauri::command]
pub fn open_preview(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    project_id: String,
    iteration_id: Option<String>,
) -> Result<()> {
    let revision = iteration_id.unwrap_or("current".into());
    resolve(&state, &format!("{project_id}/{revision}/index.html"))?;
    let origin = if cfg!(target_os = "windows") {
        "http://preview.localhost"
    } else {
        "preview://localhost"
    };
    let url = format!("{origin}/{project_id}/{revision}/index.html")
        .parse()
        .map_err(store::err)?;
    tauri::WebviewWindowBuilder::new(
        &app,
        format!("preview-{}", store::id()),
        tauri::WebviewUrl::External(url),
    )
    .title("Project preview")
    .inner_size(1200.0, 800.0)
    .build()
    .map_err(store::err)?;
    Ok(())
}
#[tauri::command]
pub fn capabilities() -> Value {
    json!({"screenshot_preview":crate::media::chromium().is_some(),"native":true})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn previews_cannot_escape_project_or_access_ipc() {
        let dir = tempfile::tempdir().unwrap();
        let state = AppState::new(dir.path().into()).unwrap();
        let mut doc = store::Document::new("Preview".into(), "".into());
        doc.files.insert("index.html".into(), "<h1>ok</h1>".into());
        state.lock().unwrap().store.put(&doc).unwrap();
        assert!(resolve(&state, &format!("{}/current/index.html", doc.project.id)).is_ok());
        assert!(resolve(
            &state,
            &format!("{}/current/%2e%2e/studio.db", doc.project.id)
        )
        .is_err());
        assert!(POLICY.contains("sandbox allow-scripts"));
        assert!(!POLICY.contains("allow-same-origin"));
        assert!(!POLICY.contains("ipc:"));
    }
}
