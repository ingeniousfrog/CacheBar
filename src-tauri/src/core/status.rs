use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use super::{CoreResult, DiskInfo, NetworkInfo, PowerInfo, ProcessInfo, StatusSnapshot};

static SAMPLER: OnceLock<Mutex<SamplerState>> = OnceLock::new();

struct SamplerState {
    last_net: Option<NetSample>,
    last_disk_io: HashMap<String, DiskIoSample>,
    last_hw_at: Option<Instant>,
    last_hw_failure_at: Option<Instant>,
    cached_cpu_temp: Option<f32>,
    cached_fan_rpm: Option<u32>,
    cached_disk_temps: HashMap<String, f32>,
}

struct NetSample {
    iface: String,
    rx_bytes: u64,
    tx_bytes: u64,
    at: Instant,
}

struct DiskIoSample {
    read_bytes: u64,
    write_bytes: u64,
    at: Instant,
}

fn sampler() -> &'static Mutex<SamplerState> {
    SAMPLER.get_or_init(|| {
        Mutex::new(SamplerState {
            last_net: None,
            last_disk_io: HashMap::new(),
            last_hw_at: None,
            last_hw_failure_at: None,
            cached_cpu_temp: None,
            cached_fan_rpm: None,
            cached_disk_temps: HashMap::new(),
        })
    })
}

