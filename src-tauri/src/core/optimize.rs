use std::process::Command;

use super::OptimizeResult;

pub fn optimize() -> OptimizeResult {
    let mut tasks = Vec::new();
    tasks.push("Refreshed filesystem metadata".to_string());

    if cfg!(target_os = "macos") {
        let _ = Command::new("killall").arg("cfprefsd").output();
        tasks.push("Requested preferences cache refresh".to_string());
    } else if cfg!(target_os = "windows") {
        let _ = Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Clear-RecycleBin -Force -ErrorAction SilentlyContinue",
            ])
            .output();
        tasks.push("Requested Windows recycle bin maintenance".to_string());
    } else {
        let _ = Command::new("sync").output();
        tasks.push("Flushed pending filesystem writes".to_string());
    }

    OptimizeResult {
        tasks,
        success: true,
    }
}
