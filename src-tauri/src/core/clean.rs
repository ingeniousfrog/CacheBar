use std::fs;
use std::path::{Path, PathBuf};

use super::{CleanEntry, CleanFailure, CleanResult, CoreResult};

const MAX_TARGETS_PER_ROOT: usize = 150;

pub fn scan_clean_targets() -> CoreResult<Vec<CleanEntry>> {
    let roots = cleanup_roots();
    if roots.is_empty() {
        return Err("No safe cache directories were found for this user".to_string());
    }

    let mut results = Vec::new();
    for root in roots {
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten().take(MAX_TARGETS_PER_ROOT) {
            let path = entry.path();
            if !is_safe_cleanup_child(&root, &path) {
                continue;
            }
            let freed = directory_size(&path);
            if freed == 0 {
                continue;
            }
            results.push(CleanEntry {
                category: cleanup_category(&root),
                path: path.to_string_lossy().to_string(),
                freed,
            });
        }
    }

    Ok(results)
}

pub fn clean_selected(paths: Vec<String>) -> CoreResult<CleanResult> {
    if paths.is_empty() {
        return Err("Select at least one item to delete".to_string());
    }

    let roots = cleanup_roots();
    let mut removed = Vec::new();
    let mut skipped = Vec::new();
    for raw_path in paths {
        let path = PathBuf::from(&raw_path);
        let Some(root) = roots.iter().find(|root| is_safe_cleanup_child(root, &path)) else {
            return Err(format!("Refusing to delete an unsafe path: {raw_path}"));
        };
        let freed = directory_size(&path);
        if freed == 0 {
            continue;
        }
        let category = cleanup_category(root);
        match remove_path(&path) {
            Ok(()) => removed.push(CleanEntry {
                category,
                path: raw_path,
                freed,
            }),
            Err(error) => skipped.push(CleanFailure {
                category,
                path: raw_path,
                reason: error.to_string(),
            }),
        }
    }

    Ok(CleanResult { removed, skipped })
}

fn cleanup_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = home_dir() {
        if cfg!(target_os = "macos") {
            roots.push(home.join("Library").join("Caches"));
            roots.push(home.join("Library").join("Logs"));
        }
        roots.push(home.join(".cache"));
    }
    roots.push(std::env::temp_dir());
    roots
        .into_iter()
        .filter(|path| path.exists() && path.is_dir())
        .collect()
}

fn cleanup_category(root: &Path) -> String {
    let text = root.to_string_lossy();
    if text.ends_with("Library/Caches") {
        return "应用缓存".to_string();
    }
    if text.ends_with("Library/Logs") {
        return "日志文件".to_string();
    }
    if root == std::env::temp_dir() {
        return "临时文件".to_string();
    }
    "用户缓存".to_string()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn is_safe_cleanup_child(root: &Path, path: &Path) -> bool {
    let Ok(root) = root.canonicalize() else {
        return false;
    };
    let Ok(path) = path.canonicalize() else {
        return false;
    };
    path.starts_with(&root) && path != root && path.parent() == Some(root.as_path())
}

pub fn directory_size(path: &Path) -> u64 {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return 0;
    };
    if metadata.is_file() {
        return metadata.len();
    }
    if !metadata.is_dir() {
        return 0;
    }

    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| directory_size(&entry.path()))
        .sum()
}

pub fn remove_path(path: &Path) -> std::io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}
