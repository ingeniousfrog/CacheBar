import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

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
};

type OptimizeResult = {
  tasks: string[];
  success: boolean;
};

type AnalysisNode = {
  name: string;
  path: string;
  size: number;
  children: AnalysisNode[];
};

type OperationState = "idle" | "loading" | "success" | "error";
type OperationSummary = { kind: "empty" } | { kind: "clean"; result: CleanResult } | { kind: "optimize"; result: OptimizeResult };
type TabId = "overview" | "cleanup" | "analyse";
type CpuSample = [number, number, number];

type ConfirmationRequest = {
  title: string;
  description: string;
  confirmLabel: string;
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
const emptySummary: OperationSummary = { kind: "empty" };

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

function formatTemp(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) {
    return "--℃";
  }
  return `${value.toFixed(1)}℃`;
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
    <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </div>
  );
}

function GlassCard({ className = "", children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-2xl bg-white/10 p-3 backdrop-blur-md ${className}`}>{children}</div>;
}

function CpuAreaChart({ samples }: { samples: CpuSample[] }) {
  const width = 280;
  const height = 72;
  const pad = 2;

  if (samples.length < 2) {
    return (
      <div className="flex h-[72px] items-center justify-center rounded-xl bg-black/20 text-[11px] font-semibold text-slate-400">
        采集中…
      </div>
    );
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
    <svg viewBox={`0 0 ${width} ${height}`} className="h-[72px] w-full rounded-xl bg-black/20" preserveAspectRatio="none">
      <path d={buildArea(totalValues)} fill="rgba(248,113,113,0.55)" />
      <path d={buildArea(systemValues)} fill="rgba(56,189,248,0.65)" />
      <path d={buildArea(userValues)} fill="rgba(59,130,246,0.85)" />
    </svg>
  );
}

function TabBar({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: "overview", label: "Overview", icon: "▦" },
    { id: "cleanup", label: "Cleanup", icon: "⌫" },
    { id: "analyse", label: "Analyse", icon: "◎" },
  ];

  return (
    <nav className="flex gap-1 rounded-2xl bg-black/25 p-1">
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-xs font-bold transition ${
              isActive ? "bg-sky-500 text-white shadow-sm" : "text-slate-300 hover:bg-white/10"
            }`}
          >
            <span className="text-sm">{tab.icon}</span>
            {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

function CpuCard({ status, history }: { status: StatusSnapshot | null; history: CpuSample[] }) {
  return (
    <GlassCard className="row-span-2 flex min-h-[200px] flex-col">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">⬢</span>
          <div>
            <div className="text-sm font-black text-white">CPU</div>
            <div className="text-[10px] font-semibold text-slate-300">{status?.cpu_brand ?? "—"}</div>
          </div>
        </div>
        <span className="text-xs font-black text-sky-300">{formatTemp(status?.cpu_temp_c)}</span>
      </div>
      <div className="mt-2 flex-1">
        <CpuAreaChart samples={history} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] font-bold">
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-blue-500" />
          <span className="text-slate-300">User</span>
          <span className="ml-auto text-white">{formatPercent(status?.cpu_user ?? 0)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-rose-400" />
          <span className="text-slate-300">System</span>
          <span className="ml-auto text-white">{formatPercent(status?.cpu_system ?? 0)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm bg-slate-500" />
          <span className="text-slate-300">Idle</span>
          <span className="ml-auto text-white">{formatPercent(status?.cpu_idle ?? 0)}</span>
        </div>
      </div>
    </GlassCard>
  );
}

function DiskCard({ disk }: { disk: DiskInfo | undefined }) {
  return (
    <GlassCard>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base">💾</span>
          <span className="text-sm font-black text-white">{disk?.name ?? "Disk"}</span>
        </div>
        <span className="text-xs font-black text-sky-300">{formatTemp(disk?.temp_c)}</span>
      </div>
      <div className="mt-2 space-y-0.5 text-[11px] font-semibold text-slate-200">
        <div>
          Used <span className="font-black text-white">{disk ? formatBytes(disk.used) : "—"}</span>
          <span className="text-slate-400"> / </span>
          Total <span className="font-black text-white">{disk ? formatBytes(disk.total) : "—"}</span>
        </div>
        <div className="text-slate-400">
          Free {disk ? formatBytes(disk.free) : "—"} · {disk ? formatPercent(disk.used_percent) : "—"} used
        </div>
      </div>
      <div className="mt-2">
        <Meter value={disk?.used_percent ?? 0} tone={(disk?.used_percent ?? 0) > 90 ? "rose" : "blue"} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-semibold text-slate-300">
        <span>R: {formatRate(disk?.read_bytes_per_sec ?? 0)}</span>
        <span>W: {formatRate(disk?.write_bytes_per_sec ?? 0)}</span>
        {disk?.mount ? <span className="text-sky-300">{disk.mount}</span> : null}
      </div>
    </GlassCard>
  );
}

function RamCard({ status, onFreeUp }: { status: StatusSnapshot | null; onFreeUp: () => void }) {
  return (
    <GlassCard>
      <div className="flex items-center gap-2">
        <span className="text-base">▤</span>
        <span className="text-sm font-black text-white">RAM</span>
      </div>
      <div className="mt-2 text-[11px] font-semibold text-slate-200">
        Used <span className="font-black text-white">{formatBytes(status?.mem_used ?? 0)}</span>
        <span className="text-slate-400"> / </span>
        Total <span className="font-black text-white">{formatBytes(status?.mem_total ?? 0)}</span>
      </div>
      <div className="mt-1 text-[10px] text-slate-400">
        Available {formatBytes(status?.mem_available ?? 0)} · Cached {formatBytes(status?.mem_cached ?? 0)}
      </div>
      <div className="mt-2">
        <Meter value={status?.mem_usage ?? 0} tone="blue" />
      </div>
      <div className="mt-2 flex justify-end">
        <button type="button" onClick={onFreeUp} className="text-[11px] font-bold text-sky-300 hover:text-sky-200">
          Free Up →
        </button>
      </div>
    </GlassCard>
  );
}

function FanCard({ fanRpm }: { fanRpm: number | null }) {
  return (
    <GlassCard>
      <div className="flex items-center gap-2">
        <span className="text-base">🌀</span>
        <span className="text-sm font-black text-white">FAN</span>
      </div>
      <div className="mt-3 text-lg font-black text-white">{fanRpm != null ? `${fanRpm} RPM` : "-- RPM"}</div>
      {fanRpm == null ? (
        <p className="mt-1 text-[10px] font-semibold text-slate-400">需 sudo 启动以读取风扇转速</p>
      ) : null}
    </GlassCard>
  );
}

function InternetCard({ network }: { network: NetworkInfo | null }) {
  return (
    <GlassCard>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-base">🌐</span>
          <span className="text-sm font-black text-white">INTERNET</span>
        </div>
        <span className="text-slate-400">›</span>
      </div>
      {network ? (
        <>
          <div className="mt-2 flex gap-4 text-[11px] font-bold text-white">
            <span>↓ {formatRate(network.rx_bytes_per_sec)}</span>
            <span>↑ {formatRate(network.tx_bytes_per_sec)}</span>
          </div>
          <div className="mt-2 text-[11px] font-semibold text-sky-300">{network.ip}</div>
          <div className="text-[10px] text-slate-400">{network.name}</div>
        </>
      ) : (
        <p className="mt-2 text-[11px] font-semibold text-slate-400">无活动网络</p>
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
      <FanCard fanRpm={status?.fan_rpm ?? null} />
      <InternetCard network={status?.network ?? null} />
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
    { label: "Refresh", shortcut: "⌘R", onClick: onRefresh, icon: "↻" },
    { label: "Settings...", shortcut: "⌘,", onClick: onSettings, icon: "⚙" },
    { label: "About CacheBar", shortcut: "", onClick: onAbout, icon: "ℹ" },
    { label: "Quit", shortcut: "⌘Q", onClick: onQuit, icon: "⏻" },
  ];

  return (
    <footer className="border-t border-white/10 pt-2">
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm font-semibold text-slate-100 transition hover:bg-white/10"
        >
          <span className="w-5 text-center text-slate-400">{item.icon}</span>
          <span className="flex-1">{item.label}</span>
          {item.shortcut ? <span className="text-xs text-slate-400">{item.shortcut}</span> : null}
        </button>
      ))}
    </footer>
  );
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
      <h2 className="text-base font-black text-white">Settings</h2>
      <label className="mt-4 block text-xs font-semibold text-slate-300">
        刷新间隔（秒）
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
          className="mt-1 w-full rounded-xl border border-white/10 bg-black/30 px-3 py-2 text-sm text-white"
        />
      </label>
      <label className="mt-3 flex items-center gap-2 text-xs font-semibold text-slate-300">
        <input
          type="checkbox"
          checked={draft.enableHwMetrics}
          onChange={(event) => setDraft((current) => ({ ...current, enableHwMetrics: event.target.checked }))}
          className="h-4 w-4 accent-sky-500"
        />
        尝试读取温度 / 风扇（需 sudo 启动 CacheBar）
      </label>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button type="button" disabled={busy} onClick={onClose} className="rounded-xl bg-white/10 px-3 py-2 text-sm font-bold text-white">
          取消
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onSave(draft)}
          className="rounded-xl bg-sky-500 px-3 py-2 text-sm font-bold text-white"
        >
          保存
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
      <p className="mt-2 text-xs leading-5 text-slate-300">macOS 菜单栏系统监控与缓存清理工具。</p>
      <a href={GITHUB_URL} className="mt-3 inline-block text-sm font-bold text-sky-300 hover:text-sky-200">
        GitHub →
      </a>
      <button type="button" onClick={onClose} className="mt-4 w-full rounded-xl bg-sky-500 px-3 py-2 text-sm font-bold text-white">
        关闭
      </button>
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
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
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
        <button type="button" disabled={busy} onClick={onConfirm} className="rounded-xl bg-sky-500 px-3 py-2 text-sm font-bold text-white disabled:opacity-50">
          {busy ? "处理中..." : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

function CleanupTab({
  busy,
  message,
  summary,
  operationState,
  onScan,
  cleanupTargets,
  selectedPaths,
  onSelectAll,
  onSelectNone,
  onTogglePath,
  onConfirmClean,
}: {
  busy: boolean;
  message: string;
  summary: OperationSummary;
  operationState: OperationState;
  onScan: () => void;
  cleanupTargets: CleanEntry[];
  selectedPaths: Set<string>;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onTogglePath: (path: string) => void;
  onConfirmClean: () => void;
}) {
  const groupedEntries = cleanupTargets.reduce<Record<string, CleanEntry[]>>((groups, entry) => {
    const category = entry.category || "其他";
    return { ...groups, [category]: [...(groups[category] ?? []), entry] };
  }, {});
  const selectedTotal = cleanupTargets.filter((entry) => selectedPaths.has(entry.path)).reduce((sum, entry) => sum + entry.freed, 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={onScan} className="flex-1 rounded-xl bg-sky-500 px-3 py-2 text-sm font-black text-white disabled:opacity-50">
          {busy ? "扫描中..." : "扫描缓存"}
        </button>
        {cleanupTargets.length > 0 ? (
          <>
            <button type="button" onClick={onSelectAll} className="rounded-xl bg-white/10 px-2.5 py-2 text-xs font-bold text-white">
              全选
            </button>
            <button type="button" onClick={onSelectNone} className="rounded-xl bg-white/10 px-2.5 py-2 text-xs font-bold text-white">
              清空
            </button>
          </>
        ) : null}
      </div>

      <OperationNotice summary={summary} state={operationState} message={message} />

      {cleanupTargets.length > 0 ? (
        <>
          <div className="text-xs font-bold text-slate-200">
            已选 {selectedPaths.size} 项 · {formatBytes(selectedTotal)}
          </div>
          <div className="min-h-0 flex-1 overflow-auto rounded-2xl bg-black/20 p-2">
            {Object.entries(groupedEntries).map(([category, items]) => (
              <div key={category} className="mb-3 last:mb-0">
                <div className="mb-1 text-[11px] font-black uppercase text-slate-400">{category}</div>
                <div className="space-y-1">
                  {items.map((entry) => (
                    <label key={entry.path} className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-2 rounded-xl bg-white/5 px-2 py-1.5">
                      <input type="checkbox" checked={selectedPaths.has(entry.path)} onChange={() => onTogglePath(entry.path)} className="h-4 w-4 accent-sky-500" />
                      <span className="min-w-0 truncate text-[11px] text-slate-100" title={entry.path}>
                        {entry.path}
                      </span>
                      <span className="text-[11px] font-bold text-sky-300">{formatBytes(entry.freed)}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={busy || selectedPaths.size === 0}
            onClick={onConfirmClean}
            className="rounded-xl bg-rose-500 px-3 py-2 text-sm font-black text-white disabled:opacity-50"
          >
            {busy ? "删除中..." : "确认删除所选项"}
          </button>
        </>
      ) : (
        <p className="text-xs font-semibold text-slate-400">点击「扫描缓存」列出可清理项，勾选后删除。</p>
      )}
    </div>
  );
}

function AnalyseTab({
  busy,
  message,
  nodes,
  onPick,
}: {
  busy: boolean;
  message: string;
  nodes: AnalysisNode[];
  onPick: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={onPick}
        className="rounded-xl border border-dashed border-white/20 px-3 py-2 text-sm font-bold text-slate-200 hover:border-sky-300 disabled:opacity-50"
      >
        {busy ? "扫描中..." : nodes.length > 0 ? "重新选择文件夹" : "选择文件夹分析"}
      </button>
      {message ? <p className="text-xs font-semibold text-slate-300">{message}</p> : null}
      <div className="min-h-0 flex-1 overflow-auto rounded-2xl bg-black/20 p-2">
        {nodes.length > 0 ? <AnalysisTree nodes={nodes} /> : <div className="py-8 text-center text-xs text-slate-400">还没有选择文件夹</div>}
      </div>
    </div>
  );
}

function AnalysisTree({ nodes }: { nodes: AnalysisNode[] }) {
  return (
    <div className="space-y-1">
      {nodes.map((node) => (
        <AnalysisTreeNode key={node.path} node={node} depth={0} />
      ))}
    </div>
  );
}

function AnalysisTreeNode({ node, depth }: { node: AnalysisNode; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <button
        type="button"
        onClick={() => hasChildren && setExpanded(!expanded)}
        className="grid w-full grid-cols-[1fr_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-white/8"
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span className="min-w-0 truncate text-xs font-semibold text-slate-100">
          <span className="mr-1 inline-block w-3 text-slate-400">{hasChildren ? (expanded ? "▾" : "▸") : ""}</span>
          {node.name}
        </span>
        <span className="text-[11px] font-bold text-sky-200">{formatBytes(node.size)}</span>
      </button>
      {expanded && hasChildren ? (
        <div>
          {node.children.map((child) => (
            <AnalysisTreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function OperationNotice({ summary, state, message }: { summary: OperationSummary; state: OperationState; message: string }) {
  if (state === "loading" || state === "error") {
    return (
      <div className={`rounded-xl px-3 py-2 text-xs font-bold ${state === "error" ? "bg-rose-500/20 text-rose-100" : "bg-sky-500/20 text-sky-100"}`}>
        {message}
      </div>
    );
  }

  if (summary.kind === "clean") {
    const total = summary.result.removed.reduce((sum, entry) => sum + entry.freed, 0);
    const skipped = summary.result.skipped.length;
    return (
      <div className="rounded-xl bg-emerald-500/20 px-3 py-2 text-xs font-bold text-emerald-100">
        已清理 {formatBytes(total)} · {summary.result.removed.length} 项{skipped > 0 ? `，跳过 ${skipped} 项` : ""}
      </div>
    );
  }

  if (summary.kind === "optimize") {
    return <div className="rounded-xl bg-emerald-500/20 px-3 py-2 text-xs font-bold text-emerald-100">已执行 {summary.result.tasks.length} 个优化任务</div>;
  }

  return null;
}

export default function App() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [operationState, setOperationState] = useState<OperationState>("idle");
  const [message, setMessage] = useState("Ready");
  const [summary, setSummary] = useState<OperationSummary>(emptySummary);
  const [analysisNodes, setAnalysisNodes] = useState<AnalysisNode[]>([]);
  const [cleanupTargets, setCleanupTargets] = useState<CleanEntry[]>([]);
  const [selectedCleanupPaths, setSelectedCleanupPaths] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);
  const cpuHistoryRef = useRef<CpuSample[]>([]);
  const [cpuHistory, setCpuHistory] = useState<CpuSample[]>([]);

  const busy = operationState === "loading";

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

  const requestAction = useCallback(
    <T,>(title: string, description: string, confirmLabel: string, action: () => Promise<T>, onSuccess: (value: T) => OperationSummary) => {
      setConfirmation({
        title,
        description,
        confirmLabel,
        action: async () => {
          setOperationState("loading");
          setMessage("Working...");
          try {
            const value = await action();
            setSummary(onSuccess(value));
            setOperationState("success");
            setMessage("Done");
            void refreshStatus();
          } catch (error) {
            setOperationState("error");
            setMessage(errorMessage(error));
          }
        },
      });
    },
    [refreshStatus],
  );

  const handleClean = useCallback(() => {
    setOperationState("loading");
    setMessage("Scanning cleanup candidates...");
    void invoke<CleanEntry[]>("scan_clean_targets")
      .then((entries) => {
        setCleanupTargets(entries);
        setSelectedCleanupPaths(new Set(entries.map((entry) => entry.path)));
        setOperationState("idle");
        setMessage(entries.length > 0 ? "Review cleanup list" : "Nothing to clean");
      })
      .catch((error) => {
        setOperationState("error");
        setMessage(errorMessage(error));
      });
  }, []);

  const confirmCleanSelected = useCallback(() => {
    const paths = Array.from(selectedCleanupPaths);
    if (paths.length === 0) {
      return;
    }
    setOperationState("loading");
    setMessage("Deleting selected items...");
    void invoke<CleanResult>("clean_selected", { paths })
      .then((result) => {
        setSummary({ kind: "clean", result });
        setCleanupTargets([]);
        setSelectedCleanupPaths(new Set());
        setOperationState("success");
        setMessage("Done");
        void refreshStatus();
      })
      .catch((error) => {
        setOperationState("error");
        setMessage(errorMessage(error));
      });
  }, [refreshStatus, selectedCleanupPaths]);

  const handleOptimize = useCallback(() => {
    requestAction(
      "执行系统优化",
      "会执行安全维护任务，例如刷新系统缓存和文件系统状态。",
      "开始优化",
      () => invoke<OptimizeResult>("optimize"),
      (result) => ({ kind: "optimize", result }),
    );
  }, [requestAction]);

  const handleAnalyse = useCallback(async () => {
    await setPanelAutoHide(false);
    let selected: string | string[] | null;
    try {
      selected = await open({ directory: true, multiple: false, title: "Choose directory to analyse" });
    } finally {
      await setPanelAutoHide(true);
    }
    if (typeof selected !== "string") {
      return;
    }

    setOperationState("loading");
    setMessage("Scanning folder...");
    try {
      const nodes = await invoke<AnalysisNode[]>("analyse", { path: selected });
      setAnalysisNodes(nodes);
      setOperationState("success");
      setMessage("Scan complete");
    } catch (error) {
      setOperationState("error");
      setMessage(errorMessage(error));
    }
  }, []);

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
    <main className="h-screen overflow-hidden bg-transparent p-1 text-white drop-shadow-2xl">
      <div className="cachebar-shell flex h-full flex-col gap-3 rounded-3xl border border-white/10 bg-white/8 p-4 backdrop-blur-2xl">
        <header className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-lg font-black text-white">CacheBar</h1>
            <p className="text-[11px] font-semibold text-slate-300">
              {status ? `${status.platform} · uptime ${status.uptime}` : "Gathering status..."} · {updatedLabel}
            </p>
          </div>
        </header>

        <TabBar active={activeTab} onChange={setActiveTab} />

        <div className="min-h-0 flex-1 overflow-hidden">
          {activeTab === "overview" ? <OverviewTab status={status} cpuHistory={cpuHistory} onFreeUp={handleOptimize} /> : null}
          {activeTab === "cleanup" ? (
            <CleanupTab
              busy={busy}
              message={message}
              summary={summary}
              operationState={operationState}
              onScan={handleClean}
              cleanupTargets={cleanupTargets}
              selectedPaths={selectedCleanupPaths}
              onSelectAll={() => setSelectedCleanupPaths(new Set(cleanupTargets.map((entry) => entry.path)))}
              onSelectNone={() => setSelectedCleanupPaths(new Set())}
              onTogglePath={(path) =>
                setSelectedCleanupPaths((current) => {
                  const next = new Set(current);
                  if (next.has(path)) {
                    next.delete(path);
                  } else {
                    next.add(path);
                  }
                  return next;
                })
              }
              onConfirmClean={confirmCleanSelected}
            />
          ) : null}
          {activeTab === "analyse" ? <AnalyseTab busy={busy} message={message} nodes={analysisNodes} onPick={handleAnalyse} /> : null}
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
