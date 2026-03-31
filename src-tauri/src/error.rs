use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Core already running")]
    AlreadyRunning,

    #[error("Core not running")]
    NotRunning,

    #[error("Config error: {0}")]
    Config(String),

    #[error("Process error: {0}")]
    Process(String),

    #[error("Proxy error: {0}")]
    Proxy(String),

    #[error("Clash API error: {0}")]
    ClashApi(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

// Tauri IPC requires errors to be serializable.
// We serialize AppError as a plain string.
impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::ClashApi(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Config(e.to_string())
    }
}
