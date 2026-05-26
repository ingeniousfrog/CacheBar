# CacheBar

A lightweight macOS menu bar utility that combines real-time system monitoring with one-click cache cleanup. Built with Tauri 2 (Rust) + React + TailwindCSS.

CacheBar lives in your menu bar. Click the tray icon and a frameless, translucent panel slides down with a card-based dashboard inspired by iStat Menus — CPU activity, disk usage with I/O rates, RAM breakdown, fan RPM, network throughput — plus tabs for safe cache cleanup and folder size analysis.

## Features

- **Menu bar panel**: tray icon toggles a transparent, always-on-top panel; auto-hides on focus loss.
- **Overview tab** (card grid)
  - **CPU**: brand string (e.g. `Apple M2`), live SVG stacked area chart of User / System / Idle over the last 60 samples, and the current CPU die temperature.
  - **Disk**: root volume with `Used X / Total Y` (no misleading `U:` / `T:` shorthand), free space, usage bar, live read / write throughput, and optional disk temperature.
  - **RAM**: used / total / available / cached, with a `Free Up` shortcut that runs the optimize task.
  - **Fan**: current RPM, or `-- RPM` with a hint when SMC data is unavailable.
  - **Internet**: live ↓ / ↑ throughput plus the active IP / interface.
- **Cleanup tab**: scan for safe cache candidates (`scan_clean_targets`), review by category, multi-select, then delete via `clean_selected`. The list is always shown — nothing is deleted without an explicit click.
- **Analyse tab**: pick any folder, walk it, and explore an expandable size tree.
- **Bottom menu**: `Refresh` (⌘R), `Settings…` (⌘,), `About CacheBar`, `Quit` (⌘Q).
- **Settings**: refresh interval and a switch for SMC-based temperature / fan sampling (persisted to `localStorage`).
- **Privacy & safety**: every destructive action goes through a confirm dialog; cache scans return paths first so you can review before deletion.

## Architecture

```
+-----------------------------+         +--------------------------+
|        React + Vite         |  invoke |        Tauri (Rust)      |
|  src/App.tsx                |<------->|  src-tauri/src/main.rs   |
|  - TabBar / Overview        |         |  - tray + window toggle  |
|  - CPU SVG ring buffer (60) |         |  - command bindings      |
|  - Cleanup / Analyse views  |         +-----------+--------------+
|  - Settings / About modals  |                     |
+--------------+--------------+                     v
               ^                          +--------------------------+
               |  status / clean / ...    |   src-tauri/src/core/    |
               +--------------------------|  status.rs   - sampler   |
                                          |  clean.rs    - cache     |
                                          |  analyse.rs  - du tree   |
                                          |  optimize.rs - maint.    |
                                          |  uninstall.rs - app rm   |
                                          +--------------------------+
```

### Frontend (`src/`)

- `App.tsx` – single-file React entry point. Holds the global status snapshot, a `useRef`-backed 60-point CPU ring buffer, tab state, and `localStorage`-persisted settings.
- `styles.css` – Tailwind directives and transparent-window resets (no rounded edges on `html`/`body`/`#root` to avoid the "frame square" artifact).
- `main.tsx` / `index.html` – Vite bootstrap.

### Backend (`src-tauri/src/`)

- `main.rs` – Tauri app: tray icon, panel positioning under the tray, auto-hide on focus loss, and `#[tauri::command]` bindings (`status`, `scan_clean_targets`, `clean_selected`, `uninstall`, `optimize`, `analyse`, `quit_app`, `set_panel_auto_hide`).
- `core/status.rs` – stateful sampler held in a `OnceLock<Mutex<SamplerState>>`. Computes per-call rates by diffing against the previous sample.
  - CPU: `top -l 1 -n 0` → `% user / % sys / % idle`.
  - RAM: `sysctl hw.memsize` + `vm_stat` (and `/proc/meminfo` on Linux).
  - Disk usage: `df -kP`; per-disk I/O via `iostat -Id <dev> 1 1`.
  - Network: `ipconfig getifaddr` + `netstat -ibn` (`/proc/net/*` on Linux).
  - Power: `pmset -g batt`.
  - Temperature / fan (best-effort): `powermetrics --samplers smc,thermal`. Requires root; on failure the sampler disables itself and returns `None`, so the UI gracefully shows `--℃` / `-- RPM`.
