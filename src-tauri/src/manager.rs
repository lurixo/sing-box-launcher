use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tracing::info;

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

        let child = Command::new(&sb_path)
            .args(["run", "-c"])
            .arg(&runtime_path)
            .args(["-D"])
            .arg(&self.base_dir)
            .current_dir(&self.base_dir)
            .stdout(std::process::Stdio::from(log_file))
            .stderr(std::process::Stdio::from(log_file_err))
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| AppError::Process(format!("spawn sing-box: {e}")))?;

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
    pub fn status(&self) -> CoreStatus {
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
