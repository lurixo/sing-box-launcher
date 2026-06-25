use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

/// Maximum number of buffered log lines kept since the process started.
const CAP: usize = 5000;

/// A single log line, either from the GUI app or the sing-box core.
#[derive(Debug, Clone, Serialize)]
pub struct LogLine {
    pub source: String,
    pub level: String,
    pub message: String,
    pub seq: u64,
    pub ts: u64,
}

struct Inner {
    lines: VecDeque<LogLine>,
    seq: u64,
    app: Option<AppHandle>,
}

/// In-memory log bus shared between the core reader, the tracing layer and the
/// frontend. New lines are buffered and, once an `AppHandle` is attached,
/// emitted live as `log-line` events.
#[derive(Clone)]
pub struct LogBus(Arc<Mutex<Inner>>);

impl LogBus {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(Inner {
            lines: VecDeque::new(),
            seq: 0,
            app: None,
        })))
    }

    /// Attach the app handle so subsequent lines are emitted live.
    pub fn attach(&self, app: AppHandle) {
        if let Ok(mut g) = self.0.lock() {
            g.app = Some(app);
        }
    }

    pub fn push(&self, source: &str, level: &str, message: String) {
        let (line, app) = {
            let mut g = match self.0.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            g.seq += 1;
            let line = LogLine {
                source: source.to_string(),
                level: normalize_level(level).to_string(),
                message,
                seq: g.seq,
                ts: now_ms(),
            };
            g.lines.push_back(line.clone());
            while g.lines.len() > CAP {
                g.lines.pop_front();
            }
            (line, g.app.clone())
        };
        if let Some(app) = app {
            let _ = app.emit("log-line", &line);
        }
    }

    pub fn snapshot(&self) -> Vec<LogLine> {
        self.0
            .lock()
            .map(|g| g.lines.iter().cloned().collect())
            .unwrap_or_default()
    }

    pub fn clear(&self) {
        if let Ok(mut g) = self.0.lock() {
            g.lines.clear();
        }
    }
}

// ─── IPC commands ────────────────────────────────────────────────────────────

#[tauri::command]
pub fn get_logs(bus: tauri::State<'_, LogBus>) -> Vec<LogLine> {
    bus.snapshot()
}

#[tauri::command]
pub fn clear_logs(bus: tauri::State<'_, LogBus>) {
    bus.clear();
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_level(level: &str) -> &'static str {
    match level.to_ascii_lowercase().as_str() {
        "trace" => "trace",
        "debug" => "debug",
        "warn" | "warning" => "warn",
        "error" | "err" | "fatal" | "panic" => "error",
        _ => "info",
    }
}

/// Extract a log level from a sing-box stdout line by finding the first
/// standalone level token, defaulting to `info`.
pub fn parse_core_level(line: &str) -> &'static str {
    for tok in line.split(|c: char| !c.is_ascii_alphabetic()) {
        match tok.to_ascii_uppercase().as_str() {
            "TRACE" => return "trace",
            "DEBUG" => return "debug",
            "INFO" => return "info",
            "WARN" | "WARNING" => return "warn",
            "ERROR" | "ERR" | "FATAL" | "PANIC" => return "error",
            _ => {}
        }
    }
    "info"
}

// ─── Tracing layer: route the app's own logs into the bus ────────────────────

pub struct BusLayer {
    bus: LogBus,
}

impl BusLayer {
    pub fn new(bus: LogBus) -> Self {
        Self { bus }
    }
}

#[derive(Default)]
struct FieldVisitor {
    message: String,
    fields: String,
}

impl Visit for FieldVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            if !self.fields.is_empty() {
                self.fields.push(' ');
            }
            self.fields.push_str(&format!("{}={:?}", field.name(), value));
        }
    }
}

impl<S> Layer<S> for BusLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let meta = event.metadata();
        let level = meta.level().as_str();
        let mut visitor = FieldVisitor::default();
        event.record(&mut visitor);
        let mut message = visitor.message;
        if !visitor.fields.is_empty() {
            if !message.is_empty() {
                message.push(' ');
            }
            message.push_str(&visitor.fields);
        }
        self.bus.push("app", level, format!("{}: {}", meta.target(), message));
    }
}
