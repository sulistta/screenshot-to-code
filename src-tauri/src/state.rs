use crate::store::{Result, Store};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
};
use tauri::ipc::Channel;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

pub struct ActiveRun {
    pub cancel: CancellationToken,
    pub question: Option<(String, oneshot::Sender<String>)>,
}
pub struct Inner {
    pub store: Store,
    pub subscriptions: HashMap<String, (String, Channel<Value>)>,
    pub runs: HashMap<String, ActiveRun>,
    pub services: HashMap<String, crate::services::Service>,
}
#[derive(Clone)]
pub struct AppState {
    pub inner: Arc<Mutex<Inner>>,
    pub data_dir: PathBuf,
    pub client: reqwest::Client,
}
impl AppState {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir).map_err(crate::store::err)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700))
                .map_err(crate::store::err)?;
        }
        let store = Store::open(&data_dir.join("studio.db"))?;
        // A terminated process cannot resume an outstanding provider request.
        // Persist a terminal status so reopening never leaves the UI busy forever.
        for project in store.list()? {
            let events = store.events(&project.id, 0)?;
            if let Some(event) = events.iter().rev().find(|v| v["type"] == "run_status") {
                if matches!(
                    event["status"].as_str(),
                    Some("running" | "waiting_for_user")
                ) {
                    store.event(&project.id,serde_json::json!({"type":"run_status","status":"cancelled","runId":event["runId"],"message":"The application closed during this run. Saved work is available in history.","draftAvailable":true}))?;
                }
            }
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner {
                store,
                subscriptions: HashMap::new(),
                runs: HashMap::new(),
                services: HashMap::new(),
            })),
            data_dir,
            client: reqwest::Client::builder()
                .connect_timeout(std::time::Duration::from_secs(20))
                .timeout(std::time::Duration::from_secs(300))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(crate::store::err)?,
        })
    }
    pub fn lock(&self) -> Result<MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| "Application state is unavailable".into())
    }
    pub fn ensure_idle(inner: &Inner, id: &str) -> Result<()> {
        if inner.runs.contains_key(id) {
            Err("Stop the current run before changing this project".into())
        } else {
            Ok(())
        }
    }
    pub fn emit(&self, project: &str, value: Value) -> Result<()> {
        let inner = self.lock()?;
        let event = inner.store.event(project, value)?;
        for (id, channel) in inner.subscriptions.values() {
            if id == project {
                let _ = channel.send(event.clone());
            }
        }
        Ok(())
    }
}
