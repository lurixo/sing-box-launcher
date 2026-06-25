/// Marker passed to a relaunched instance so it never tries to elevate again.
const ELEVATED_ARG: &str = "--elevated";

#[cfg(target_os = "windows")]
pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut size = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elevation.TokenIsElevated != 0
    }
}

#[cfg(not(target_os = "windows"))]
pub fn is_elevated() -> bool {
    true
}

/// Relaunch the current executable elevated via a UAC prompt.
/// Returns true if the elevated instance was launched (caller should exit).
#[cfg(target_os = "windows")]
fn relaunch_elevated() -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return false,
    };
    let exe_str = exe.to_string_lossy().replace('\'', "''");
    let ps = format!(
        "Start-Process -FilePath '{exe_str}' -ArgumentList '{ELEVATED_ARG}' -Verb RunAs"
    );

    match std::process::Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
    {
        Ok(status) if status.success() => true,
        Ok(_) => {
            tracing::info!("UAC elevation declined; running unelevated");
            false
        }
        Err(e) => {
            tracing::warn!(error = %e, "powershell elevation spawn failed; running unelevated");
            false
        }
    }
}

/// If `run_as_admin` is set and the process is neither elevated nor already a
/// relaunched instance, relaunch elevated. Returns true when the caller should
/// exit because an elevated instance has taken over. A declined UAC prompt
/// returns false so the app keeps running unelevated.
#[cfg(target_os = "windows")]
pub fn should_exit_for_elevation(run_as_admin: bool) -> bool {
    let already = std::env::args().any(|a| a == ELEVATED_ARG);
    if run_as_admin && !already && !is_elevated() {
        return relaunch_elevated();
    }
    false
}

#[cfg(not(target_os = "windows"))]
pub fn should_exit_for_elevation(_run_as_admin: bool) -> bool {
    false
}

#[tauri::command]
pub fn is_admin() -> bool {
    is_elevated()
}
