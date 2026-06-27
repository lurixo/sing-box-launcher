//! One-shot, sanitized crash dump.
//!
//! Logs are otherwise kept only in memory (nothing is persisted to disk). The
//! one deliberate exception is this dump: on a detected crash — a Rust panic,
//! an unexpected sing-box core exit, or an unclean previous shutdown found at
//! startup — the in-memory log buffer plus a small diagnostic header is written
//! to a single file (`crash-dump.txt`) the user can attach to a bug report.
//!
//! The file is overwrite-only: it never rotates or accumulates, and the user is
//! free to delete it. It is redacted before being written — the core API secret
//! and common credential fields are stripped — and it carries a banner warning
//! that it may still contain network destinations from the session.

use std::path::Path;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::logbus::{self, LogBus};

const DUMP_FILE: &str = "crash-dump.txt";
/// Sentinel written next to the dump whenever one is captured, and cleared the
/// first time it is surfaced at startup. Its presence — NOT a bare "did we exit
/// cleanly" marker — is what tells the next launch a crash dump is waiting, so a
/// normal OS shutdown/reboot of the tray-resident app (no crash, no sentinel)
/// is never mistaken for a crash.
const CRASH_PENDING: &str = ".crash-pending";

/// JSON keys whose string values are masked in any dumped log line.
const SENSITIVE_KEYS: &[&str] = &[
    "password",
    "uuid",
    "private_key",
    "psk",
    "secret",
    "token",
    "auth_str",
    "api_secret",
];

struct CrashState {
    base_dir: PathBuf,
    bus: LogBus,
    /// Current core API secret, scrubbed from any dump. Updated by the manager
    /// on core start/stop so the panic hook + core-exit path can redact it.
    secret: Mutex<Option<String>>,
}

static STATE: OnceLock<CrashState> = OnceLock::new();

/// Install the global crash handler: store the dump context and chain a panic
/// hook that writes a dump before the default hook runs. Call once, early.
pub fn install(base_dir: PathBuf, bus: LogBus) {
    let _ = STATE.set(CrashState {
        base_dir,
        bus,
        secret: Mutex::new(None),
    });
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        report(&format!("Rust panic: {info}"));
        prev(info);
    }));
}

/// Record the core API secret so it can be redacted from dumps. Set on core
/// start; intentionally NOT cleared on stop, so a later panic can still scrub
/// the secret out of log lines buffered while the core was running. A fresh
/// core start overwrites it with the new secret.
pub fn set_secret(secret: Option<String>) {
    if let Some(st) = STATE.get() {
        if let Ok(mut g) = st.secret.lock() {
            *g = secret;
        }
    }
}

/// Write a one-shot crash dump from the current in-memory log buffer. No-op if
/// the handler was never installed.
pub fn report(reason: &str) {
    if let Some(st) = STATE.get() {
        let secret = st.secret.lock().ok().and_then(|g| g.clone());
        write_dump(&st.base_dir, &st.bus, reason, secret.as_deref());
    }
}

/// Surface a crash dump captured in a previous session that has not yet been
/// shown: if the pending sentinel is present, log a one-line pointer to the
/// dump and clear the sentinel (acknowledged). No-op otherwise — crucially, a
/// normal shutdown/reboot or a force-kill that captured no dump leaves no
/// sentinel, so it is never reported as a crash. Safe under allow_multiple: a
/// concurrent second instance only warns if a real dump is actually pending.
/// Called once, from the real instance's setup (after the UAC relaunch and
/// single-instance arbitration).
pub fn surface_pending() {
    let Some(st) = STATE.get() else { return };
    let pending = st.base_dir.join(CRASH_PENDING);
    if pending.exists() {
        st.bus.push(
            "app",
            "warn",
            "a crash dump from a previous session was saved — see crash-dump.txt".into(),
        );
        let _ = std::fs::remove_file(&pending);
    }
}

// ─── dump writer ─────────────────────────────────────────────────────────────

