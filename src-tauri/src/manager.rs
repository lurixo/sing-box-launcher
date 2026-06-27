use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::{self, ConfigInfo};
use crate::error::AppError;
use crate::logbus::{self, LogBus};

/// Core process status exposed to the frontend
#[derive(Debug, Clone, serde::Serialize)]
pub struct CoreStatus {
    pub running: bool,
    pub proxy_server: String,
    pub api_address: String,
    pub uptime_secs: u64,
    pub proxy_enabled: bool,
}

/// Internal state for the manager
pub struct ManagerInner {
    pub base_dir: PathBuf,
    child: Option<Child>,
    pub running: bool,
    pub proxy_server: String,
    pub api_address: String,
    pub api_secret: String,
    pub proxy_enabled: bool,
    /// Bumped on every successful start so per-session background tasks (e.g.
    /// the metrics stream) can detect a restart and exit.
    pub generation: u64,
    /// sha256 of the staged core/app binary, captured at download time. Held in
    /// this (elevated) process's memory — not on disk where a non-elevated
    /// process could rewrite it — so apply can re-verify the staged `.new`
    /// bytes before swapping them into an admin-executed binary.
    pub staged_core_sha: Option<String>,
    pub staged_app_sha: Option<String>,
    /// sha256 of the staged installer (`*-setup.exe`) for an installed build's
    /// self-update — same in-memory integrity anchor as the others.
    pub staged_setup_sha: Option<String>,
    /// sha256 of the retained PREVIOUS core/app binary (`*.prev`), captured when
    /// an update is applied. Lets a same-session rollback re-verify the backup
    /// before swapping it into the admin-executed slot. Cleared on restart — a
    /// cross-session rollback's `.prev` integrity rests on filesystem ACLs, the
    /// same residual as the staged files (see review notes).
    pub prev_core_sha: Option<String>,
    pub prev_app_sha: Option<String>,
    started_at: Option<std::time::Instant>,
    logbus: LogBus,
}

pub type Manager = Arc<Mutex<ManagerInner>>;

pub fn new_manager(base_dir: PathBuf, logbus: LogBus) -> Manager {
    Arc::new(Mutex::new(ManagerInner {
        base_dir,
        child: None,
        running: false,
        proxy_server: String::new(),
        api_address: String::new(),
        api_secret: String::new(),
        proxy_enabled: false,
        generation: 0,
        staged_core_sha: None,
        staged_app_sha: None,
        staged_setup_sha: None,
        prev_core_sha: None,
        prev_app_sha: None,
        started_at: None,
        logbus,
    }))
}

impl ManagerInner {
    /// Check that sing-box.exe and the active config exist
    pub fn validate_files(&self, config_name: &str) -> Result<(), AppError> {
        let sb = self.base_dir.join("sing-box.exe");
        if !sb.exists() {
            return Err(AppError::Config(format!(
                "sing-box.exe not found in {}",
                self.base_dir.display()
            )));
        }
        let cfg = self.base_dir.join("configs").join(format!("{config_name}.json"));
        if !cfg.exists() {
            return Err(AppError::Config(format!(
                "Config '{}' not found. Create or import a config first.", config_name
            )));
        }
        Ok(())
    }

    /// Start the sing-box process
    pub async fn start(&mut self) -> Result<ConfigInfo, AppError> {
        if self.running {
            return Err(AppError::AlreadyRunning);
        }

        // Reclaim a leftover orphan core from a previous session (e.g. the app
        // exited with exit_core_on_close off, or crashed) so its still-bound
        // ports don't collide with the core we're about to spawn.
        kill_stale_core(&self.base_dir);

        let settings = crate::settings::load_settings(&self.base_dir);
        let config_name = settings.active_config.clone();

        self.validate_files(&config_name)?;

        // The core always runs at trace (full detail) via a non-destructive
        // runtime override; the GUI filters the view. Log lines are kept only in
        // the in-memory bus and never written to disk. configs/<name>.json is
        // untouched.
        let info =
            config::prepare_runtime_config(&self.base_dir, &config_name, "trace")?;

        let runtime_path = self.base_dir.join("config_runtime.json");
        let sb_path = self.base_dir.join("sing-box.exe");

        let mut child = build_command(&sb_path, &runtime_path, &self.base_dir)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AppError::Process(format!("spawn sing-box: {e}")))?;

        if let Some(out) = child.stdout.take() {
            spawn_reader(out, self.logbus.clone());
        }
        if let Some(err) = child.stderr.take() {
            spawn_reader(err, self.logbus.clone());
        }

        // Catch configs that make sing-box exit immediately on startup.
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(Some(st)) = child.try_wait() {
            // Give the readers a moment to drain the closed pipes.
            tokio::time::sleep(Duration::from_millis(250)).await;
            let tail = core_log_tail(&self.logbus);
            return Err(AppError::Process(format!(
                "sing-box exited on startup (code {:?}). {tail}",
                st.code()
            )));
        }

