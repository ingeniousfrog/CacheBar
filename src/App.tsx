import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

type DiskInfo = {
  name: string;
  mount: string;
  used: number;
  free: number;
  total: number;
  used_percent: number;
  read_bytes_per_sec: number;
  write_bytes_per_sec: number;
  temp_c: number | null;
};

type PowerInfo = {
  percent: number;
  status: string;
  time_left: string;
};

type ProcessInfo = {
  name: string;
  cpu: number;
};

type NetworkInfo = {
  name: string;
  ip: string;
  rx_bytes_per_sec: number;
  tx_bytes_per_sec: number;
};

type StatusSnapshot = {
  cpu_usage: number;
  cpu_user: number;
  cpu_system: number;
  cpu_idle: number;
  cpu_brand: string;
  cpu_temp_c: number | null;
  fan_rpm: number | null;
  mem_usage: number;
  mem_used: number;
  mem_total: number;
  mem_available: number;
  mem_cached: number;
  disk_free: number;
  disk_total: number;
  disk_usage: number;
  disks: DiskInfo[];
  power: PowerInfo | null;
  top_processes: ProcessInfo[];
  network: NetworkInfo | null;
  uptime: string;
  platform: string;
  collected_at: string;
};

type CleanEntry = {
  category: string;
  path: string;
  freed: number;
};

type CleanFailure = {
  category: string;
  path: string;
  reason: string;
};

type CleanResult = {
  removed: CleanEntry[];
  skipped: CleanFailure[];
  freed_total: number;
};

type CleanCategory = {
  id: string;
  title: string;
  description: string;
  risk: "safe" | "review";
  roots: string[];
  items: CleanEntry[];
  total_freed: number;
  item_count: number;
};

type CleanSection = {
  name: string;
  categories: CleanCategory[];
};

type CleanScanResult = {
  sections: CleanSection[];
  total_freed: number;
  total_items: number;
};

type OptimizeResult = {
  tasks: string[];
  success: boolean;
};

type OperationState = "idle" | "loading" | "success" | "error";
type TabId = "overview" | "cleanup";
type CpuSample = [number, number, number];

type ConfirmationRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  action: () => Promise<void>;
};

type AppSettings = {
  refreshIntervalMs: number;
  enableHwMetrics: boolean;
};

const APP_VERSION = "0.1.0";
const GITHUB_URL = "https://github.com/heqk/CacheBar";
const SETTINGS_KEY = "cachebar-settings";
const CPU_HISTORY_LEN = 60;

const defaultSettings: AppSettings = {
  refreshIntervalMs: 1000,
  enableHwMetrics: true,
};

function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      return defaultSettings;
    }
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return defaultSettings;
  }
}

function saveSettings(settings: AppSettings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) {
    return "0 KB/s";
  }
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function shortPath(path: string): string {
  if (path.startsWith("apfs-snapshot://")) {
    return path.replace("apfs-snapshot://", "");
  }
  const parts = path.split("/");
  if (parts.length <= 5) {
    return path;
  }
  return `…/${parts.slice(-3).join("/")}`;
}

function isVirtualPath(path: string): boolean {
  return path.startsWith("apfs-snapshot://");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "Operation failed";
}

async function setPanelAutoHide(enabled: boolean): Promise<void> {
  try {
    await invoke("set_panel_auto_hide", { enabled });
  } catch {
    // native helper may be unavailable
  }
}

function Meter({ value, tone }: { value: number; tone: "green" | "amber" | "blue" | "rose" }) {
  const color = {
    green: "bg-emerald-400",
    amber: "bg-amber-400",
    blue: "bg-sky-400",
    rose: "bg-rose-400",
  }[tone];

  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-slate-700/70">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </div>
  );
}

