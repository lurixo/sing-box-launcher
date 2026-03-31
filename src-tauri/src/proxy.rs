use crate::error::AppError;

#[cfg(target_os = "windows")]
use tracing::info;

/// Default bypass list for system proxy
pub const PROXY_BYPASS: &str = "localhost;127.*;10.*;172.16.*;172.17.*;172.18.*;172.19.*;\
    172.20.*;172.21.*;172.22.*;172.23.*;172.24.*;172.25.*;172.26.*;172.27.*;\
    172.28.*;172.29.*;172.30.*;172.31.*;192.168.*;<local>";

/// Set or clear the Windows system proxy.
#[cfg(target_os = "windows")]
pub fn set_system_proxy(enable: bool, server: &str, bypass: &str) -> Result<(), AppError> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu
        .create_subkey(r"Software\Microsoft\Windows\CurrentVersion\Internet Settings")
        .map_err(|e| AppError::Proxy(format!("open registry: {e}")))?;

    if enable {
        key.set_value("ProxyEnable", &1u32)
            .map_err(|e| AppError::Proxy(format!("set ProxyEnable: {e}")))?;
        key.set_value("ProxyServer", &server)
            .map_err(|e| AppError::Proxy(format!("set ProxyServer: {e}")))?;
        if !bypass.is_empty() {
            let _ = key.set_value("ProxyOverride", &bypass);
        }
        info!(server = %server, "system proxy enabled");
    } else {
        key.set_value("ProxyEnable", &0u32)
            .map_err(|e| AppError::Proxy(format!("set ProxyEnable: {e}")))?;
        info!("system proxy disabled");
    }

    // Notify Windows to re-read proxy settings immediately
    notify_proxy_change();

    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn set_system_proxy(_enable: bool, _server: &str, _bypass: &str) -> Result<(), AppError> {
    Err(AppError::Proxy("system proxy is only supported on Windows".into()))
}

/// Call WinINet InternetSetOptionW to force Windows to refresh proxy settings.
#[cfg(target_os = "windows")]
fn notify_proxy_change() {
    use windows::Win32::Networking::WinInet::{
        InternetSetOptionW, INTERNET_OPTION_REFRESH, INTERNET_OPTION_SETTINGS_CHANGED,
    };

    unsafe {
        let _ = InternetSetOptionW(None, INTERNET_OPTION_SETTINGS_CHANGED, None);
        let _ = InternetSetOptionW(None, INTERNET_OPTION_REFRESH, None);
    }
}
