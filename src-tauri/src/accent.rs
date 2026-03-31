use crate::error::AppError;

/// Read the Windows system accent color from the registry.
/// Returns a hex string like "#0078D4".
///
/// Registry key: HKCU\SOFTWARE\Microsoft\Windows\DWM\AccentColor
/// Value format: DWORD in ABGR (alpha-blue-green-red)
#[cfg(target_os = "windows")]
#[tauri::command]
pub fn get_system_accent() -> Result<String, AppError> {
    use winreg::enums::*;
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey(r"SOFTWARE\Microsoft\Windows\DWM")
        .map_err(|e| AppError::Other(format!("open DWM registry: {e}")))?;

    let abgr: u32 = key
        .get_value("AccentColor")
        .map_err(|e| AppError::Other(format!("read AccentColor: {e}")))?;

    // ABGR → RGB
    let r = abgr & 0xFF;
    let g = (abgr >> 8) & 0xFF;
    let b = (abgr >> 16) & 0xFF;

    Ok(format!("#{:02X}{:02X}{:02X}", r, g, b))
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn get_system_accent() -> Result<String, AppError> {
    // Fallback: return default blue
    Ok("#0078D4".to_string())
}