function GlassCard({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-2xl bg-slate-800/60 p-2.5 ring-1 ring-white/5 ${className}`}>{children}</div>;
}

function CardLabel({ children }: { children: ReactNode }) {
  return <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{children}</span>;
}

function CpuAreaChart({ samples }: { samples: CpuSample[] }) {
  const width = 280;
  const height = 60;
  const pad = 2;

  if (samples.length < 2) {
    return <div className="h-[60px] w-full rounded-lg bg-slate-950/40" />;
  }

  const maxY = 100;
  const stepX = (width - pad * 2) / Math.max(samples.length - 1, 1);

  const pointAt = (index: number, value: number) => {
    const x = pad + index * stepX;
    const y = height - pad - (value / maxY) * (height - pad * 2);
    return `${x},${y}`;
  };

  const buildArea = (values: number[]) => {
    const top = values.map((value, index) => pointAt(index, value)).join(" L ");
    const baseline = `${pad},${height - pad} L ${pad + (values.length - 1) * stepX},${height - pad}`;
    return `M ${top} L ${baseline} Z`;
  };

  const userValues = samples.map((sample) => sample[0]);
  const systemValues = samples.map((sample, index) => sample[0] + sample[1]);
  const totalValues = samples.map((sample) => sample[0] + sample[1]);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[60px] w-full rounded-lg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="cpuTotal" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(248,113,113,0.55)" />
          <stop offset="100%" stopColor="rgba(248,113,113,0.05)" />
        </linearGradient>
        <linearGradient id="cpuUser" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(59,130,246,0.85)" />
          <stop offset="100%" stopColor="rgba(59,130,246,0.15)" />
        </linearGradient>
      </defs>
      <path d={buildArea(totalValues)} fill="url(#cpuTotal)" />
      <path d={buildArea(systemValues)} fill="rgba(56,189,248,0.45)" />
      <path d={buildArea(userValues)} fill="url(#cpuUser)" />
    </svg>
  );
}

function TabBar({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  const tabs: { id: TabId; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "cleanup", label: "Cleanup" },
  ];

  return (
    <nav className="flex gap-0.5 rounded-xl bg-slate-950/60 p-0.5 ring-1 ring-white/5">
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-semibold transition ${
              isActive ? "bg-sky-500 text-white shadow-sm" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
            }`}
          >
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

function CpuCard({ status, history }: { status: StatusSnapshot | null; history: CpuSample[] }) {
  const totalUsage = (status?.cpu_user ?? 0) + (status?.cpu_system ?? 0);

  return (
    <GlassCard className="col-span-2">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <CardLabel>CPU</CardLabel>
          <span className="text-[11px] text-slate-400">{status?.cpu_brand ?? "—"}</span>
        </div>
        <span className="text-xl font-light tabular-nums text-white">
          {formatPercent(totalUsage)}
        </span>
      </div>
      <div className="mt-1.5">
        <CpuAreaChart samples={history} />
      </div>
      <div className="mt-1.5 grid grid-cols-3 gap-2 text-[10px] tabular-nums">
        <CpuStat color="bg-blue-500" label="User" value={status?.cpu_user ?? 0} />
        <CpuStat color="bg-sky-400" label="System" value={status?.cpu_system ?? 0} />
        <CpuStat color="bg-slate-600" label="Idle" value={status?.cpu_idle ?? 0} />
      </div>
    </GlassCard>
  );
}

function CpuStat({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      <span className="text-slate-400">{label}</span>
      <span className="ml-auto font-semibold text-slate-100">{formatPercent(value)}</span>
    </div>
  );
}

function DiskCard({ disk }: { disk: DiskInfo | undefined }) {
  const usedPercent = disk?.used_percent ?? 0;
  return (
    <GlassCard>
      <div className="flex items-baseline justify-between gap-2">
        <CardLabel>Disk</CardLabel>
        <span className="text-[10px] text-slate-400">{disk?.name ?? "Disk"}</span>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 tabular-nums">
        <span className="text-base font-semibold text-white">
          {disk ? formatBytes(disk.used) : "—"}
        </span>
        <span className="text-[11px] text-slate-400">/ {disk ? formatBytes(disk.total) : "—"}</span>
      </div>
      <div className="mt-1.5">
        <Meter value={usedPercent} tone={usedPercent > 90 ? "rose" : "blue"} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[10px] tabular-nums text-slate-400">
        <span>↓ {formatRate(disk?.read_bytes_per_sec ?? 0)}</span>
        <span>↑ {formatRate(disk?.write_bytes_per_sec ?? 0)}</span>
      </div>
    </GlassCard>
  );
}

function RamCard({ status, onFreeUp }: { status: StatusSnapshot | null; onFreeUp: () => void }) {
  const usage = status?.mem_usage ?? 0;
  return (
    <GlassCard>
      <div className="flex items-baseline justify-between gap-2">
        <CardLabel>Memory</CardLabel>
        <button
          type="button"
          onClick={onFreeUp}
          className="text-[10px] font-semibold text-sky-300 hover:text-sky-200"
          title="Run system optimization"
        >
          Free Up
        </button>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2 tabular-nums">
        <span className="text-base font-semibold text-white">{formatBytes(status?.mem_used ?? 0)}</span>
        <span className="text-[11px] text-slate-400">/ {formatBytes(status?.mem_total ?? 0)}</span>
      </div>
      <div className="mt-1.5">
        <Meter value={usage} tone={usage > 90 ? "rose" : "blue"} />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] tabular-nums text-slate-400">
        <span>avail {formatBytes(status?.mem_available ?? 0)}</span>
        <span>cached {formatBytes(status?.mem_cached ?? 0)}</span>
      </div>
    </GlassCard>
  );
}

