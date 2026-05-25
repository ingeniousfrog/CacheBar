use std::path::{Path, PathBuf};

use super::clean::{directory_size, remove_path};
use super::{CoreResult, UninstallResult};

pub fn uninstall(app_path: String) -> CoreResult<UninstallResult> {
    let target = validate_uninstall_target(&app_path)?;
    let freed = directory_size(&target);
    let removed_files = vec![target.to_string_lossy().to_string()];

    remove_path(&target)
        .map_err(|err| format!("Unable to remove {}: {}", target.to_string_lossy(), err))?;

    Ok(UninstallResult {
        removed_files,
        freed,
    })
}

fn validate_uninstall_target(path: &str) -> CoreResult<PathBuf> {
    if path.trim().is_empty() {
        return Err("Choose an application path first".to_string());
    }
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("The selected application path does not exist".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|_| "Unable to resolve the selected application path".to_string())?;
    if is_dangerous_root(&canonical) {
        return Err("Refusing to remove a protected system or home directory".to_string());
    }
    if cfg!(target_os = "macos")
        && canonical.extension().and_then(|ext| ext.to_str()) != Some("app")
    {
        return Err("On macOS, choose a .app bundle to uninstall".to_string());
    }
    Ok(canonical)
}

fn is_dangerous_root(path: &Path) -> bool {
    if path.parent().is_none() {
        return true;
    }
    let protected = [
        Path::new("/"),
        Path::new("/Applications"),
        Path::new("/System"),
        Path::new("/Library"),
        Path::new("/Users"),
    ];
    if protected
        .iter()
        .any(|protected_path| path == *protected_path)
    {
        return true;
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .is_some_and(|home| path == home)
}
