use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::{
    CleanCategory, CleanEntry, CleanFailure, CleanResult, CleanScanResult, CleanSection,
    CoreResult,
};

const MAX_ITEMS_PER_CATEGORY: usize = 200;

#[derive(Clone, Copy)]
enum ScanMode {
    /// Treat each top-level child of the root as a separate cleanup item.
    TopLevelChildren,
    /// Treat the entire root directory as a single cleanup item.
    WholeDirectory,
}

#[derive(Clone, Copy)]
enum Risk {
    Safe,
    Review,
}

impl Risk {
    fn as_str(self) -> &'static str {
        match self {
            Risk::Safe => "safe",
            Risk::Review => "review",
        }
    }
}

struct CategoryRule {
    id: &'static str,
    section: &'static str,
    title: &'static str,
    description: &'static str,
    risk: Risk,
    mode: ScanMode,
    roots: Vec<PathBuf>,
}

pub fn scan_clean_targets() -> CoreResult<CleanScanResult> {
    let rules = cleanup_rules();
    if rules.is_empty() {
        return Err("No cleanup rules are available on this platform".to_string());
    }

    let mut by_section: BTreeMap<String, Vec<CleanCategory>> = BTreeMap::new();
    let mut total_freed = 0_u64;
    let mut total_items = 0_usize;

    for rule in &rules {
        let mut items: Vec<CleanEntry> = Vec::new();
        for root in &rule.roots {
            if !root.exists() {
                continue;
            }
            match rule.mode {
                ScanMode::TopLevelChildren => {
                    let entries = match fs::read_dir(root) {
                        Ok(entries) => entries,
                        Err(_) => continue,
                    };
                    for entry in entries.flatten().take(MAX_ITEMS_PER_CATEGORY) {
                        let path = entry.path();
                        let freed = directory_size(&path);
                        if freed == 0 {
                            continue;
                        }
                        items.push(CleanEntry {
                            category: rule.title.to_string(),
                            path: path.to_string_lossy().to_string(),
                            freed,
                        });
                    }
                }
                ScanMode::WholeDirectory => {
                    let freed = directory_size(root);
                    if freed == 0 {
                        continue;
                    }
                    items.push(CleanEntry {
                        category: rule.title.to_string(),
                        path: root.to_string_lossy().to_string(),
                        freed,
                    });
                }
            }
        }

        items.sort_by(|left, right| right.freed.cmp(&left.freed));
        if items.is_empty() {
            continue;
        }

        let total: u64 = items.iter().map(|item| item.freed).sum();
        let count = items.len();
        total_freed = total_freed.saturating_add(total);
        total_items += count;

        let category = CleanCategory {
            id: rule.id.to_string(),
            title: rule.title.to_string(),
            description: rule.description.to_string(),
            risk: rule.risk.as_str().to_string(),
            roots: rule.roots.iter().map(|p| p.to_string_lossy().to_string()).collect(),
            items,
            total_freed: total,
            item_count: count,
        };

        by_section
            .entry(rule.section.to_string())
            .or_default()
            .push(category);
    }

    let section_order = section_order();
    let mut sections: Vec<CleanSection> = by_section
        .into_iter()
        .map(|(name, categories)| CleanSection { name, categories })
        .collect();
    sections.sort_by_key(|section| {
        section_order
            .iter()
            .position(|name| *name == section.name)
            .unwrap_or(usize::MAX)
    });

    Ok(CleanScanResult {
        sections,
        total_freed,
        total_items,
    })
}

pub fn clean_selected(paths: Vec<String>) -> CoreResult<CleanResult> {
    if paths.is_empty() {
        return Err("Select at least one item to delete".to_string());
    }

    let rules = cleanup_rules();
    let mut removed = Vec::new();
    let mut skipped = Vec::new();
    let mut freed_total = 0_u64;

    for raw_path in paths {
        let path = PathBuf::from(&raw_path);
        let Some(rule) = rules.iter().find(|rule| rule_allows(rule, &path)) else {
            skipped.push(CleanFailure {
                category: "未知".to_string(),
                path: raw_path,
                reason: "Path is outside any known cleanup rule".to_string(),
            });
            continue;
        };
        let freed = directory_size(&path);
        if freed == 0 {
            continue;
        }
        match remove_path(&path) {
            Ok(()) => {
                freed_total = freed_total.saturating_add(freed);
                removed.push(CleanEntry {
                    category: rule.title.to_string(),
                    path: raw_path,
                    freed,
                });
            }
            Err(error) => skipped.push(CleanFailure {
                category: rule.title.to_string(),
                path: raw_path,
                reason: error.to_string(),
            }),
        }
    }

    Ok(CleanResult {
        removed,
        skipped,
        freed_total,
    })
}