function InternetCard({ network }: { network: NetworkInfo | null }) {
  return (
    <GlassCard className="col-span-2">
      <div className="flex items-baseline justify-between gap-2">
        <CardLabel>Network</CardLabel>
        {network ? (
          <span className="text-[10px] text-slate-400">{network.ip} · {network.name}</span>
        ) : (
          <span className="text-[10px] text-slate-500">offline</span>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 tabular-nums">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase text-emerald-300">↓ DL</span>
          <span className="text-sm font-semibold text-white">{formatRate(network?.rx_bytes_per_sec ?? 0)}</span>
        </div>
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-semibold uppercase text-sky-300">↑ UL</span>
          <span className="text-sm font-semibold text-white">{formatRate(network?.tx_bytes_per_sec ?? 0)}</span>
        </div>
      </div>
    </GlassCard>
  );
}

function ProcessesCard({ processes }: { processes: ProcessInfo[] }) {
  const top = processes.slice(0, 5);
  const maxCpu = Math.max(...top.map((p) => p.cpu), 100);

  return (
    <GlassCard className="col-span-2">
      <div className="flex items-baseline justify-between gap-2">
        <CardLabel>Top Processes</CardLabel>
        <span className="text-[10px] text-slate-400">CPU%</span>
      </div>
      {top.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">no process data</p>
      ) : (
        <ul className="mt-1.5 space-y-1">
          {top.map((proc) => {
            const pct = Math.min(100, (proc.cpu / maxCpu) * 100);
            return (
              <li key={`${proc.name}-${proc.cpu}`} className="relative overflow-hidden rounded-md">
                <div
                  className="absolute inset-y-0 left-0 rounded-md bg-sky-500/15"
                  style={{ width: `${pct}%` }}
                />
                <div className="relative flex items-center justify-between gap-2 px-2 py-0.5 text-[11px]">
                  <span className="truncate font-medium text-slate-100">{proc.name}</span>
                  <span className="shrink-0 tabular-nums font-semibold text-slate-100">
                    {proc.cpu.toFixed(1)}%
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </GlassCard>
  );
}

function OverviewTab({
  status,
  cpuHistory,
  onFreeUp,
}: {
  status: StatusSnapshot | null;
  cpuHistory: CpuSample[];
  onFreeUp: () => void;
}) {
  const rootDisk = status?.disks.find((disk) => disk.mount === "/") ?? status?.disks[0];

  return (
    <section className="grid grid-cols-2 gap-2">
      <CpuCard status={status} history={cpuHistory} />
      <DiskCard disk={rootDisk} />
      <RamCard status={status} onFreeUp={onFreeUp} />
      <InternetCard network={status?.network ?? null} />
      <ProcessesCard processes={status?.top_processes ?? []} />
    </section>
  );
}

function BottomMenu({
  onRefresh,
  onSettings,
  onAbout,
  onQuit,
}: {
  onRefresh: () => void;
  onSettings: () => void;
  onAbout: () => void;
  onQuit: () => void;
}) {
  const items = [
    { label: "Refresh", shortcut: "⌘R", onClick: onRefresh },
    { label: "Settings…", shortcut: "⌘,", onClick: onSettings },
    { label: "About CacheBar", shortcut: "", onClick: onAbout },
    { label: "Quit", shortcut: "⌘Q", onClick: onQuit },
  ];

  return (
    <footer className="border-t border-white/5 pt-1">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-slate-200 transition hover:bg-white/5"
        >
          <span>{item.label}</span>
          {item.shortcut ? <span className="text-[10px] tabular-nums text-slate-500">{item.shortcut}</span> : null}
        </button>
      ))}
    </footer>
  );
}

async function openExternal(url: string) {
  try {
    await invoke("open_url", { url });
  } catch (error) {
    console.error(error);
  }
}

function SettingsDialog({
  open,
  settings,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  settings: AppSettings;
  busy: boolean;
  onClose: () => void;
  onSave: (next: AppSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);

  useEffect(() => {
    if (open) {
      setDraft(settings);
    }
  }, [open, settings]);

  if (!open) {
    return null;
  }

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-base font-bold text-white">Settings</h2>

      <label className="mt-4 block text-xs font-medium text-slate-300">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Refresh interval</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="number"
            min={1}
            max={60}
            value={Math.round(draft.refreshIntervalMs / 1000)}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                refreshIntervalMs: Math.max(1000, Number(event.target.value) * 1000),
              }))
            }
            className="w-20 rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-sm text-white"
          />
          <span className="text-xs text-slate-400">seconds</span>
        </div>
      </label>

      <div className="mt-5 grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onClose}
          className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold text-white hover:bg-white/15"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(draft)}
          className="rounded-lg bg-sky-500 px-3 py-2 text-sm font-semibold text-white hover:bg-sky-400"
        >
          Save
        </button>
      </div>
    </ModalShell>
  );
}

