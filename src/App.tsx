import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

type DiskInfo = {
  name: string;
  mount: string;
  used: number;
  free: number;
  total: number;
  used_percent: number;
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
};

type StatusSnapshot = {
  cpu_usage: number;
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

type OperationSummary =
  | { kind: "empty" }
  | { kind: "clean"; result: CleanResult }
  | { kind: "optimize"; result: OptimizeResult };

const emptySummary: OperationSummary = { kind: "empty" };

type ConfirmationRequest = {
  title: string;
  description: string;
  confirmLabel: string;
  action: () => Promise<void>;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
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
    // If the native helper is unavailable, the action can still continue.
  }
}

function Meter({ value, tone }: { value: number; tone: "green" | "amber" | "blue" | "rose" }) {
  const color = {
    green: "bg-emerald-500",
    amber: "bg-amber-500",
    blue: "bg-sky-500",
    rose: "bg-rose-500",
  }[tone];

  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-white/18">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(Math.max(value, 0), 100)}%` }} />
    </div>
  );
}

function LogoMark() {
  return (
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-sky-400/20 ring-1 ring-sky-200/25">
      <div className="grid h-7 w-7 place-items-center rounded-xl bg-slate-950/70 text-sm font-black text-sky-300 ring-1 ring-white/10">C</div>
    </div>
  );
}

function StatusCard({
  label,
  value,
  detail,
  meter,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  meter: number;
  tone: "green" | "amber" | "blue" | "rose";
}) {
  return (
    <div className="rounded-2xl bg-slate-950/48 p-3 shadow-sm ring-1 ring-white/8">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[11px] font-bold uppercase tracking-wide text-slate-300">{label}</span>
        <span className="text-sm font-black text-sky-300">{value}</span>
      </div>
      <div className="mt-2">
        <Meter value={meter} tone={tone} />
      </div>
      <div className="mt-2 min-h-8 text-[10px] font-semibold leading-4 text-slate-300">{detail}</div>
    </div>
  );
}

function ActionButton({
  label,
  detail,
  disabled,
  onClick,
}: {
  label: string;
  detail: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-2xl bg-slate-950/46 px-3 py-2.5 text-left shadow-sm ring-1 ring-white/8 transition hover:bg-slate-900/70 hover:ring-sky-300/35 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="block text-sm font-black text-white">{label}</span>
      <span className="mt-1 block text-[11px] leading-4 text-slate-300">{detail}</span>
    </button>
  );
}

function SystemConsole({ status }: { status: StatusSnapshot | null }) {
  const disks = status?.disks.slice(0, 3) ?? [];
  const processes = status?.top_processes.slice(0, 3) ?? [];
  const rootDisk = disks[0];

  return (
    <section className="grid grid-cols-2 gap-2 rounded-2xl bg-[linear-gradient(145deg,#203c68,#0f4b51_55%,#0d203f)] p-2 text-slate-100 shadow-inner">
      <ConsoleCard className="row-span-2 min-h-[154px]" title="CPU" accent={formatPercent(status?.cpu_usage ?? 0)}>
        <div className="mt-2 rounded-xl bg-slate-950/30 p-2">
          <Meter value={status?.cpu_usage ?? 0} tone="blue" />
          <div className="mt-3 space-y-1.5">
            {processes.length > 0 ? (
              processes.map((process) => <ConsoleRow key={`${process.name}-${process.cpu}`} label={process.name} value={formatPercent(process.cpu)} />)
            ) : (
              <ConsoleMuted>No process sample</ConsoleMuted>
            )}
          </div>
        </div>
      </ConsoleCard>

      <ConsoleCard title={rootDisk?.name ?? "Disk"} accent={rootDisk ? formatPercent(rootDisk.used_percent) : "--"}>
        <ConsoleRow label="Used" value={rootDisk ? formatBytes(rootDisk.used) : "--"} />
        <ConsoleRow label="Total" value={rootDisk ? formatBytes(rootDisk.total) : "--"} />
        <div className="mt-2">
          <Meter value={rootDisk?.used_percent ?? 0} tone={(rootDisk?.used_percent ?? 0) > 90 ? "rose" : "blue"} />
        </div>
      </ConsoleCard>

      <ConsoleCard title="RAM" accent={formatPercent(status?.mem_usage ?? 0)}>
        <ConsoleRow label="Used" value={formatBytes(status?.mem_used ?? 0)} />
        <ConsoleRow label="Total" value={formatBytes(status?.mem_total ?? 0)} />
        <div className="mt-2">
          <Meter value={status?.mem_usage ?? 0} tone="blue" />
        </div>
      </ConsoleCard>

      <ConsoleCard title="Power" accent={status?.power ? formatPercent(status.power.percent) : "--"}>
        {status?.power ? (
          <>
            <ConsoleRow label="State" value={status.power.status} />
            <ConsoleRow label="Left" value={status.power.time_left} />
          </>
        ) : (
          <ConsoleMuted>No battery data</ConsoleMuted>
        )}
      </ConsoleCard>

      <ConsoleCard title="Internet" accent={status?.network?.name ?? "--"}>
        {status?.network ? (
          <>
            <ConsoleRow label="IP" value={status.network.ip} />
            <ConsoleRow label="Interface" value={status.network.name} />
          </>
        ) : (
          <ConsoleMuted>No active IP</ConsoleMuted>
        )}
      </ConsoleCard>

      {disks.length > 1 ? (
        <ConsoleCard className="col-span-2" title="Volumes" accent={`${disks.length} online`}>
          <div className="grid grid-cols-3 gap-2">
            {disks.map((disk) => (
              <div key={disk.mount} className="min-w-0">
                <div className="truncate text-[10px] font-bold text-slate-300">{disk.name}</div>
                <div className="mt-1 text-[11px] font-black text-white">{formatBytes(disk.used)}</div>
                <div className="truncate text-[10px] font-semibold text-slate-400">{formatBytes(disk.free)} free</div>
              </div>
            ))}
          </div>
        </ConsoleCard>
      ) : null}
    </section>
  );
}