fn write_dump(base_dir: &Path, bus: &LogBus, reason: &str, secret: Option<&str>) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let (version, built_at) = app_build_info(base_dir);
    let s = crate::settings::load_settings(base_dir);

    let mut out = String::new();
    out.push_str("==================== Maestro crash dump ====================\n");
    out.push_str(&format!("Reason:  {reason}\n"));
    out.push_str(&format!("Time:    {}\n", logbus::fmt_utc(now)));
    out.push_str(&format!("Version: {version}   Built: {built_at}\n"));
    out.push_str(&format!(
        "OS:      {} ({})\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    out.push_str(&format!("PID:     {}\n", std::process::id()));
    out.push_str(&format!(
        "Config:  {}   Kernel: {}   Log level: {}\n",
        s.active_config, s.kernel_source, s.log_level
    ));
    out.push_str("\nWARNING: a best-effort pass has stripped the API secret and known\n");
    out.push_str("credential fields, but this dump may still contain network destinations\n");
    out.push_str("(domains, IP addresses) and local listen addresses from your session.\n");
    out.push_str("Review and redact before sharing publicly.\n");
    out.push_str("\n-------------------- in-memory log buffer --------------------\n");
    for l in bus.snapshot() {
        let raw = format!(
            "{} [{:<5}] {}: {}",
            logbus::fmt_utc(l.ts),
            l.level.to_uppercase(),
            l.source,
            l.message
        );
        out.push_str(&redact(&raw, secret));
        out.push('\n');
    }
    out.push_str("============================================================\n");
    if std::fs::write(base_dir.join(DUMP_FILE), out).is_ok() {
        // Flag the dump as unshown so the next launch can point the user at it.
        let _ = std::fs::write(base_dir.join(CRASH_PENDING), reason);
    }
}

/// Read the app's own version + build timestamp from the bundled build-info,
/// without locking the manager (safe to call from a panic hook).
fn app_build_info(base_dir: &Path) -> (String, String) {
    let raw = std::fs::read_to_string(base_dir.join("maestro-build-info.json")).unwrap_or_default();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::Value::Null);
    let get = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_str())
            .unwrap_or("unknown")
            .to_string()
    };
    (get("version"), get("built_at"))
}

// ─── redaction ───────────────────────────────────────────────────────────────

/// Redact a single line with the same rules as the crash dump (the current core
/// API secret + known credential fields). Public so the log export applies the
/// identical scrubbing before any line leaves memory into a user-chosen file.
pub fn redact_line(line: &str) -> String {
    let secret = STATE
        .get()
        .and_then(|st| st.secret.lock().ok().and_then(|g| g.clone()));
    redact(line, secret.as_deref())
}

fn redact(line: &str, secret: Option<&str>) -> String {
    let mut s = line.to_string();
    if let Some(sec) = secret {
        // Only redact a non-trivial secret so a short/empty value can't blank
        // out unrelated text.
        if sec.len() >= 6 {
            s = s.replace(sec, "[REDACTED]");
        }
    }
    for key in SENSITIVE_KEYS {
        s = mask_json_value(&s, key);
        s = mask_kv_value(&s, key);
    }
    s
}

/// Mask the string value following `"key"` in JSON-ish text, e.g.
/// `"password": "hunter2"` -> `"password": "[REDACTED]"`. Handles repeated
/// keys; leaves everything else untouched. Best-effort (no escape handling) —
/// the exact-secret pass above and the banner cover the rest.
fn mask_json_value(s: &str, key: &str) -> String {
    let needle = format!("\"{key}\"");
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut idx = 0;
    while let Some(rel) = s[idx..].find(&needle) {
        let after = idx + rel + needle.len();
        out.push_str(&s[idx..after]);
        // Skip whitespace and the single `:` separator.
        let mut j = after;
        while j < s.len() && (bytes[j] == b' ' || bytes[j] == b'\t' || bytes[j] == b':') {
            j += 1;
        }
        if j < s.len() && bytes[j] == b'"' {
            // Copy up to and including the opening quote, then mask to the close.
            out.push_str(&s[after..=j]);
            let vstart = j + 1;
            if let Some(end_rel) = s[vstart..].find('"') {
                out.push_str("[REDACTED]");
                idx = vstart + end_rel; // leave the closing quote for the next copy
            } else {
                idx = vstart;
            }
        } else {
            idx = after;
        }
    }
    out.push_str(&s[idx..]);
    out
}

/// Mask `key=value` / `key = value` (logfmt-ish) values; the value runs to the
/// next whitespace or comma. Complements mask_json_value for non-JSON core log
/// lines (sing-box is Go and may emit such pairs). Requires a word boundary
/// before the key so `mypassword=` isn't matched on the `password` substring.
fn mask_kv_value(s: &str, key: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut idx = 0;
    while let Some(rel) = s[idx..].find(key) {
        let kstart = idx + rel;
        let kend = kstart + key.len();
        let boundary = kstart == 0
            || !(bytes[kstart - 1].is_ascii_alphanumeric() || bytes[kstart - 1] == b'_');
        // Skip optional spaces between the key and an `=`.
        let mut j = kend;
        while j < s.len() && bytes[j] == b' ' {
            j += 1;
        }
        if boundary && j < s.len() && bytes[j] == b'=' {
            // Copy through the `=` (and any spaces around it).
            let mut k = kend;
            while k < s.len() && (bytes[k] == b' ' || bytes[k] == b'=') {
                k += 1;
            }
            out.push_str(&s[idx..k]);
            // Mask the value up to the next whitespace or comma.
            let vstart = k;
            let mut e = vstart;
            while e < s.len() && !bytes[e].is_ascii_whitespace() && bytes[e] != b',' {
                e += 1;
            }
            if e > vstart {
                out.push_str("[REDACTED]");
            }
            idx = e;
        } else {
            out.push_str(&s[idx..kend]);
            idx = kend;
        }
    }
    out.push_str(&s[idx..]);
    out
}