- `core/clean.rs` – returns a list of safe cleanup candidates (user caches, logs, etc.) so the UI can let the user review before deleting.
- `core/analyse.rs` – recursive directory walk that emits an `AnalysisNode` tree sized for the UI.
- `core/optimize.rs` – low-risk maintenance tasks (e.g. flushing filesystem caches).
- `core/uninstall.rs` – removes an `.app` together with its leftover support files.

### Data flow

```
tray click ──► toggle panel
panel mount ──► invoke("status") every N s
                        │
                        ▼
                SamplerState (Mutex)
                  - diff net / disk counters
                  - cache temp / fan (30s TTL)
                        │
                        ▼
                StatusSnapshot ──► React state
                                    │
                                    ├─► CPU ring buffer (60)
                                    └─► Cards (CPU / Disk / RAM / Fan / Net)
```

## Requirements

- macOS 11+ (Apple Silicon or Intel) for the primary build target. Linux and Windows build cleanly but the menu-bar UX and SMC sampling are macOS-specific.
- Node.js 18+ and npm
- Rust toolchain (stable) and Xcode command-line tools (`xcode-select --install`)

## Getting started

```bash
git clone https://github.com/heqk/CacheBar.git
cd CacheBar
npm install
npm run tauri dev
```

`npm run tauri dev` starts Vite on `http://localhost:1420` and launches the Tauri shell. Click the tray icon (a small `C` glyph) in the menu bar to toggle the panel.

### Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server only (for UI iteration in the browser). |
| `npm run build` | Type-check and build the React bundle into `dist/`. |
| `npm run tauri dev` | Hot-reload Tauri app + Vite. |
| `npm run tauri build` | Build a release binary and bundle installers. |

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘R | Refresh status |
| ⌘, | Open Settings |
| ⌘Q | Quit CacheBar |

### Enabling temperature / fan readings

`powermetrics` needs root privileges. By default the panel will show `--℃` / `-- RPM`. To enable the readings:

```bash
sudo /Applications/CacheBar.app/Contents/MacOS/CacheBar
```

…or, during development:

```bash
sudo npm run tauri dev
```

Once the first `powermetrics` invocation succeeds the values are cached and refreshed every 30 s.

## Building a DMG

The DMG installer is produced by Tauri's bundler.

```bash
npm install
npm run tauri build -- --bundles dmg
```

The first build takes 5–15 minutes because every Rust dependency is compiled in release mode. Subsequent builds are incremental.

Output locations (relative to the repo root):

- `src-tauri/target/release/bundle/dmg/CacheBar_0.1.0_aarch64.dmg` (Apple Silicon)
- `src-tauri/target/release/bundle/macos/CacheBar.app`

To build a universal binary (`x86_64` + `aarch64`) instead, install both Rust targets first and pass `--target universal-apple-darwin`:

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles dmg
```

### Notes

- For distribution, sign and notarize the `.app` before bundling the DMG. Set `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, and `APPLE_TEAM_ID` in your environment and let `tauri build` handle the rest.
- Bundle targets: pass `--bundles dmg` (DMG only), `--bundles app` (just the `.app`), or omit the flag to build everything declared in `tauri.conf.json`.
- The Cargo mirror configured in `.cargo/config.toml` (Tsinghua) makes the first Rust compile much faster from mainland China; remove the file if you prefer crates.io directly.

## Project layout

```
CacheBar/
├── index.html                # Vite entry
├── package.json              # Frontend deps & scripts
├── tailwind.config.js
├── postcss.config.js
├── tsconfig.json
├── vite.config.ts
├── src/
│   ├── App.tsx               # All UI lives here (tabs, cards, modals)
│   ├── main.tsx
│   └── styles.css
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json       # Window / bundle config
│   ├── icons/                # Tray & app icons
│   ├── capabilities/         # Tauri ACLs
│   └── src/
│       ├── main.rs           # Tray + commands
│       └── core/
│           ├── mod.rs        # Shared structs / CoreResult
│           ├── status.rs     # Sampler & metrics
│           ├── clean.rs
│           ├── analyse.rs
│           ├── optimize.rs
│           └── uninstall.rs
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
