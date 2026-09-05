use crate::{
    state::AppState,
    store::{self, Result},
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;

pub struct Service {
    child: Option<Child>,
    port: u16,
    logs: Arc<Mutex<VecDeque<String>>>,
    phase: String,
    error: Option<String>,
    sandboxed: bool,
    root: PathBuf,
}
impl Drop for Service {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            #[cfg(windows)]
            {
                let _ = Command::new("taskkill")
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .output();
            }
            let _ = child.kill();
            let _ = child.wait();
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
fn binary(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .flat_map(|p| {
            if cfg!(target_os = "windows") {
                vec![
                    p.join(format!("{name}.exe")),
                    p.join(format!("{name}.cmd")),
                    p.join(name),
                ]
            } else {
                vec![p.join(name)]
            }
        })
        .find(|p| p.is_file())
}
fn sandbox_available() -> bool {
    #[cfg(target_os = "linux")]
    {
        Command::new("bwrap")
            .args([
                "--ro-bind",
                "/usr",
                "/usr",
                "--symlink",
                "usr/bin",
                "/bin",
                "--symlink",
                "usr/lib",
                "/lib",
                "--symlink",
                "usr/lib64",
                "/lib64",
                "--unshare-user",
                "--unshare-pid",
                "--",
                "/usr/bin/true",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}
fn command(
    program: &str,
    args: &[String],
    root: &Path,
    sandboxed: bool,
    port: u16,
) -> Result<Command> {
    let executable = binary(program)
        .ok_or_else(|| format!("Install Node.js and {program} to run generated apps"))?;
    let mut command = if sandboxed {
        let mut cmd = Command::new("bwrap");
        cmd.args([
            "--die-with-parent",
            "--unshare-user",
            "--unshare-pid",
            "--unshare-uts",
            "--unshare-ipc",
            "--ro-bind",
            "/usr",
            "/usr",
            "--symlink",
            "usr/bin",
            "/bin",
            "--symlink",
            "usr/lib",
            "/lib",
            "--symlink",
            "usr/lib64",
            "/lib64",
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--tmpfs",
            "/tmp",
            "--tmpfs",
            "/home",
        ]);
        for name in ["/etc/resolv.conf", "/etc/hosts", "/etc/ssl", "/etc/pki"] {
            if Path::new(name).exists() {
                cmd.args(["--ro-bind", name, name]);
            }
        }
        let mut binds = std::collections::BTreeSet::new();
        for name in [program, "node"] {
            if let Some(path) = binary(name) {
                for path in [path.clone(), path.canonicalize().map_err(store::err)?] {
                    if let Some(parent) = path.parent() {
                        if !parent.starts_with("/usr") {
                            binds.insert(parent.to_path_buf());
                        }
                    }
                }
            }
        }
        // NVM installations place npm's entry script under bin but its
        // modules under lib. Expose the toolchain prefix read-only, not HOME.
        if let Some(node) = binary("node").and_then(|p| p.canonicalize().ok()) {
            if let Some(bin) = node.parent() {
                if bin.file_name().is_some_and(|n| n == "bin") && !bin.starts_with("/usr") {
                    if let Some(prefix) = bin.parent() {
                        binds.insert(prefix.to_path_buf());
                    }
                }
            }
        }
        for bind in binds {
            cmd.arg("--ro-bind").arg(&bind).arg(&bind);
        }
        cmd.arg("--bind")
            .arg(root)
            .arg(root)
            .arg("--chdir")
            .arg(root);
        cmd.args([
            "--clearenv",
            "--setenv",
            "HOME",
            "/tmp",
            "--setenv",
            "TMPDIR",
            "/tmp",
            "--setenv",
            "PATH",
        ])
        .arg(std::env::var_os("PATH").unwrap_or_default());
        cmd.args([
            "--setenv",
            "PORT",
            &port.to_string(),
            "--setenv",
            "HOST",
            "127.0.0.1",
            "--setenv",
            "CI",
            "1",
            "--",
        ]);
        cmd.arg(executable);
        cmd
    } else {
        let mut cmd = Command::new(executable);
        cmd.env_clear();
        // Isolated HOME/cache even on systems without Bubblewrap. This is not
        // an OS filesystem sandbox; report sandboxed=false in the UI.
        for key in ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) {
                cmd.env(key, value);
            }
        }
        let home = root.join(".runtime-home");
        std::fs::create_dir_all(&home).map_err(store::err)?;
        cmd.env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("CI", "1")
            .env("PORT", port.to_string())
            .env("HOST", "127.0.0.1");
        cmd
    };
    command
        .args(args)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    Ok(command)
}
fn attach(child: &mut Child, logs: &Arc<Mutex<VecDeque<String>>>) {
    let mut readers: Vec<Box<dyn std::io::Read + Send>> = vec![];
    if let Some(stdout) = child.stdout.take() {
        readers.push(Box::new(stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        readers.push(Box::new(stderr));
    }
    for reader in readers {
        let logs = logs.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(reader)
                .lines()
                .map_while(std::result::Result::ok)
            {
                if let Ok(mut logs) = logs.lock() {
                    if logs.len() >= 200 {
                        logs.pop_front();
                    }
                    logs.push_back(line.chars().take(2000).collect());
                }
            }
        });
    }
}
fn snapshot(service: &mut Service) -> Result<Value> {
    if service.phase == "running"
        && service
            .child
            .as_mut()
            .map(|c| c.try_wait())
            .transpose()
            .map_err(store::err)?
            .flatten()
            .is_some()
    {
        service.phase = "crashed".into();
        service.error = Some("Preview process exited; inspect the logs and restart".into());
    }
    Ok(
        json!({"state":service.phase,"error":service.error,"sandboxed":service.sandboxed,"url":format!("http://127.0.0.1:{}",service.port),
        "services":[{"name":"app","port":service.port,"crashes":0,"logs":service.logs.lock().map_err(|_|"Logs unavailable")?.iter().collect::<Vec<_>>()}]}),
    )
}
#[tauri::command]
pub fn services_status(state: State<'_, AppState>, project_id: String) -> Result<Value> {
    let mut inner = state.lock()?;
    inner.store.get(&project_id)?;
    inner
        .services
        .get_mut(&project_id)
        .map(snapshot)
        .unwrap_or(Ok(json!({"state":"stopped","services":[]})))
}
#[tauri::command]
pub async fn start_services(state: State<'_, AppState>, project_id: String) -> Result<Value> {
    let state = state.inner().clone();
    let (doc, root, port) = {
        let mut inner = state.lock()?;
        AppState::ensure_idle(&inner, &project_id)?;
        if inner.services.contains_key(&project_id) {
            return Err("Stop the existing preview before restarting it".into());
        }
        let doc = inner.store.get(&project_id)?;
        let root = state.data_dir.join("runtimes").join(store::id());
        let socket = std::net::TcpListener::bind("127.0.0.1:0").map_err(store::err)?;
        let port = socket.local_addr().map_err(store::err)?.port();
        inner.services.insert(
            project_id.clone(),
            Service {
                child: None,
                port,
                logs: Arc::new(Mutex::new(VecDeque::new())),
                phase: "installing".into(),
                error: None,
                sandboxed: false,
                root: root.clone(),
            },
        );
        (doc, root, port)
    };
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| -> Result<()> {
            let manifest: Value =
                serde_json::from_str(doc.files.get("package.json").ok_or("No package.json")?)
                    .map_err(store::err)?;
            let script = if manifest["scripts"]["dev"].is_string() {
                "dev"
            } else if manifest["scripts"]["start"].is_string() {
                "start"
            } else {
                return Err("Define a dev or start script in package.json".into());
            };
            std::fs::create_dir_all(&root).map_err(store::err)?;
            crate::commands::materialize(&root, &doc.files, &doc.assets)?;
            let manager = if doc.files.contains_key("pnpm-lock.yaml") {
                "pnpm"
            } else {
                "npm"
            };
            let sandboxed = sandbox_available();
            let args: Vec<String> = if manager == "pnpm" {
                vec!["install", "--ignore-scripts"]
            } else {
                vec!["install", "--ignore-scripts", "--no-audit", "--no-fund"]
            }
            .into_iter()
            .map(String::from)
            .collect();
            {
                let mut inner = state.lock()?;
                let service = inner
                    .services
                    .get_mut(&project_id)
                    .filter(|s| s.root == root)
                    .ok_or("Stopped")?;
                let mut child = command(manager, &args, &root, sandboxed, port)?
                    .spawn()
                    .map_err(store::err)?;
                attach(&mut child, &service.logs);
                service.child = Some(child);
                service.sandboxed = sandboxed;
            }
            let started = Instant::now();
            loop {
                {
                    let mut inner = state.lock()?;
                    let service = inner
                        .services
                        .get_mut(&project_id)
                        .filter(|s| s.root == root)
                        .ok_or("Stopped")?;
                    if let Some(status) = service
                        .child
                        .as_mut()
                        .ok_or("Stopped")?
                        .try_wait()
                        .map_err(store::err)?
                    {
                        if !status.success() {
                            return Err(
                                "Dependency installation failed. Inspect the preview logs.".into(),
                            );
                        }
                        break;
                    }
                }
                if started.elapsed() > Duration::from_secs(300) {
                    return Err("Dependency installation timed out".into());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let mut args = vec!["run".into(), script.into()];
            if manifest["scripts"][script]
                .as_str()
                .is_some_and(|s| s.contains("vite"))
            {
                if manager == "npm" {
                    args.push("--".into());
                }
                args.extend([
                    "--host".into(),
                    "127.0.0.1".into(),
                    "--port".into(),
                    port.to_string(),
                    "--strictPort".into(),
                ]);
            }
            {
                let mut inner = state.lock()?;
                let service = inner
                    .services
                    .get_mut(&project_id)
                    .filter(|s| s.root == root)
                    .ok_or("Stopped")?;
                let mut child = command(manager, &args, &root, sandboxed, port)?
                    .spawn()
                    .map_err(store::err)?;
                attach(&mut child, &service.logs);
                service.child = Some(child);
            }
            let started = Instant::now();
            loop {
                let mut inner = state.lock()?;
                let service = inner
                    .services
                    .get_mut(&project_id)
                    .filter(|s| s.root == root)
                    .ok_or("Stopped")?;
                if service
                    .child
                    .as_mut()
                    .ok_or("Stopped")?
                    .try_wait()
                    .map_err(store::err)?
                    .is_some()
                {
                    return Err("Preview process exited before becoming ready".into());
                }
                if std::net::TcpStream::connect_timeout(
                    &format!("127.0.0.1:{port}").parse().map_err(store::err)?,
                    Duration::from_millis(100),
                )
                .is_ok()
                {
                    service.phase = "running".into();
                    break;
                }
                drop(inner);
                if started.elapsed() > Duration::from_secs(60) {
                    return Err(
                        "Preview did not listen on the assigned PORT within 60 seconds".into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Ok(())
        })();
        if let Err(error) = result {
            if let Ok(mut inner) = state.lock() {
                if let Some(service) = inner
                    .services
                    .get_mut(&project_id)
                    .filter(|s| s.root == root)
                {
                    service.phase = "crashed".into();
                    service.error = Some(error);
                    if let Some(child) = service.child.as_mut() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
    Ok(json!({"state":"installing","services":[]}))
}
#[tauri::command]
pub fn stop_services(state: State<'_, AppState>, project_id: String) -> Result<()> {
    state.lock()?.services.remove(&project_id);
    Ok(())
}
