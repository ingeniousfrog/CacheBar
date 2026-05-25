use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use super::{CoreResult, DiskInfo, NetworkInfo, PowerInfo, ProcessInfo, StatusSnapshot};

pub fn status() -> CoreResult<StatusSnapshot> {
    let disks = disk_usage()?;
    let root_disk = disks.first();
    let disk_free = root_disk.map(|disk| disk.free).unwrap_or(0);
    let disk_total = root_disk.map(|disk| disk.total).unwrap_or(0);
    let disk_usage = percent(disk_total.saturating_sub(disk_free), disk_total);
    let memory = memory_snapshot();

    Ok(StatusSnapshot {
        cpu_usage: cpu_usage().unwrap_or(0.0),
        mem_usage: percent(memory.used, memory.total),
        mem_used: memory.used,
        mem_total: memory.total,
        mem_available: memory.available,
        mem_cached: memory.cached,
        disk_free,
        disk_total,
        disk_usage,
        disks,
        power: power_info(),
        top_processes: top_processes(),
        network: network_info(),
        uptime: uptime().unwrap_or_else(|| "unknown".to_string()),
        platform: std::env::consts::OS.to_string(),
        collected_at: now_unix_seconds().to_string(),
    })
}

#[derive(Default)]
struct MemorySnapshot {
    used: u64,
    total: u64,
    available: u64,
    cached: u64,
}

fn now_unix_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn percent(used: u64, total: u64) -> f32 {
    if total == 0 {
        return 0.0;
    }
    ((used as f64 / total as f64) * 100.0).clamp(0.0, 100.0) as f32
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}

fn disk_usage() -> CoreResult<Vec<DiskInfo>> {
    let output = command_stdout("df", &["-kP"])
        .ok_or_else(|| "Unable to read disk usage from the operating system".to_string())?;
    let mut disks = Vec::new();

    for line in output.lines().skip(1) {
        let columns: Vec<&str> = line.split_whitespace().collect();
        if columns.len() < 6 {
            continue;
        }
        let total = columns[1].parse::<u64>().unwrap_or(0).saturating_mul(1024);
        let used = columns[2].parse::<u64>().unwrap_or(0).saturating_mul(1024);
        let free = columns[3].parse::<u64>().unwrap_or(0).saturating_mul(1024);
        if total == 0 {
            continue;
        }
        let mount = columns[5].to_string();
        if mount.starts_with("/System/Volumes/Preboot")
            || mount.starts_with("/System/Volumes/VM")
            || mount.starts_with("/System/Volumes/Update")
            || mount.starts_with("/dev")
        {
            continue;
        }
        disks.push(DiskInfo {
            name: short_disk_name(columns[0], &mount),
            mount,
            used,
            free,
            total,
            used_percent: percent(used, total),
        });
    }

    if disks.is_empty() {
        return Err("Disk usage output did not include a usable volume".to_string());
    }
    disks.sort_by(|left, right| {
        if left.mount == "/" {
            std::cmp::Ordering::Less
        } else if right.mount == "/" {
            std::cmp::Ordering::Greater
        } else {
            right.total.cmp(&left.total)
        }
    });
    Ok(disks.into_iter().take(4).collect())
}

fn short_disk_name(device: &str, mount: &str) -> String {
    if mount == "/" {
        return "System".to_string();
    }
    mount
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(device)
        .chars()
        .take(12)
        .collect()
}

#[cfg(target_os = "linux")]
fn cpu_usage() -> Option<f32> {
    let first = read_linux_cpu_sample()?;
    std::thread::sleep(std::time::Duration::from_millis(120));
    let second = read_linux_cpu_sample()?;
    let total = second.0.checked_sub(first.0)?;
    let idle = second.1.checked_sub(first.1)?;
    if total == 0 {
        return Some(0.0);
    }
    Some((((total - idle) as f64 / total as f64) * 100.0) as f32)
}

#[cfg(target_os = "linux")]
fn read_linux_cpu_sample() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    let columns: Vec<u64> = stat
        .lines()
        .next()?
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse::<u64>().ok())
        .collect();
    if columns.len() < 4 {
        return None;
    }
    let idle = columns.get(3).copied().unwrap_or(0) + columns.get(4).copied().unwrap_or(0);
    let total = columns.iter().sum();
    Some((total, idle))
}