function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) {
    return null;
  }

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-base font-black text-white">About CacheBar</h2>
      <p className="mt-2 text-sm font-semibold text-slate-200">版本 {APP_VERSION}</p>
      <p className="mt-2 text-xs leading-5 text-slate-300">
        macOS 菜单栏系统监控与缓存清理工具。结合 iStat 风格的硬件面板与 mole 风格的分类清理。
      </p>
      <div className="mt-3 flex items-center gap-2 text-xs">
        <span className="text-slate-400">GitHub:</span>
        <code className="flex-1 truncate rounded bg-black/40 px-2 py-1 font-mono text-sky-300">{GITHUB_URL}</code>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => void openExternal(GITHUB_URL)}
          className="rounded-xl bg-white/10 px-3 py-2 text-sm font-bold text-white"
        >
          浏览器打开
        </button>
        <button type="button" onClick={onClose} className="rounded-xl bg-sky-500 px-3 py-2 text-sm font-bold text-white">
          关闭
        </button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <section className="w-full max-w-sm rounded-2xl bg-slate-900/95 p-4 shadow-xl ring-1 ring-white/10">
        {children}
        <button type="button" onClick={onClose} className="sr-only">
          close
        </button>
      </section>
    </div>
  );
}

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <ModalShell onClose={onCancel}>
      <h2 className="text-base font-black text-white">{title}</h2>
      <p className="mt-2 text-xs font-semibold leading-5 text-slate-300">{description}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" disabled={busy} onClick={onCancel} className="rounded-xl bg-white/10 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className={`rounded-xl px-3 py-2 text-sm font-bold text-white disabled:opacity-50 ${
            destructive ? "bg-rose-500" : "bg-sky-500"
          }`}
        >
          {busy ? "处理中..." : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

function RiskBadge({ risk }: { risk: "safe" | "review" }) {
  if (risk === "review") {
    return (
      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-200">
        请确认
      </span>
    );
  }
  return (
    <span className="rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-200">
      安全
    </span>
  );
}

function CleanupTab({
  busy,
  message,
  operationState,
  scanResult,
  lastCleanResult,
  selectedPaths,
  expandedCategoryIds,
  onScan,
  onTogglePath,
  onToggleCategory,
  onToggleExpand,
  onSelectAll,
  onSelectNone,
  onConfirmClean,
}: {
  busy: boolean;
  message: string;
  operationState: OperationState;
  scanResult: CleanScanResult | null;
  lastCleanResult: CleanResult | null;
  selectedPaths: Set<string>;
  expandedCategoryIds: Set<string>;
  onScan: () => void;
  onTogglePath: (path: string) => void;
  onToggleCategory: (category: CleanCategory) => void;
  onToggleExpand: (id: string) => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onConfirmClean: () => void;
}) {
  const allItems = useMemo(
    () => (scanResult?.sections ?? []).flatMap((section) => section.categories.flatMap((category) => category.items)),
    [scanResult],
  );
  const selectedTotal = allItems.filter((item) => selectedPaths.has(item.path)).reduce((sum, item) => sum + item.freed, 0);
  const noResults = scanResult != null && scanResult.total_items === 0;

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onScan}
          className="flex-1 rounded-xl bg-sky-500 px-3 py-2 text-sm font-black text-white disabled:opacity-50"
        >
          {busy && operationState === "loading" ? "扫描中..." : scanResult ? "重新扫描" : "扫描可清理项"}
        </button>
        {scanResult && allItems.length > 0 ? (
          <>
            <button type="button" onClick={onSelectAll} className="rounded-xl bg-white/10 px-2.5 py-2 text-xs font-bold text-white">
              全选安全项
            </button>
            <button type="button" onClick={onSelectNone} className="rounded-xl bg-white/10 px-2.5 py-2 text-xs font-bold text-white">
              清空
            </button>
          </>
        ) : null}
      </div>

      {operationState === "loading" || operationState === "error" ? (
        <div
          className={`rounded-xl px-3 py-2 text-xs font-bold ${
            operationState === "error" ? "bg-rose-500/20 text-rose-100" : "bg-sky-500/20 text-sky-100"
          }`}
        >
          {message}
        </div>
      ) : null}

      {lastCleanResult ? (
        <div className="rounded-xl bg-emerald-500/20 px-3 py-2 text-xs font-bold text-emerald-100">
          已释放 {formatBytes(lastCleanResult.freed_total)} · 删除 {lastCleanResult.removed.length} 项
          {lastCleanResult.skipped.length > 0 ? ` · 跳过 ${lastCleanResult.skipped.length} 项` : ""}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto rounded-2xl bg-slate-950/60 p-2 ring-1 ring-white/5">
        {!scanResult ? (
          <EmptyHint />
        ) : noResults ? (
          <div className="py-10 text-center text-xs text-slate-400">没有发现可清理项 🎉</div>
        ) : (
          <SectionList
            scanResult={scanResult}
            selectedPaths={selectedPaths}
            expandedCategoryIds={expandedCategoryIds}
            onTogglePath={onTogglePath}
            onToggleCategory={onToggleCategory}
            onToggleExpand={onToggleExpand}
          />
        )}
      </div>

      {scanResult && allItems.length > 0 ? (
        <div className="rounded-xl bg-slate-900/80 p-2 ring-1 ring-white/10">
          <div className="mb-2 flex items-center justify-between text-xs font-bold">
            <span className="text-slate-200">
              已选 {selectedPaths.size} 项 · {formatBytes(selectedTotal)}
            </span>
            <span className="text-slate-400">合计可清理 {formatBytes(scanResult.total_freed)}</span>
          </div>
          <button
            type="button"
            disabled={busy || selectedPaths.size === 0}
            onClick={onConfirmClean}
            className="w-full rounded-xl bg-rose-500 px-3 py-2 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy && operationState === "loading" ? "删除中..." : `确认删除所选 ${selectedPaths.size} 项`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="py-10 text-center text-xs text-slate-400">
      点击「扫描可清理项」检查系统中的缓存。
      <br />
      所有项目都会按类别列出，附描述与安全等级。
    </div>
  );
}

function SectionList({
  scanResult,
  selectedPaths,
  expandedCategoryIds,
  onTogglePath,
  onToggleCategory,
  onToggleExpand,
}: {
  scanResult: CleanScanResult;
  selectedPaths: Set<string>;
  expandedCategoryIds: Set<string>;
  onTogglePath: (path: string) => void;
  onToggleCategory: (category: CleanCategory) => void;
  onToggleExpand: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      {scanResult.sections.map((section) => {
        const sectionItems = section.categories.reduce((sum, cat) => sum + cat.item_count, 0);
        const sectionBytes = section.categories.reduce((sum, cat) => sum + cat.total_freed, 0);
        return (
          <div key={section.name}>
            <div className="mb-1 flex items-center gap-2 px-1">
              <span className="text-[10px] font-black uppercase tracking-wider text-slate-300">{section.name}</span>
              <div className="h-px flex-1 bg-white/10" />
              <span className="text-[10px] font-bold text-slate-400">
                {section.categories.length} 类 · {sectionItems} 项 · {formatBytes(sectionBytes)}
              </span>
            </div>
            <div className="space-y-2">
              {section.categories.map((category) => (
                <CategoryRow
                  key={category.id}
                  category={category}
                  expanded={expandedCategoryIds.has(category.id)}
                  selectedPaths={selectedPaths}
                  onTogglePath={onTogglePath}
                  onToggleCategory={() => onToggleCategory(category)}
                  onToggleExpand={() => onToggleExpand(category.id)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CategoryRow({
  category,
  expanded,
  selectedPaths,
  onTogglePath,
  onToggleCategory,
  onToggleExpand,
}: {
  category: CleanCategory;
  expanded: boolean;
  selectedPaths: Set<string>;
  onTogglePath: (path: string) => void;
  onToggleCategory: () => void;
  onToggleExpand: () => void;
}) {
  const selectedCount = category.items.filter((item) => selectedPaths.has(item.path)).length;
  const allSelected = selectedCount === category.items.length && category.items.length > 0;
  const partial = selectedCount > 0 && !allSelected;

  return (
    <div className="rounded-xl bg-slate-800/60 ring-1 ring-white/5">
      <div className="flex items-center gap-2 px-2 py-2">
        <input
          type="checkbox"
          checked={allSelected}
          ref={(input) => {
            if (input) input.indeterminate = partial;
          }}
          onChange={onToggleCategory}
          className="h-4 w-4 shrink-0 accent-sky-500"
        />
        <button
          type="button"
          onClick={onToggleExpand}
          className="flex flex-1 min-w-0 items-center gap-2 text-left"
        >
          <span className="w-3 text-xs text-slate-400">{expanded ? "▾" : "▸"}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-bold text-white">{category.title}</span>
              <RiskBadge risk={category.risk} />
            </div>
            <p className="mt-0.5 truncate text-[10px] text-slate-400" title={category.description}>
              {category.description}
            </p>
          </div>
          <div className="shrink-0 text-right text-[11px] font-bold">
            <div className="text-sky-300">{formatBytes(category.total_freed)}</div>
            <div className="text-slate-400">{category.item_count} 项</div>
          </div>
        </button>
      </div>

      {expanded ? (
        <div className="space-y-1 border-t border-white/5 px-2 py-2">
          {category.items.map((item) => (
            <label
              key={item.path}
              className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg bg-slate-900/60 px-2 py-1.5 hover:bg-slate-900/90"
            >
              <input
                type="checkbox"
                checked={selectedPaths.has(item.path)}
                onChange={() => onTogglePath(item.path)}
                className="h-4 w-4 accent-sky-500"
              />
              <span className="min-w-0 truncate text-[11px] text-slate-100" title={item.path}>
                {shortPath(item.path)}
                {isVirtualPath(item.path) ? (
                  <span className="ml-1 text-[10px] text-amber-300">· 估算</span>
                ) : null}
              </span>
              <span className="text-[11px] font-bold text-sky-300">{formatBytes(item.freed)}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [operationState, setOperationState] = useState<OperationState>("idle");
  const [message, setMessage] = useState("Ready");
  const [scanResult, setScanResult] = useState<CleanScanResult | null>(null);
  const [lastCleanResult, setLastCleanResult] = useState<CleanResult | null>(null);
  const [selectedCleanupPaths, setSelectedCleanupPaths] = useState<Set<string>>(new Set());
  const [expandedCategoryIds, setExpandedCategoryIds] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const cpuHistoryRef = useRef<CpuSample[]>([]);
  const [cpuHistory, setCpuHistory] = useState<CpuSample[]>([]);

  const busy = operationState === "loading";

  // While the user is mid-operation (scan, delete, optimize) or has any modal
  // open, suppress the panel's auto-hide-on-blur behaviour so the focus shifts
  // caused by long-running shell commands and confirm dialogs don't dismiss
  // the panel.
  useEffect(() => {
    const shouldDisableAutoHide =
      busy || confirmation !== null || settingsOpen || aboutOpen;
    void setPanelAutoHide(!shouldDisableAutoHide);
  }, [busy, confirmation, settingsOpen, aboutOpen]);

  const pushCpuSample = useCallback((snapshot: StatusSnapshot) => {
    const next: CpuSample = [snapshot.cpu_user, snapshot.cpu_system, snapshot.cpu_idle];
    const history = [...cpuHistoryRef.current, next].slice(-CPU_HISTORY_LEN);
    cpuHistoryRef.current = history;
    setCpuHistory(history);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const snapshot = await invoke<StatusSnapshot>("status");
      setStatus(snapshot);
      pushCpuSample(snapshot);
    } catch (error) {
      setMessage(errorMessage(error));
      setOperationState("error");
    }
  }, [pushCpuSample]);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, settings.refreshIntervalMs);
    return () => window.clearInterval(timer);
  }, [refreshStatus, settings.refreshIntervalMs]);

  const handleQuit = useCallback(() => {
    void invoke("quit_app");
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey) {
        return;
      }
      const key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault();
        void refreshStatus();
      } else if (key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (key === "q") {
        event.preventDefault();
        handleQuit();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [refreshStatus, handleQuit]);

  const handleScan = useCallback(async () => {
    // Lock auto-hide BEFORE issuing the long-running invoke so the panel does
    // not vanish if the webview briefly loses focus during the IPC roundtrip.
    await setPanelAutoHide(false);
    setOperationState("loading");
    setMessage("正在扫描可清理项...");
    setLastCleanResult(null);
    void invoke<CleanScanResult>("scan_clean_targets")
      .then((result) => {
        setScanResult(result);
        const safeItemPaths = new Set<string>();
        const expandIds = new Set<string>();
        for (const section of result.sections) {
          for (const category of section.categories) {
            if (category.risk === "safe") {
              for (const item of category.items) {
                safeItemPaths.add(item.path);
              }
            }
            if (category.total_freed > 50 * 1024 * 1024) {
              expandIds.add(category.id);
            }
          }
        }
        setSelectedCleanupPaths(safeItemPaths);
        setExpandedCategoryIds(expandIds);
        setOperationState("idle");
        setMessage(result.total_items > 0 ? `扫描完成，共 ${result.total_items} 项 · ${formatBytes(result.total_freed)}` : "暂无可清理项");
      })
      .catch((error) => {
        setOperationState("error");
        setMessage(errorMessage(error));
      });
  }, []);

  const handleTogglePath = useCallback((path: string) => {
    setSelectedCleanupPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleToggleCategory = useCallback((category: CleanCategory) => {
    setSelectedCleanupPaths((current) => {
      const next = new Set(current);
      const allSelected = category.items.every((item) => next.has(item.path));
      if (allSelected) {
        for (const item of category.items) {
          next.delete(item.path);
        }
      } else {
        for (const item of category.items) {
          next.add(item.path);
        }
      }
      return next;
    });
  }, []);

  const handleToggleExpand = useCallback((id: string) => {
    setExpandedCategoryIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectAllSafe = useCallback(() => {
    if (!scanResult) {
      return;
    }
    const safePaths = new Set<string>();
    for (const section of scanResult.sections) {
      for (const category of section.categories) {
        if (category.risk === "safe") {
          for (const item of category.items) {
            safePaths.add(item.path);
          }
        }
      }
    }
    setSelectedCleanupPaths(safePaths);
  }, [scanResult]);

  const confirmCleanSelected = useCallback(() => {
    const paths = Array.from(selectedCleanupPaths);
    if (paths.length === 0) {
      return;
    }
    const totalBytes = paths.reduce((sum, path) => {
      const entry = scanResult?.sections
        .flatMap((section) => section.categories)
        .flatMap((category) => category.items)
        .find((item) => item.path === path);
      return sum + (entry?.freed ?? 0);
    }, 0);
    setConfirmation({
      title: "确认删除所选项",
      description: `共 ${paths.length} 项 · ${formatBytes(totalBytes)}。该操作不可恢复，请确认。`,
      confirmLabel: "确认删除",
      destructive: true,
      action: async () => {
        await setPanelAutoHide(false);
        setOperationState("loading");
        setMessage("正在删除...");
        try {
          const result = await invoke<CleanResult>("clean_selected", { paths });
          setLastCleanResult(result);
          setOperationState("success");
          setMessage(`已释放 ${formatBytes(result.freed_total)}`);
          setSelectedCleanupPaths(new Set());
          void handleScan();
          void refreshStatus();
        } catch (error) {
          setOperationState("error");
          setMessage(errorMessage(error));
        }
      },
    });
  }, [handleScan, refreshStatus, scanResult, selectedCleanupPaths]);

  const handleOptimize = useCallback(() => {
    setConfirmation({
      title: "执行系统优化",
      description: "会执行 purge 等系统维护任务，刷新缓存与文件系统状态。",
      confirmLabel: "开始优化",
      action: async () => {
        await setPanelAutoHide(false);
        setOperationState("loading");
        setMessage("Working...");
        try {
          const result = await invoke<OptimizeResult>("optimize");
          setOperationState("success");
          setMessage(`已执行 ${result.tasks.length} 个优化任务`);
          void refreshStatus();
        } catch (error) {
          setOperationState("error");
          setMessage(errorMessage(error));
        }
      },
    });
  }, [refreshStatus]);

  const updatedLabel = useMemo(() => {
    if (!status?.collected_at) {
      return "Updated just now";
    }
    const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(status.collected_at)));
    if (seconds < 5) {
      return "Updated just now";
    }
    return `Updated ${seconds}s ago`;
  }, [status?.collected_at]);

  return (
    <main className="h-screen w-screen overflow-hidden bg-transparent text-white">
      <div className="cachebar-shell flex h-full flex-col gap-2 overflow-hidden rounded-[26px] bg-slate-900/85 p-3 shadow-[0_20px_50px_rgba(0,0,0,0.45)] ring-1 ring-white/10 backdrop-blur-2xl">
        <header className="flex items-center justify-between gap-2 px-1 pt-0.5">
          <h1 className="text-[13px] font-bold tracking-tight text-white">CacheBar</h1>
          <span className="truncate text-[10px] font-medium text-slate-500">
            {status ? `uptime ${status.uptime}` : "loading…"} · {updatedLabel}
          </span>
        </header>

        <TabBar active={activeTab} onChange={setActiveTab} />

        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab === "overview" ? (
            <div className="h-full overflow-y-auto">
              <OverviewTab status={status} cpuHistory={cpuHistory} onFreeUp={handleOptimize} />
            </div>
          ) : null}
          {activeTab === "cleanup" ? (
            <CleanupTab
              busy={busy}
              message={message}
              operationState={operationState}
              scanResult={scanResult}
              lastCleanResult={lastCleanResult}
              selectedPaths={selectedCleanupPaths}
              expandedCategoryIds={expandedCategoryIds}
              onScan={handleScan}
              onTogglePath={handleTogglePath}
              onToggleCategory={handleToggleCategory}
              onToggleExpand={handleToggleExpand}
              onSelectAll={selectAllSafe}
              onSelectNone={() => setSelectedCleanupPaths(new Set())}
              onConfirmClean={confirmCleanSelected}
            />
          ) : null}
        </div>

        <BottomMenu
          onRefresh={() => void refreshStatus()}
          onSettings={() => setSettingsOpen(true)}
          onAbout={() => setAboutOpen(true)}
          onQuit={handleQuit}
        />

        <SettingsDialog
          open={settingsOpen}
          settings={settings}
          busy={busy}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            setSettings(next);
            saveSettings(next);
            setSettingsOpen(false);
          }}
        />

        <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />

        <ConfirmDialog
          open={confirmation !== null}
          title={confirmation?.title ?? ""}
          description={confirmation?.description ?? ""}
          confirmLabel={confirmation?.confirmLabel ?? "确认"}
          destructive={confirmation?.destructive}
          busy={busy}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const current = confirmation;
            if (!current) {
              return;
            }
            setConfirmation(null);
            void current.action();
          }}
        />
      </div>
    </main>
  );
}