        self.child = Some(child);
        // Record the core PID so a future session can detect/kill an orphan.
        if let Some(pid) = self.child.as_ref().and_then(|c| c.id()) {
            let _ = std::fs::write(self.base_dir.join("core.pid"), pid.to_string());
        }
        self.running = true;
        self.generation = self.generation.wrapping_add(1);
        self.proxy_server = info.proxy_server.clone();
        self.api_address = info.api_address.clone();
        self.api_secret = info.api_secret.clone();
        // Hand the live secret to the crash handler so it can be scrubbed from
        // any dump (panic / unexpected core exit) written while the core runs.
        crate::crash::set_secret(Some(self.api_secret.clone()));
        self.started_at = Some(std::time::Instant::now());

        info!(
            proxy = %info.proxy_server,
            api = %info.api_address,
            "sing-box started"
        );

        Ok(info)
    }

    /// Reconcile `running` with the actual process state.
    pub fn refresh_running(&mut self) {
        self.reap();
    }

    /// Reap the child if it exited on its own, resetting state and clearing
    /// the system proxy so a crashed core is never reported as running.
    fn reap(&mut self) {
        if let Some(child) = self.child.as_mut() {
            if let Ok(Some(st)) = child.try_wait() {
                warn!(code = ?st.code(), "sing-box exited unexpectedly");
                // A core that dies on its own (not via stop()) is a crash worth a
                // one-shot dump for bug reports.
                crate::crash::report(&format!(
                    "sing-box core exited unexpectedly (code {:?})",
                    st.code()
                ));
                self.child = None;
                self.running = false;
                self.started_at = None;
                let _ = std::fs::remove_file(self.base_dir.join("core.pid"));
                self.proxy_server.clear();
                self.api_address.clear();
                self.api_secret.clear();
                if self.proxy_enabled {
                    self.proxy_enabled = false;
                    let _ = crate::proxy::set_system_proxy(false, "", "");
                }
            }
        }
    }

    /// Stop the sing-box process
    pub async fn stop(&mut self) -> Result<(), AppError> {
        if let Some(ref mut child) = self.child {
            child
                .kill()
                .await
                .map_err(|e| AppError::Process(format!("kill process: {e}")))?;
            info!("sing-box process killed");
        }

        self.child = None;
        self.running = false;
        self.started_at = None;
        let _ = std::fs::remove_file(self.base_dir.join("core.pid"));
        Ok(())
    }

    /// Get current status
    pub fn status(&mut self) -> CoreStatus {
        self.reap();
        let uptime = self
            .started_at
            .map(|t| t.elapsed().as_secs())
            .unwrap_or(0);

        CoreStatus {
            running: self.running,
            proxy_server: self.proxy_server.clone(),
            api_address: self.api_address.clone(),
            uptime_secs: uptime,
            proxy_enabled: self.proxy_enabled,
        }
    }
}

/// Resolve the directory containing the executable.
pub fn resolve_base_dir() -> PathBuf {
    std::env::current_exe()
        .map(|p| p.parent().unwrap_or(Path::new(".")).to_path_buf())
        .unwrap_or_else(|_| PathBuf::from("."))
}

/// The application data directory: a `data/` folder next to the executable.
/// Everything except the GUI binary (core, tools, configs, settings, cache,
/// runtime config, logs) lives here to keep the install folder tidy.
pub fn data_dir() -> PathBuf {
    resolve_base_dir().join("data")
}

/// Kill a leftover core process recorded in `core.pid` from a previous session.
/// Verifies the PID is actually a live sing-box process before killing (guards
/// against PID reuse), then removes the stale pidfile.
#[cfg(target_os = "windows")]
fn kill_stale_core(base_dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let pidfile = base_dir.join("core.pid");
    let pid: u32 = match std::fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse().ok()) {
        Some(p) => p,
        None => {
            let _ = std::fs::remove_file(&pidfile);
            return;
        }
    };

    // Confirm the PID is a live sing-box.exe before terminating it.
    let is_core = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains("sing-box.exe"))
        .unwrap_or(false);

    if is_core {
        warn!(pid, "killing orphan core from a previous session");
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    let _ = std::fs::remove_file(&pidfile);
}

#[cfg(not(target_os = "windows"))]
fn kill_stale_core(_base_dir: &Path) {}

/// Build the sing-box run command without a console window on Windows.
fn build_command(sb_path: &Path, runtime_path: &Path, base_dir: &Path) -> Command {
    let mut cmd = Command::new(sb_path);
    cmd.args(["run", "-c"])
        .arg(runtime_path)
        .args(["-D"])
        .arg(base_dir)
        .current_dir(base_dir);
    #[cfg(target_os = "windows")]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Read core lines from a process pipe and forward each to the in-memory bus.
/// Nothing is written to disk — the bus is the only log sink.
fn spawn_reader<R>(reader: R, bus: LogBus)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            // Strip the core's ANSI colour codes before parsing/pushing so the
            // level is read correctly and the stored/exported text is clean.
            let line = logbus::strip_ansi(&line);
            let level = logbus::parse_core_level(&line);
            bus.push("core", level, line);
        }
    });
}

/// Build a short tail of the most recent core log lines for error messages.
fn core_log_tail(bus: &LogBus) -> String {
    let lines: Vec<String> = bus
        .snapshot()
        .into_iter()
        .filter(|l| l.source == "core")
        .map(|l| l.message)
        .collect();
    let start = lines.len().saturating_sub(15);
    let tail = lines[start..].join("\n");
    if tail.trim().is_empty() {
        String::new()
    } else {
        format!("Log: {tail}")
    }
}