#[cfg(target_os = "macos")]
fn cpu_usage() -> Option<f32> {
    let output = command_stdout("top", &["-l", "1", "-n", "0", "-s", "0"])?;
    let line = output.lines().find(|line| line.contains("CPU usage"))?;
    let idle_part = line.split(',').find(|part| part.contains("idle"))?.trim();
    let idle_text = idle_part.split_whitespace().next()?.trim_end_matches('%');
    let idle = idle_text.parse::<f32>().ok()?;
    Some((100.0 - idle).clamp(0.0, 100.0))
}

#[cfg(target_os = "windows")]
fn cpu_usage() -> Option<f32> {
    let output = command_stdout(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "(Get-Counter '\\Processor(_Total)\\% Processor Time').CounterSamples.CookedValue",
        ],
    )?;
    output
        .trim()
        .parse::<f32>()
        .ok()
        .map(|value| value.clamp(0.0, 100.0))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn cpu_usage() -> Option<f32> {
    None
}

#[cfg(target_os = "linux")]
#[cfg(target_os = "linux")]
fn memory_snapshot() -> MemorySnapshot {
    let Some((used, total, available, cached)) = linux_memory_bytes() else {
        return MemorySnapshot::default();
    };
    MemorySnapshot {
        used,
        total,
        available,
        cached,
    }
}

#[cfg(target_os = "linux")]
fn linux_memory_bytes() -> Option<(u64, u64, u64, u64)> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    let mut total = 0_u64;
    let mut available = 0_u64;
    let mut cached = 0_u64;
    for line in meminfo.lines() {
        let mut parts = line.split_whitespace();
        match parts.next()? {
            "MemTotal:" => total = parts.next()?.parse::<u64>().ok()?,
            "MemAvailable:" => available = parts.next()?.parse::<u64>().ok()?,
            "Cached:" => cached = parts.next()?.parse::<u64>().ok()?,
            _ => {}
        }
    }
    Some((
        total.saturating_sub(available).saturating_mul(1024),
        total.saturating_mul(1024),
        available.saturating_mul(1024),
        cached.saturating_mul(1024),
    ))
}

#[cfg(target_os = "macos")]
fn memory_snapshot() -> MemorySnapshot {
    let Some((used, total, available, cached)) = macos_memory_bytes() else {
        return MemorySnapshot::default();
    };
    MemorySnapshot {
        used,
        total,
        available,
        cached,
    }
}

#[cfg(target_os = "macos")]
fn macos_memory_bytes() -> Option<(u64, u64, u64, u64)> {
    let total_text = command_stdout("sysctl", &["-n", "hw.memsize"])?;
    let total = total_text.trim().parse::<u64>().ok()?;
    let page_size_text = command_stdout("pagesize", &[])?;
    let page_size = page_size_text.trim().parse::<u64>().ok()?;
    let vm_stat = command_stdout("vm_stat", &[])?;

    let mut free_pages = 0_u64;
    let mut inactive_pages = 0_u64;
    let mut speculative_pages = 0_u64;
    for line in vm_stat.lines() {
        if line.starts_with("Pages free") {
            free_pages = vm_stat_value(line);
        }
        if line.starts_with("Pages inactive") {
            inactive_pages = vm_stat_value(line);
        }
        if line.starts_with("Pages speculative") {
            speculative_pages = vm_stat_value(line);
        }
    }

    let available = free_pages
        .saturating_add(inactive_pages)
        .saturating_add(speculative_pages)
        .saturating_mul(page_size);
    let cached = inactive_pages
        .saturating_add(speculative_pages)
        .saturating_mul(page_size);
    Some((total.saturating_sub(available), total, available, cached))
}

