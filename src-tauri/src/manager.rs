use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::config::{self, ConfigInfo};
use crate::error::AppError;

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
    started_at: Option<std::time::Instant>,
}

pub type Manager = Arc<Mutex<ManagerInner>>;

pub fn new_manager(base_dir: PathBuf) -> Manager {
    Arc::new(Mutex::new(ManagerInner {
        base_dir,
        child: None,
        running: false,
        proxy_server: String::new(),
        api_address: String::new(),
        api_secret: String::new(),
        proxy_enabled: false,
        started_at: None,
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

        let settings = crate::settings::load_settings(&self.base_dir);
        let config_name = &settings.active_config;

        self.validate_files(config_name)?;

        // Prepare runtime config
        let info = config::prepare_runtime_config(&self.base_dir, config_name)?;

        let runtime_path = self.base_dir.join("config_runtime.json");
        let sb_path = self.base_dir.join("sing-box.exe");
        let log_path = self.base_dir.join("sing-box.log");

        // Open log file for stdout/stderr
        let log_file = std::fs::File::create(&log_path)
            .map_err(|e| AppError::Process(format!("create log file: {e}")))?;
        let log_file_err = log_file
            .try_clone()
            .map_err(|e| AppError::Process(format!("clone log file: {e}")))?;

        let mut child = build_command(&sb_path, &runtime_path, &self.base_dir)
            .stdout(std::process::Stdio::from(log_file))
            .stderr(std::process::Stdio::from(log_file_err))
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AppError::Process(format!("spawn sing-box: {e}")))?;

        // Catch configs that make sing-box exit immediately on startup.
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Ok(Some(st)) = child.try_wait() {
            let tail = read_log_tail(&log_path, 1200);
            return Err(AppError::Process(format!(
                "sing-box exited on startup (code {:?}). {tail}",
                st.code()
            )));
        }

        self.child = Some(child);
        self.running = true;
        self.proxy_server = info.proxy_server.clone();
        self.api_address = info.api_address.clone();
        self.api_secret = info.api_secret.clone();
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
                self.child = None;
                self.running = false;
                self.started_at = None;
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

/// Resolve the base directory (directory containing the executable)
pub fn resolve_base_dir() -> PathBuf {
    std::env::current_exe()
        .map(|p| p.parent().unwrap_or(Path::new(".")).to_path_buf())
        .unwrap_or_else(|_| PathBuf::from("."))
}

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

/// Read the trailing portion of a log file (last `max` chars), char-safe.
fn read_log_tail(path: &Path, max: usize) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let tail: String = trimmed
        .chars()
        .rev()
        .take(max)
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    format!("Log: {tail}")
}
