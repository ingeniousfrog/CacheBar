use std::fs;
use std::path::{Path, PathBuf};

use super::{AnalysisNode, CoreResult};

const MAX_DEPTH: usize = 4;
const MAX_CHILDREN: usize = 80;

pub fn analyse(path: String) -> CoreResult<Vec<AnalysisNode>> {
    let target = validate_readable_path(&path)?;
    let mut children = read_children(&target, 0)?;
    children.sort_by(|left, right| right.size.cmp(&left.size));
    Ok(children)
}

fn validate_readable_path(path: &str) -> CoreResult<PathBuf> {
    if path.trim().is_empty() {
        return Err("Choose a directory to analyse first".to_string());
    }
    let target = PathBuf::from(path);
    if !target.exists() {
        return Err("The selected path does not exist".to_string());
    }
    if !target.is_dir() {
        return Err("Disk analysis requires a directory path".to_string());
    }
    target
        .canonicalize()
        .map_err(|_| "Unable to resolve the selected directory".to_string())
}

fn read_children(path: &Path, depth: usize) -> CoreResult<Vec<AnalysisNode>> {
    let entries = fs::read_dir(path).map_err(|_| format!("Unable to read {}", path.display()))?;
    let mut nodes = Vec::new();

    for entry in entries.flatten().take(MAX_CHILDREN) {
        if let Ok(node) = read_node(&entry.path(), depth) {
            nodes.push(node);
        }
    }

    nodes.sort_by(|left, right| right.size.cmp(&left.size));
    Ok(nodes)
}

fn read_node(path: &Path, depth: usize) -> CoreResult<AnalysisNode> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| format!("Unable to inspect {}", path.display()))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| path.to_string_lossy().to_string());

    if metadata.is_dir() && depth < MAX_DEPTH {
        let children = read_children(path, depth + 1).unwrap_or_default();
        let size = children.iter().map(|child| child.size).sum();
        return Ok(AnalysisNode {
            name,
            path: path.to_string_lossy().to_string(),
            size,
            children,
        });
    }

    let size = if metadata.is_file() {
        metadata.len()
    } else {
        0
    };
    Ok(AnalysisNode {
        name,
        path: path.to_string_lossy().to_string(),
        size,
        children: Vec::new(),
    })
}