#[cfg(target_os = "macos")]
fn vm_stat_value(line: &str) -> u64 {
    line.split(':')
        .nth(1)
        .map(|raw| raw.trim().trim_end_matches('.').replace('.', ""))
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "windows")]
fn memory_snapshot() -> MemorySnapshot {
    let output = command_stdout(
        "powershell",
        &[
            "-NoProfile",
            "-Command",
            "$os = Get-CimInstance Win32_OperatingSystem; (($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / $os.TotalVisibleMemorySize) * 100",
        ],
    );
    let usage = output
        .and_then(|value| value.trim().parse::<f32>().ok())
        .unwrap_or(0.0)
        .clamp(0.0, 100.0);
    MemorySnapshot {
        used: usage as u64,
        total: 100,
        available: 100_u64.saturating_sub(usage as u64),
        cached: 0,
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn memory_snapshot() -> MemorySnapshot {
    MemorySnapshot::default()
}

#[cfg(target_os = "linux")]
fn uptime() -> Option<String> {
    let raw = std::fs::read_to_string("/proc/uptime").ok()?;
    let seconds = raw.split_whitespace().next()?.parse::<f64>().ok()? as u64;
    Some(format_duration(seconds))
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn uptime() -> Option<String> {
    let output = if cfg!(target_os = "windows") {
        command_stdout(
            "powershell",
            &["-NoProfile", "-Command", "(Get-Uptime).TotalSeconds"],
        )?
    } else {
        command_stdout("sysctl", &["-n", "kern.boottime"])?
    };

    if cfg!(target_os = "windows") {
        let seconds = output.trim().parse::<f64>().ok()? as u64;
        return Some(format_duration(seconds));
    }

    let boot_seconds = output
        .split("sec = ")
        .nth(1)?
        .split(',')
        .next()?
        .trim()
        .parse::<u64>()
        .ok()?;
    Some(format_duration(
        now_unix_seconds().saturating_sub(boot_seconds),
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn uptime() -> Option<String> {
    None
}

fn format_duration(seconds: u64) -> String {
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;
    if days > 0 {
        format!("{days}d {hours}h")
    } else if hours > 0 {
        format!("{hours}h {minutes}m")
    } else {
        format!("{minutes}m")
    }
}

#[cfg(target_os = "macos")]
fn power_info() -> Option<PowerInfo> {
    let output = command_stdout("pmset", &["-g", "batt"])?;
    let detail = output.lines().find(|line| line.contains('%'))?;
    let percent_text = detail.split('%').next()?.split_whitespace().last()?;
    let percent = percent_text.parse::<f32>().ok()?;
    let status = if detail.contains("discharging") {
        "Battery".to_string()
    } else if detail.contains("charged") {
        "Charged".to_string()
    } else if detail.contains("charging") {
        "Charging".to_string()
    } else {
        "Power".to_string()
    };
    let time_left = detail
        .split(';')
        .nth(2)
        .map(|value| {
            value
                .trim()
                .split(" present:")
                .next()
                .unwrap_or("estimating")
                .trim()
                .to_string()
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "estimating".to_string());
    Some(PowerInfo {
        percent,
        status,
        time_left,
    })
}

#[cfg(not(target_os = "macos"))]
fn power_info() -> Option<PowerInfo> {
    None
}

#[cfg(target_os = "macos")]
fn top_processes() -> Vec<ProcessInfo> {
    let Some(output) = command_stdout("ps", &["-arcwwwxo", "comm,%cpu"]) else {
        return Vec::new();
    };
    output
        .lines()
        .skip(1)
        .filter_map(parse_process_line)
        .take(4)
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn top_processes() -> Vec<ProcessInfo> {
    Vec::new()
}

fn parse_process_line(line: &str) -> Option<ProcessInfo> {
    let mut parts = line.rsplitn(2, char::is_whitespace);
    let cpu = parts.next()?.trim().parse::<f32>().ok()?;
    let name = parts
        .next()?
        .trim()
        .rsplit('/')
        .next()
        .unwrap_or("Process")
        .chars()
        .take(18)
        .collect::<String>();
    if name.is_empty() {
        return None;
    }
    Some(ProcessInfo { name, cpu })
}

#[cfg(target_os = "macos")]
fn network_info() -> Option<NetworkInfo> {
    for name in ["en0", "en1", "bridge0"] {
        if let Some(ip) = command_stdout("ipconfig", &["getifaddr", name])
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return Some(NetworkInfo {
                name: name.to_string(),
                ip,
            });
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn network_info() -> Option<NetworkInfo> {
    None
}