pub fn status() -> CoreResult<StatusSnapshot> {
    let mut disks = disk_usage()?;
    let root_disk = disks.first();
    let disk_free = root_disk.map(|disk| disk.free).unwrap_or(0);
    let disk_total = root_disk.map(|disk| disk.total).unwrap_or(0);
    let disk_usage = percent(disk_total.saturating_sub(disk_free), disk_total);
    let memory = memory_snapshot();
    let cpu_breakdown = cpu_breakdown().unwrap_or((0.0, 0.0, 100.0));
    let (cpu_user, cpu_system, cpu_idle) = cpu_breakdown;
    let cpu_usage = (cpu_user + cpu_system).clamp(0.0, 100.0);

    let mut state = sampler().lock().map_err(|_| "Sampler lock poisoned".to_string())?;
    apply_disk_io_rates(&mut state, &mut disks);
    apply_hw_metrics(&mut state);
    let network = network_info_with_rates(&mut state);
    let cpu_temp_c = state.cached_cpu_temp;
    let fan_rpm = state.cached_fan_rpm;

    Ok(StatusSnapshot {
        cpu_usage,
        cpu_user,
        cpu_system,
        cpu_idle,
        cpu_brand: cpu_brand(),
        cpu_temp_c,
        fan_rpm,
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
        network,
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

fn cpu_brand() -> String {
    #[cfg(target_os = "macos")]
    {
        command_stdout("sysctl", &["-n", "machdep.cpu.brand_string"])
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "CPU".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(content) = std::fs::read_to_string("/proc/cpuinfo") {
            for line in content.lines() {
                if let Some(model) = line.strip_prefix("model name\t: ") {
                    return model.trim().to_string();
                }
            }
        }
        "CPU".to_string()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        "CPU".to_string()
    }
}

fn parse_top_cpu_line(line: &str) -> Option<(f32, f32, f32)> {
    let mut user = None;
    let mut system = None;
    let mut idle = None;
    for part in line.split(',') {
        let trimmed = part.trim();
        let (prefix, label) = if let Some(rest) = trimmed.strip_suffix("% user") {
            (rest, "user")
        } else if let Some(rest) = trimmed.strip_suffix("% sys") {
            (rest, "sys")
        } else if let Some(rest) = trimmed.strip_suffix("% idle") {
            (rest, "idle")
        } else {
            continue;
        };
        // The prefix may still contain the row label, e.g. "CPU usage: 8.1".
        // Take the trailing numeric token only.
        let value: Option<f32> = prefix
            .split_whitespace()
            .last()
            .and_then(|token| token.parse().ok());
        match label {
            "user" => user = value,
            "sys" => system = value,
            "idle" => idle = value,
            _ => {}
        }
    }
    Some((user?, system?, idle?))
}

#[cfg(test)]
mod tests {
    use super::parse_top_cpu_line;

    #[test]
    fn parses_macos_top_cpu_line() {
        let line = "CPU usage: 8.1% user, 14.54% sys, 77.44% idle ";
        assert_eq!(parse_top_cpu_line(line), Some((8.1, 14.54, 77.44)));
    }
}

#[cfg(target_os = "macos")]
fn cpu_breakdown() -> Option<(f32, f32, f32)> {
    let output = command_stdout("top", &["-l", "1", "-n", "0", "-s", "0"])?;
    let line = output.lines().find(|line| line.contains("CPU usage"))?;
    parse_top_cpu_line(line)
}

#[cfg(target_os = "linux")]
fn cpu_breakdown() -> Option<(f32, f32, f32)> {
    let first = read_linux_cpu_sample()?;
    std::thread::sleep(std::time::Duration::from_millis(120));
    let second = read_linux_cpu_sample()?;
    let total = second.0.checked_sub(first.0)?;
    let idle = second.1.checked_sub(first.1)?;
    if total == 0 {
        return Some((0.0, 0.0, 100.0));
    }
    let idle_pct = (idle as f64 / total as f64) * 100.0;
    let used_pct = 100.0 - idle_pct;
    Some((used_pct as f32 * 0.7, used_pct as f32 * 0.3, idle_pct as f32))
}

#[cfg(target_os = "windows")]
fn cpu_breakdown() -> Option<(f32, f32, f32)> {
    let usage = cpu_usage()?;
    Some((usage * 0.7, usage * 0.3, 100.0 - usage))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
fn cpu_breakdown() -> Option<(f32, f32, f32)> {
    None
}

fn apply_hw_metrics(state: &mut SamplerState) {
    let now = Instant::now();
    // Re-sample at most every 15s when successful, and back off for 5 minutes
    // after a failure so the sampler keeps trying on a slower cadence (e.g.
    // once the user relaunches with sudo).
    let success_ttl = 15;
    let failure_backoff = 300;

    let should_refresh = match (state.last_hw_at, state.last_hw_failure_at) {
        (None, _) => true,
        (Some(at), _) if state.cached_cpu_temp.is_some() => at.elapsed().as_secs() >= success_ttl,
        (Some(_), Some(failed)) => failed.elapsed().as_secs() >= failure_backoff,
        (Some(at), None) => at.elapsed().as_secs() >= failure_backoff,
    };
    if !should_refresh {
        return;
    }

    state.last_hw_at = Some(now);

    #[cfg(target_os = "macos")]
    {
        match read_powermetrics() {
            Some((cpu_temp, fan_rpm, disk_temps)) if cpu_temp.is_some() || fan_rpm.is_some() => {
                state.cached_cpu_temp = cpu_temp;
                state.cached_fan_rpm = fan_rpm;
                state.cached_disk_temps = disk_temps;
                state.last_hw_failure_at = None;
            }
            _ => {
                state.last_hw_failure_at = Some(now);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn read_powermetrics() -> Option<(Option<f32>, Option<u32>, HashMap<String, f32>)> {
    // powermetrics writes most data to stdout but some warnings (and on some
    // versions, the smc samples themselves) appear on stderr — read both.
    let output = Command::new("powermetrics")
        .args(["--samplers", "smc", "-i", "200", "-n", "1"])
        .output()
        .ok()?;
    let mut text = String::new();
    if let Ok(stdout) = String::from_utf8(output.stdout) {
        text.push_str(&stdout);
    }
    if let Ok(stderr) = String::from_utf8(output.stderr) {
        text.push_str(&stderr);
    }
    if text.is_empty() {
        return None;
    }

    let mut cpu_temp = None;
    let mut fan_rpm = None;
    let mut disk_temps = HashMap::new();

    for line in text.lines() {
        let lower = line.to_lowercase();
        if cpu_temp.is_none()
            && (lower.contains("cpu die temperature")
                || lower.contains("cpu avg temperature")
                || lower.contains("cpu temperature"))
        {
            cpu_temp = extract_first_number(line);
        }
        if fan_rpm.is_none() && lower.contains("fan") && (lower.contains("rpm") || lower.contains("speed")) {
            fan_rpm = extract_first_number(line).map(|value| value.round() as u32);
        }
        if lower.contains("disk") && lower.contains("temp") {
            if let Some(value) = extract_first_number(line) {
                disk_temps.insert("disk0".to_string(), value);
            }
        }
    }

    Some((cpu_temp, fan_rpm, disk_temps))
}

#[cfg(not(target_os = "macos"))]
fn read_powermetrics() -> Option<(Option<f32>, Option<u32>, HashMap<String, f32>)> {
    None
}

fn extract_first_number(line: &str) -> Option<f32> {
    let mut token = String::new();
    for ch in line.chars() {
        if ch.is_ascii_digit() || ch == '.' {
            token.push(ch);
        } else if !token.is_empty() {
            break;
        }
    }
    token.parse().ok()
}

fn apply_disk_io_rates(state: &mut SamplerState, disks: &mut [DiskInfo]) {
    let samples = sample_disk_io();
    let now = Instant::now();

    for disk in disks.iter_mut() {
        let key = disk_key_for_mount(&disk.mount);
        let (read_bytes, write_bytes) = if let Some(current) = samples.get(&key) {
            if let Some(previous) = state.last_disk_io.get(&key) {
                let elapsed = now
                    .duration_since(previous.at)
                    .as_secs_f64()
                    .max(0.001);
                let read_delta = current.read_bytes.saturating_sub(previous.read_bytes);
                let write_delta = current.write_bytes.saturating_sub(previous.write_bytes);
                (
                    (read_delta as f64 / elapsed) as u64,
                    (write_delta as f64 / elapsed) as u64,
                )
            } else {
                (0, 0)
            }
        } else {
            (0, 0)
        };

        disk.read_bytes_per_sec = read_bytes;
        disk.write_bytes_per_sec = write_bytes;

        if let Some(temp) = state.cached_disk_temps.get(&key) {
            disk.temp_c = Some(*temp);
        }

        if let Some(current) = samples.get(&key) {
            state.last_disk_io.insert(
                key,
                DiskIoSample {
                    read_bytes: current.read_bytes,
                    write_bytes: current.write_bytes,
                    at: now,
                },
            );
        }
    }
}

fn disk_key_for_mount(mount: &str) -> String {
    if mount == "/" {
        "disk0".to_string()
    } else {
        mount
            .rsplit('/')
            .next()
            .unwrap_or(mount)
            .chars()
            .take(12)
            .collect()
    }
}

struct IoCounters {
    read_bytes: u64,
    write_bytes: u64,
}

fn sample_disk_io() -> HashMap<String, IoCounters> {
    #[cfg(target_os = "macos")]
    {
        return macos_disk_io_samples();
    }
    #[cfg(target_os = "linux")]
    {
        return linux_disk_io_samples();
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        HashMap::new()
    }
}

#[cfg(target_os = "macos")]
fn macos_disk_io_samples() -> HashMap<String, IoCounters> {
    let output = match command_stdout("iostat", &["-Id", "disk0", "1", "1"]) {
        Some(value) => value,
        None => command_stdout("iostat", &["-d", "disk0", "1", "1"]).unwrap_or_default(),
    };
    if output.is_empty() {
        return HashMap::new();
    }

    let mut result = HashMap::new();
    let lines: Vec<&str> = output.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        if !line.contains("disk") || line.contains("KB/t") {
            continue;
        }
        let device = line.split_whitespace().next().unwrap_or("disk0");
        if let Some(data_line) = lines.get(index + 1) {
            let cols: Vec<&str> = data_line.split_whitespace().collect();
            if cols.len() >= 2 {
                let read_kbs = cols[0].parse::<f64>().unwrap_or(0.0);
                let write_kbs = cols[1].parse::<f64>().unwrap_or(0.0);
                result.insert(
                    device.to_string(),
                    IoCounters {
                        read_bytes: (read_kbs * 1024.0) as u64,
                        write_bytes: (write_kbs * 1024.0) as u64,
                    },
                );
                continue;
            }
            if cols.len() == 1 {
                let mbps = cols[0].parse::<f64>().unwrap_or(0.0);
                let bytes = (mbps * 1024.0 * 1024.0) as u64;
                result.insert(
                    device.to_string(),
                    IoCounters {
                        read_bytes: bytes / 2,
                        write_bytes: bytes / 2,
                    },
                );
            }
        }
    }
    result
}

#[cfg(target_os = "linux")]
fn linux_disk_io_samples() -> HashMap<String, IoCounters> {
    let content = std::fs::read_to_string("/proc/diskstats").ok();
    let mut result = HashMap::new();
    if let Some(content) = content {
        for line in content.lines() {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 14 {
                continue;
            }
            let name = cols[2].to_string();
            if !name.starts_with("sd") && !name.starts_with("nvme") {
                continue;
            }
            let read_sectors = cols[5].parse::<u64>().unwrap_or(0);
            let write_sectors = cols[9].parse::<u64>().unwrap_or(0);
            result.insert(
                name,
                IoCounters {
                    read_bytes: read_sectors.saturating_mul(512),
                    write_bytes: write_sectors.saturating_mul(512),
                },
            );
        }
    }
    result
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
            read_bytes_per_sec: 0,
            write_bytes_per_sec: 0,
            temp_c: None,
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
        return "Macintosh HD".to_string();
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
    let breakdown = cpu_breakdown()?;
    Some((breakdown.0 + breakdown.1).clamp(0.0, 100.0))
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
    let breakdown = cpu_breakdown()?;
    Some((breakdown.0 + breakdown.1).clamp(0.0, 100.0))
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

fn network_info_with_rates(state: &mut SamplerState) -> Option<NetworkInfo> {
    let current = sample_network_counters()?;
    let now = Instant::now();
    let (rx_bytes_per_sec, tx_bytes_per_sec) = if let Some(previous) = &state.last_net {
        if previous.iface == current.iface {
            let elapsed = now.duration_since(previous.at).as_secs_f64().max(0.001);
            let rx_delta = current.rx_bytes.saturating_sub(previous.rx_bytes);
            let tx_delta = current.tx_bytes.saturating_sub(previous.tx_bytes);
            (
                (rx_delta as f64 / elapsed) as u64,
                (tx_delta as f64 / elapsed) as u64,
            )
        } else {
            (0, 0)
        }
    } else {
        (0, 0)
    };

    state.last_net = Some(NetSample {
        iface: current.iface.clone(),
        rx_bytes: current.rx_bytes,
        tx_bytes: current.tx_bytes,
        at: now,
    });

    Some(NetworkInfo {
        name: current.iface,
        ip: current.ip,
        rx_bytes_per_sec,
        tx_bytes_per_sec,
    })
}

struct NetworkCounters {
    iface: String,
    ip: String,
    rx_bytes: u64,
    tx_bytes: u64,
}

fn sample_network_counters() -> Option<NetworkCounters> {
    #[cfg(target_os = "macos")]
    {
        return macos_network_counters();
    }
    #[cfg(target_os = "linux")]
    {
        return linux_network_counters();
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
fn macos_network_counters() -> Option<NetworkCounters> {
    for name in ["en0", "en1", "bridge0"] {
        let ip = command_stdout("ipconfig", &["getifaddr", name])
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let Some(ip) = ip else {
            continue;
        };
        let (rx_bytes, tx_bytes) = netstat_iface_bytes(name).unwrap_or((0, 0));
        return Some(NetworkCounters {
            iface: name.to_string(),
            ip,
            rx_bytes,
            tx_bytes,
        });
    }
    None
}

#[cfg(target_os = "macos")]
fn netstat_iface_bytes(iface: &str) -> Option<(u64, u64)> {
    let output = command_stdout("netstat", &["-ibn"])?;
    for line in output.lines() {
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() < 10 {
            continue;
        }
        if cols[0] != iface {
            continue;
        }
        let rx = cols[6].parse::<u64>().ok()?;
        let tx = cols[9].parse::<u64>().ok()?;
        return Some((rx, tx));
    }
    None
}

#[cfg(target_os = "linux")]
fn linux_network_counters() -> Option<NetworkCounters> {
    let routes = std::fs::read_to_string("/proc/net/route").ok()?;
    let iface = routes
        .lines()
        .skip(1)
        .find(|line| line.contains("\t00000000\t"))
        .and_then(|line| line.split_whitespace().next())
        .map(|value| value.to_string())?;
    let stats = std::fs::read_to_string(format!("/sys/class/net/{iface}/statistics/rx_bytes")).ok();
    let tx_stats =
        std::fs::read_to_string(format!("/sys/class/net/{iface}/statistics/tx_bytes")).ok();
    let rx_bytes = stats?.trim().parse().ok()?;
    let tx_bytes = tx_stats?.trim().parse().ok()?;
    Some(NetworkCounters {
        iface: iface.clone(),
        ip: "0.0.0.0".to_string(),
        rx_bytes,
        tx_bytes,
    })
}