function ConsoleCard({ title, accent, className = "", children }: { title: string; accent: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`min-w-0 rounded-2xl bg-slate-950/55 p-3 shadow-sm ring-1 ring-white/5 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-black text-slate-100">{title}</div>
        <div className="truncate text-xs font-black text-sky-300">{accent}</div>
      </div>
      <div className="mt-2 space-y-1.5">{children}</div>
    </div>
  );
}

function ConsoleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 text-[11px]">
      <span className="truncate font-semibold text-slate-300">{label}</span>
      <span className="max-w-[96px] truncate text-right font-black text-white">{value}</span>
    </div>
  );
}

function ConsoleMuted({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold text-slate-400">{children}</div>;
}

function OperationNotice({ summary, state, message }: { summary: OperationSummary; state: OperationState; message: string }) {
  if (state === "idle" && summary.kind === "empty") {
    return (
      <div className="rounded-2xl bg-slate-950/34 px-3 py-2 text-[11px] font-semibold text-slate-300 ring-1 ring-white/8">
        缓存瘦身会先列出候选清单，勾选确认后才会删除。
      </div>
    );
  }

  if (state === "loading" || state === "error") {
    return (
      <div className={`rounded-2xl px-3 py-2 text-xs font-bold ring-1 ${state === "error" ? "bg-rose-500/16 text-rose-100 ring-rose-300/25" : "bg-sky-400/16 text-sky-100 ring-sky-200/25"}`}>
        {message}
      </div>
    );
  }

  if (summary.kind === "clean") {
    const total = summary.result.removed.reduce((sum, entry) => sum + entry.freed, 0);
    const skipped = summary.result.skipped.length;
    return <DoneNotice text={`已清理 ${formatBytes(total)} · ${summary.result.removed.length} 项${skipped > 0 ? `，跳过 ${skipped} 项受保护文件` : ""}`} />;
  }

  if (summary.kind === "optimize") {
    return <DoneNotice text={`已执行 ${summary.result.tasks.length} 个优化任务`} />;
  }

  return null;
}

function DoneNotice({ text }: { text: string }) {
  return <div className="rounded-2xl bg-emerald-400/15 px-3 py-2 text-xs font-bold text-emerald-100 ring-1 ring-emerald-200/25">{text}</div>;
}

function CleanupReviewDialog({
  open,
  entries,
  selectedPaths,
  busy,
  onClose,
  onSelectAll,
  onSelectNone,
  onTogglePath,
  onConfirm,
}: {
  open: boolean;
  entries: CleanEntry[];
  selectedPaths: Set<string>;
  busy: boolean;
  onClose: () => void;
  onSelectAll: () => void;
  onSelectNone: () => void;
  onTogglePath: (path: string) => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  const groupedEntries = entries.reduce<Record<string, CleanEntry[]>>((groups, entry) => {
    const category = entry.category || "其他";
    return { ...groups, [category]: [...(groups[category] ?? []), entry] };
  }, {});
  const selectedTotal = entries
    .filter((entry) => selectedPaths.has(entry.path))
    .reduce((sum, entry) => sum + entry.freed, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center rounded-[32px] bg-slate-950/55 p-4">
      <section className="flex max-h-[86vh] w-full flex-col rounded-3xl bg-[linear-gradient(145deg,#244d73,#0f4b51_58%,#102047)] shadow-2xl ring-1 ring-white/12">
        <header className="border-b border-white/10 px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-black text-white">确认要删除的缓存</h2>
              <p className="mt-1 text-xs font-semibold text-slate-300">按分类勾选项目。只有选中的项目会被删除。</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-xl bg-slate-950/50 px-3 py-1.5 text-xs font-black text-white ring-1 ring-white/10">
              关闭
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="text-xs font-bold text-slate-200">
              已选 {selectedPaths.size} 项 · {formatBytes(selectedTotal)}
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={onSelectAll} className="rounded-lg bg-sky-500 px-2.5 py-1.5 text-[11px] font-black text-white">
                全选
              </button>
              <button type="button" onClick={onSelectNone} className="rounded-lg bg-slate-950/45 px-2.5 py-1.5 text-[11px] font-black text-slate-100 ring-1 ring-white/10">
                全不选
              </button>
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {Object.entries(groupedEntries).map(([category, items]) => (
            <div key={category} className="mb-4 last:mb-0">
              <div className="mb-2 text-[11px] font-black uppercase tracking-wide text-slate-300">{category}</div>
              <div className="space-y-2">
                {items.map((entry) => (
                  <label key={entry.path} className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl bg-slate-950/45 px-3 py-2 ring-1 ring-white/8">
                    <input
                      type="checkbox"
                      checked={selectedPaths.has(entry.path)}
                      onChange={() => onTogglePath(entry.path)}
                      className="h-4 w-4 accent-sky-500"
                    />
                    <span className="min-w-0 truncate text-xs font-semibold text-slate-100" title={entry.path}>
                      {entry.path}
                    </span>
                    <span className="text-xs font-black text-sky-200">{formatBytes(entry.freed)}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <footer className="grid grid-cols-2 gap-2 border-t border-white/10 px-4 py-3">
          <button type="button" onClick={onClose} disabled={busy} className="rounded-xl bg-slate-950/50 px-3 py-2 text-sm font-black text-white ring-1 ring-white/10 disabled:opacity-50">
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || selectedPaths.size === 0}
            className="rounded-xl bg-rose-500 px-3 py-2 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "删除中..." : "确认删除所选项"}
          </button>
        </footer>
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
    <div className="fixed inset-0 z-40 flex items-center justify-center rounded-[32px] bg-slate-950/55 p-5">
      <section className="w-full rounded-3xl bg-[linear-gradient(145deg,#244d73,#0f4b51_58%,#102047)] p-4 shadow-2xl ring-1 ring-white/12">
        <h2 className="text-base font-black text-white">{title}</h2>
        <p className="mt-2 text-xs font-semibold leading-5 text-slate-300">{description}</p>
        <div className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" disabled={busy} onClick={onCancel} className="rounded-xl bg-slate-950/50 px-3 py-2 text-sm font-black text-white ring-1 ring-white/10 disabled:opacity-50">
            取消
          </button>
          <button type="button" disabled={busy} onClick={onConfirm} className="rounded-xl bg-sky-500 px-3 py-2 text-sm font-black text-white disabled:opacity-50">
            {busy ? "处理中..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function AnalysisDrawer({
  open,
  nodes,
  busy,
  onPick,
  onToggle,
}: {
  open: boolean;
  nodes: AnalysisNode[];
  busy: boolean;
  onPick: () => void;
  onToggle: () => void;
}) {
  return (
    <section className="rounded-3xl bg-slate-950/44 shadow-sm ring-1 ring-white/8">
      <button type="button" onClick={nodes.length > 0 ? onToggle : onPick} className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left">
        <div>
          <div className="text-sm font-black text-white">空间占用分析</div>
          <div className="mt-0.5 text-[11px] font-semibold text-slate-300">选择文件夹后展开大文件夹树，可随时折叠</div>
        </div>
        <span className="rounded-full bg-sky-500 px-3 py-1 text-[11px] font-black text-white">
          {nodes.length > 0 ? (open ? "折叠" : "展开") : "选择"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-white/10 px-2 py-2">
          <button
            type="button"
            disabled={busy}
            onClick={onPick}
            className="mb-2 w-full rounded-xl border border-dashed border-white/20 px-3 py-2 text-xs font-bold text-slate-200 hover:border-sky-300 disabled:opacity-50"
          >
            {busy ? "扫描中..." : "重新选择文件夹"}
          </button>
          <div className="max-h-56 overflow-auto pr-1">
            {nodes.length > 0 ? <AnalysisTree nodes={nodes} /> : <div className="px-3 py-8 text-center text-xs text-slate-400">还没有选择文件夹</div>}
          </div>
        </div>
      ) : null}
    </section>
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

export default function App() {
  const [status, setStatus] = useState<StatusSnapshot | null>(null);
  const [operationState, setOperationState] = useState<OperationState>("idle");
  const [message, setMessage] = useState("Ready");
  const [summary, setSummary] = useState<OperationSummary>(emptySummary);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisNodes, setAnalysisNodes] = useState<AnalysisNode[]>([]);
  const [cleanupDialogOpen, setCleanupDialogOpen] = useState(false);
  const [cleanupTargets, setCleanupTargets] = useState<CleanEntry[]>([]);
  const [selectedCleanupPaths, setSelectedCleanupPaths] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);

  const busy = operationState === "loading";

  const refreshStatus = useCallback(async () => {
    try {
      const snapshot = await invoke<StatusSnapshot>("status");
      setStatus(snapshot);
    } catch (error) {
      setMessage(errorMessage(error));
      setOperationState("error");
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

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
        setCleanupDialogOpen(true);
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
        setCleanupDialogOpen(false);
        setCleanupTargets([]);
        setSelectedCleanupPaths(new Set());
        setOperationState("success");
        setMessage("Done");
        void refreshStatus();
      })
      .catch((error) => {
        setCleanupDialogOpen(false);
        setOperationState("error");
        setMessage(errorMessage(error));
      });
  }, [refreshStatus, selectedCleanupPaths]);

  const handleOptimize = useCallback(() => {
    requestAction(
      "执行系统优化",
      "会执行安全维护任务，例如刷新系统缓存和文件系统状态。过程完成后面板会继续保留在这里。",
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

    setAnalysisOpen(true);
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

  const handleQuit = useCallback(() => {
    void invoke("quit_app");
  }, []);

  const diskDetail = useMemo(() => {
    if (!status) {
      return "Waiting for disk data";
    }
    return `${formatBytes(status.disk_free)} free of ${formatBytes(status.disk_total)}`;
  }, [status]);

  return (
    <main className="h-screen overflow-hidden rounded-[34px] bg-transparent text-white">
      <div className="cachebar-shell flex h-full flex-col gap-3 rounded-[34px] bg-[radial-gradient(circle_at_18%_8%,rgba(96,165,250,0.35),transparent_28%),linear-gradient(145deg,#244d73,#0f4b51_54%,#12204b)] p-4 shadow-2xl ring-1 ring-white/18">
        <header className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <LogoMark />
            <div>
              <h1 className="text-xl font-black tracking-normal text-white">CacheBar</h1>
              <p className="mt-1 text-xs font-semibold text-slate-300">{status ? `${status.platform} · uptime ${status.uptime}` : "Gathering status..."}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={handleQuit} className="rounded-2xl bg-slate-950/45 px-3 py-2 text-xs font-black text-white ring-1 ring-white/10 hover:bg-slate-900/70">
              Quit
            </button>
          </div>
        </header>

        <section className="grid grid-cols-3 gap-2">
          <StatusCard label="CPU" value={formatPercent(status?.cpu_usage ?? 0)} detail="top sample" meter={status?.cpu_usage ?? 0} tone="green" />
          <StatusCard
            label="Memory"
            value={formatPercent(status?.mem_usage ?? 0)}
            detail={`${formatBytes(status?.mem_available ?? 0)} avail · ${formatBytes(status?.mem_cached ?? 0)} cached`}
            meter={status?.mem_usage ?? 0}
            tone="amber"
          />
          <StatusCard label="Disk" value={formatPercent(status?.disk_usage ?? 0)} detail={diskDetail} meter={status?.disk_usage ?? 0} tone={(status?.disk_usage ?? 0) > 90 ? "rose" : "blue"} />
        </section>

        <SystemConsole status={status} />

        <section className="grid grid-cols-2 gap-2">
          <ActionButton label="刷新状态" detail="重新读取系统状态" disabled={busy} onClick={refreshStatus} />
          <ActionButton label="缓存瘦身" detail="列出候选项，勾选后删除" disabled={busy} onClick={handleClean} />
          <ActionButton label="空间占用分析" detail="选择文件夹并展开大文件夹树" disabled={busy} onClick={handleAnalyse} />
          <ActionButton label="系统优化" detail="执行安全维护任务" disabled={busy} onClick={handleOptimize} />
        </section>

        <OperationNotice summary={summary} state={operationState} message={message} />

        {analysisOpen || analysisNodes.length > 0 ? (
          <AnalysisDrawer open={analysisOpen} nodes={analysisNodes} busy={busy} onPick={handleAnalyse} onToggle={() => setAnalysisOpen((value) => !value)} />
        ) : null}

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

        <CleanupReviewDialog
          open={cleanupDialogOpen}
          entries={cleanupTargets}
          selectedPaths={selectedCleanupPaths}
          busy={busy}
          onClose={() => setCleanupDialogOpen(false)}
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
          onConfirm={confirmCleanSelected}
        />
      </div>
    </main>
  );
}