fn rule_allows(rule: &CategoryRule, path: &Path) -> bool {
    let candidate = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    for root in &rule.roots {
        let canon_root = root.canonicalize().unwrap_or_else(|_| root.clone());
        match rule.mode {
            ScanMode::TopLevelChildren => {
                if candidate.parent() == Some(canon_root.as_path()) {
                    return true;
                }
            }
            ScanMode::WholeDirectory => {
                if candidate == canon_root || candidate.starts_with(&canon_root) {
                    return true;
                }
            }
        }
    }
    false
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn home_path(parts: &[&str]) -> Option<PathBuf> {
    let mut path = home()?;
    for part in parts {
        path = path.join(part);
    }
    Some(path)
}

fn section_order() -> [&'static str; 6] {
    [
        "系统",
        "用户基础",
        "浏览器",
        "开发者工具",
        "应用",
        "其他",
    ]
}

fn cleanup_rules() -> Vec<CategoryRule> {
    let mut rules: Vec<CategoryRule> = Vec::new();
    let push = |rules: &mut Vec<CategoryRule>, rule: CategoryRule| {
        if !rule.roots.is_empty() {
            rules.push(rule);
        }
    };

    let collect = |segments: &[&[&str]]| -> Vec<PathBuf> {
        segments
            .iter()
            .filter_map(|parts| home_path(parts))
            .collect()
    };

    // 系统 / 用户基础
    push(
        &mut rules,
        CategoryRule {
            id: "user_logs",
            section: "系统",
            title: "用户日志",
            description: "Library/Logs 下的应用诊断与崩溃日志，删除后会按需重新生成。",
            risk: Risk::Safe,
            mode: ScanMode::TopLevelChildren,
            roots: collect(&[&["Library", "Logs"]]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "user_caches",
            section: "用户基础",
            title: "应用缓存",
            description: "Library/Caches 各应用的临时缓存目录，删除后应用启动时会重新生成。",
            risk: Risk::Safe,
            mode: ScanMode::TopLevelChildren,
            roots: collect(&[&["Library", "Caches"]]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "tmp",
            section: "用户基础",
            title: "系统临时文件",
            description: "$TMPDIR 中的临时文件，重启后会被系统清理。",
            risk: Risk::Safe,
            mode: ScanMode::TopLevelChildren,
            roots: vec![std::env::temp_dir()],
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "trash",
            section: "用户基础",
            title: "废纸篓",
            description: "~/.Trash 已被丢入废纸篓的文件，删除后无法恢复。",
            risk: Risk::Review,
            mode: ScanMode::TopLevelChildren,
            roots: collect(&[&[".Trash"]]),
        },
    );

    // 浏览器
    push(
        &mut rules,
        CategoryRule {
            id: "chrome",
            section: "浏览器",
            title: "Chrome 缓存",
            description: "Google Chrome 的 Cache / Code Cache / GPUCache 目录，下次启动会重建。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "Application Support", "Google", "Chrome", "Default", "Cache"],
                &["Library", "Application Support", "Google", "Chrome", "Default", "Code Cache"],
                &["Library", "Application Support", "Google", "Chrome", "Default", "GPUCache"],
                &["Library", "Caches", "Google", "Chrome"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "safari",
            section: "浏览器",
            title: "Safari 缓存",
            description: "Safari WebKit 的网络与脚本缓存。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "Caches", "com.apple.Safari"],
                &["Library", "Caches", "com.apple.WebKit.PluginProcess"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "edge",
            section: "浏览器",
            title: "Edge 缓存",
            description: "Microsoft Edge 的 Cache / Code Cache / GPUCache。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "Application Support", "Microsoft Edge", "Default", "Cache"],
                &["Library", "Application Support", "Microsoft Edge", "Default", "Code Cache"],
                &["Library", "Application Support", "Microsoft Edge", "Default", "GPUCache"],
            ]),
        },
    );

    // 开发者工具
    push(
        &mut rules,
        CategoryRule {
            id: "npm",
            section: "开发者工具",
            title: "npm 缓存",
            description: "~/.npm/_cacache 中的 npm 包下载缓存。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[&[".npm", "_cacache"]]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "yarn",
            section: "开发者工具",
            title: "Yarn 缓存",
            description: "Yarn 包管理器的下载缓存。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "Caches", "Yarn"],
                &[".cache", "yarn"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "pnpm",
            section: "开发者工具",
            title: "pnpm 缓存",
            description: "pnpm store 与下载缓存。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "pnpm", "store"],
                &[".local", "share", "pnpm", "store"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "pip",
            section: "开发者工具",
            title: "pip 缓存",
            description: "Python pip 包下载缓存。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[&["Library", "Caches", "pip"]]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "homebrew",
            section: "开发者工具",
            title: "Homebrew 下载缓存",
            description: "Homebrew 已下载的安装包，再次安装时会重新下载。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[&["Library", "Caches", "Homebrew"]]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "cargo",
            section: "开发者工具",
            title: "Rust cargo 注册表缓存",
            description: "~/.cargo/registry/cache 与 git 缓存（不影响已构建的 target/）。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &[".cargo", "registry", "cache"],
                &[".cargo", "registry", "src"],
                &[".cargo", "git", "checkouts"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "xcode_derived",
            section: "开发者工具",
            title: "Xcode DerivedData",
            description: "Xcode 中间编译产物，可能占用数 GB；删除后下次构建会重新生成。",
            risk: Risk::Safe,
            mode: ScanMode::TopLevelChildren,
            roots: collect(&[&["Library", "Developer", "Xcode", "DerivedData"]]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "xcode_archives",
            section: "开发者工具",
            title: "Xcode Archives",
            description: "历史 .xcarchive 归档（提交 App Store 用），删除前请确认无需重发。",
            risk: Risk::Review,
            mode: ScanMode::TopLevelChildren,
            roots: collect(&[&["Library", "Developer", "Xcode", "Archives"]]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "vscode",
            section: "应用",
            title: "VS Code 缓存",
            description: "VS Code 编辑器的代码缓存、GPU 缓存与工作区临时数据。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "Application Support", "Code", "Cache"],
                &["Library", "Application Support", "Code", "CachedData"],
                &["Library", "Application Support", "Code", "Code Cache"],
                &["Library", "Application Support", "Code", "GPUCache"],
                &["Library", "Application Support", "Code", "logs"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "cursor",
            section: "应用",
            title: "Cursor 缓存",
            description: "Cursor 编辑器的代码缓存、GPU 缓存与日志。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "Application Support", "Cursor", "Cache"],
                &["Library", "Application Support", "Cursor", "CachedData"],
                &["Library", "Application Support", "Cursor", "Code Cache"],
                &["Library", "Application Support", "Cursor", "GPUCache"],
                &["Library", "Application Support", "Cursor", "logs"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "slack",
            section: "应用",
            title: "Slack 缓存",
            description: "Slack 桌面端的图片与脚本缓存。",
            risk: Risk::Safe,
            mode: ScanMode::WholeDirectory,
            roots: collect(&[
                &["Library", "Application Support", "Slack", "Cache"],
                &["Library", "Application Support", "Slack", "Code Cache"],
                &["Library", "Application Support", "Slack", "GPUCache"],
                &["Library", "Application Support", "Slack", "Service Worker"],
            ]),
        },
    );

    push(
        &mut rules,
        CategoryRule {
            id: "wechat",
            section: "应用",
            title: "微信缓存",
            description: "微信图片、视频、文件缓存。",
            risk: Risk::Review,
            mode: ScanMode::TopLevelChildren,
            roots: collect(&[
                &["Library", "Containers", "com.tencent.xinWeChat", "Data", "Library", "Caches"],
            ]),
        },
    );

    rules
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
