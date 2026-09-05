use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::{Component, Path},
};

pub type Result<T> = std::result::Result<T, String>;
pub type Files = BTreeMap<String, String>;
pub type Assets = BTreeMap<String, Vec<u8>>;
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Paths are portable across all three desktop platforms, including when an
/// archive is imported on Linux and later exported to Windows.
pub fn validate_path(path: &str) -> Result<()> {
    if path.is_empty()
        || path.len() > 500
        || path.contains(['\\', ':', '\0', '<', '>', '"', '|', '?', '*'])
        || path.chars().any(char::is_control)
        || path.split('/').any(|p| {
            p.is_empty()
                || p == "."
                || p == ".."
                || p.ends_with([' ', '.'])
                || p.eq_ignore_ascii_case(".git")
                || p.eq_ignore_ascii_case("node_modules")
                || matches!(
                    p.split('.')
                        .next()
                        .unwrap_or("")
                        .to_ascii_uppercase()
                        .as_str(),
                    "CON"
                        | "PRN"
                        | "AUX"
                        | "NUL"
                        | "COM1"
                        | "COM2"
                        | "COM3"
                        | "COM4"
                        | "COM5"
                        | "COM6"
                        | "COM7"
                        | "COM8"
                        | "COM9"
                        | "LPT1"
                        | "LPT2"
                        | "LPT3"
                        | "LPT4"
                        | "LPT5"
                        | "LPT6"
                        | "LPT7"
                        | "LPT8"
                        | "LPT9"
                )
        })
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(
            "Use a portable relative project path without traversal or reserved directories".into(),
        );
    }
    Ok(())
}
pub fn validate_files(files: &Files) -> Result<()> {
    if files.len() > 2000 || files.values().map(String::len).sum::<usize>() > 32 * 1024 * 1024 {
        return Err("Project exceeds the 2,000 file / 32 MiB text limit".into());
    }
    let mut names = std::collections::BTreeSet::new();
    for path in files.keys() {
        if !names.insert(path.to_lowercase()) {
            return Err("Project contains case-colliding paths".into());
        }
    }
    for path in &names {
        let mut parent = path.as_str();
        while let Some((head, _)) = parent.rsplit_once('/') {
            if names.contains(head) {
                return Err("A project path is both a file and directory".into());
            }
            parent = head;
        }
    }
    for (path, content) in files {
        validate_path(path)?;
        if content.len() > 4 * 1024 * 1024 {
            return Err("A text file exceeds 4 MiB".into());
        }
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub brief: String,
    pub created_at: String,
    pub updated_at: String,
    pub primary_model: String,
    pub subagent_model: String,
    pub favorite: bool,
    pub archived: bool,
    pub trashed: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Iteration {
    pub id: String,
    pub run_id: String,
    pub label: String,
    pub summary: String,
    pub created_at: String,
    pub files: Files,
    #[serde(default)]
    pub assets: BTreeMap<String, Vec<u8>>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Document {
    pub project: Project,
    pub revision: String,
    pub files: Files,
    pub transcript: Vec<Value>,
    pub iterations: Vec<Iteration>,
    pub drafts: BTreeMap<String, Files>,
    #[serde(default)]
    pub asset_drafts: BTreeMap<String, Assets>,
    #[serde(default)]
    pub assets: BTreeMap<String, Vec<u8>>,
}
impl Document {
    pub fn new(name: String, brief: String) -> Self {
        let timestamp = now();
        Self {
            project: Project {
                id: id(),
                name,
                brief,
                created_at: timestamp.clone(),
                updated_at: timestamp,
                primary_model: String::new(),
                subagent_model: String::new(),
                favorite: false,
                archived: false,
                trashed: false,
            },
            revision: id(),
            files: Files::new(),
            transcript: vec![],
            iterations: vec![],
            drafts: BTreeMap::new(),
            asset_drafts: BTreeMap::new(),
            assets: BTreeMap::new(),
        }
    }
    pub fn commit(&mut self, files: Files, run_id: &str, summary: &str) -> Result<String> {
        validate_files(&files)?;
        self.revision = id();
        self.files = files;
        self.project.updated_at = now();
        self.iterations.push(Iteration {
            id: self.revision.clone(),
            run_id: run_id.into(),
            label: format!("Version {}", self.iterations.len() + 1),
            summary: summary.into(),
            created_at: now(),
            files: self.files.clone(),
            assets: self.assets.clone(),
        });
        Ok(self.revision.clone())
    }
    pub fn check_revision(&self, revision: &str) -> Result<()> {
        if revision != self.revision {
            Err("The project changed. Reload before saving.".into())
        } else {
            Ok(())
        }
    }
}

pub struct Store {
    pub connection: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let connection = Connection::open(path).map_err(err)?;
        connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, data TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS events_project ON events(project, seq);
            PRAGMA user_version=1;").map_err(err)?;
        Ok(Self { connection })
    }
    pub fn get(&self, id: &str) -> Result<Document> {
        let raw: String = self
            .connection
            .query_row("SELECT data FROM documents WHERE id=?", [id], |r| r.get(0))
            .map_err(|_| "Project not found".to_string())?;
        serde_json::from_str(&raw).map_err(err)
    }
    pub fn put(&self, document: &Document) -> Result<()> {
        self.connection.execute("INSERT INTO documents VALUES (?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![document.project.id, serde_json::to_string(document).map_err(err)?]).map_err(err)?;
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<Project>> {
        let mut stmt = self
            .connection
            .prepare("SELECT data FROM documents")
            .map_err(err)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(err)?;
        let mut projects = Vec::new();
        for row in rows {
            projects.push(
                serde_json::from_str::<Document>(&row.map_err(err)?)
                    .map_err(err)?
                    .project,
            );
        }
        projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(projects)
    }
    pub fn preference(&self, key: &str) -> Result<Value> {
        use rusqlite::OptionalExtension;
        let raw: Option<String> = self
            .connection
            .query_row("SELECT data FROM preferences WHERE key=?", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(err)?;
        raw.map(|r| serde_json::from_str(&r).map_err(err))
            .unwrap_or(Ok(Value::Null))
    }
    pub fn set_preference(&self, key: &str, value: &Value) -> Result<()> {
        self.connection.execute("INSERT INTO preferences VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
            params![key, value.to_string()]).map_err(err)?;
        Ok(())
    }
    pub fn event(&self, project: &str, mut value: Value) -> Result<Value> {
        value["projectId"] = json!(project);
        self.connection
            .execute(
                "INSERT INTO events(project,data) VALUES (?1,?2)",
                params![project, value.to_string()],
            )
            .map_err(err)?;
        let seq = self.connection.last_insert_rowid();
        value["sequence"] = json!(seq);
        value["streamId"] = json!(project);
        Ok(value)
    }
    pub fn events(&self, project: &str, after: i64) -> Result<Vec<Value>> {
        let mut stmt = self
            .connection
            .prepare("SELECT seq,data FROM events WHERE project=?1 AND seq>?2 ORDER BY seq")
            .map_err(err)?;
        let rows = stmt
            .query_map(params![project, after], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(err)?;
        rows.map(|row| {
            let (seq, raw) = row.map_err(err)?;
            let mut value: Value = serde_json::from_str(&raw).map_err(err)?;
            value["sequence"] = json!(seq);
            value["streamId"] = json!(project);
            Ok(value)
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reject_cross_platform_traversal() {
        for name in [
            "../secret",
            "/etc/passwd",
            "a/../b",
            "a\\b",
            "C:/a",
            ".git/config",
            "node_modules/a",
            "x//y",
            "x/CON.txt",
            "a.",
        ] {
            assert!(validate_path(name).is_err(), "{name}");
        }
        assert!(validate_path("src/components/App.tsx").is_ok());
    }
    #[test]
    fn persistence_revision_and_replay_survive_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("studio.db");
        let mut doc = Document::new("Test".into(), "".into());
        let project = doc.project.id.clone();
        let old = doc.revision.clone();
        doc.commit(
            Files::from([("index.html".into(), "hello".into())]),
            "run",
            "Created",
        )
        .unwrap();
        assert!(doc.check_revision(&old).is_err());
        {
            let store = Store::open(&path).unwrap();
            store.put(&doc).unwrap();
            store.event(&project, json!({"type":"status"})).unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.get(&project).unwrap().files["index.html"], "hello");
        let events = store.events(&project, 0).unwrap();
        assert_eq!(events.len(), 1);
        assert!(store
            .events(&project, events[0]["sequence"].as_i64().unwrap())
            .unwrap()
            .is_empty());
    }
}
