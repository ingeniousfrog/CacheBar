pub mod analyse;
pub mod clean;
pub mod optimize;
pub mod status;
pub mod uninstall;

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct StatusSnapshot {
    pub cpu_usage: f32,
    pub mem_usage: f32,
    pub mem_used: u64,
    pub mem_total: u64,
    pub mem_available: u64,
    pub mem_cached: u64,
    pub disk_free: u64,
    pub disk_total: u64,
    pub disk_usage: f32,
    pub disks: Vec<DiskInfo>,
    pub power: Option<PowerInfo>,
    pub top_processes: Vec<ProcessInfo>,
    pub network: Option<NetworkInfo>,
    pub uptime: String,
    pub platform: String,
    pub collected_at: String,
}

#[derive(Debug, Serialize)]
pub struct DiskInfo {
    pub name: String,
    pub mount: String,
    pub used: u64,
    pub free: u64,
    pub total: u64,
    pub used_percent: f32,
}

#[derive(Debug, Serialize)]
pub struct PowerInfo {
    pub percent: f32,
    pub status: String,
    pub time_left: String,
}

#[derive(Debug, Serialize)]
pub struct ProcessInfo {
    pub name: String,
    pub cpu: f32,
}

#[derive(Debug, Serialize)]
pub struct NetworkInfo {
    pub name: String,
    pub ip: String,
}

#[derive(Debug, Serialize)]
pub struct CleanEntry {
    pub category: String,
    pub path: String,
    pub freed: u64,
}

#[derive(Debug, Serialize)]
pub struct CleanFailure {
    pub category: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct CleanResult {
    pub removed: Vec<CleanEntry>,
    pub skipped: Vec<CleanFailure>,
}

#[derive(Debug, Serialize)]
pub struct UninstallResult {
    pub removed_files: Vec<String>,
    pub freed: u64,
}

#[derive(Debug, Serialize)]
pub struct OptimizeResult {
    pub tasks: Vec<String>,
    pub success: bool,
}

#[derive(Debug, Serialize)]
pub struct AnalysisNode {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub children: Vec<AnalysisNode>,
}

pub type CoreResult<T> = Result<T, String>;
