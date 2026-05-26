<p align="center">
  <img src="src-tauri/icons/icon.png" alt="CacheBar logo" width="48" height="48" style="vertical-align: middle; border-radius: 10px;" />
  <strong style="font-size: 1.75rem; font-weight: 700; vertical-align: middle;"> CacheBar</strong>
</p>

<p align="center">
  A lightweight macOS menu bar utility for real-time system monitoring and safe cache cleanup.<br />
  Built with Tauri 2 (Rust) + React + Tailwind CSS.
</p>

Click the menu bar icon to open a rounded, translucent panel: **Overview** shows CPU, disk, memory, network, and top processes; **Cleanup** scans categorized safe-to-remove caches with review before delete.

## Features

- **Menu bar panel** — tray icon toggles a frameless panel; auto-hides on focus loss (disabled during scan/delete and while modals are open).
- **Overview**
  - **CPU** — brand string, live stacked area chart (User / System / Idle), total usage %.
  - **Disk** — root volume `Used / Total`, usage bar, live read/write rates (APFS-aware used space).
  - **Memory** — used / total / available / cached; **Free Up** runs optimize tasks.
  - **Network** — live ↓ / ↑ throughput, active IP and interface.
  - **Top processes** — top 5 by CPU % with bar indicators.
- **Cleanup** — mole-style sections and categories (safe / review), expandable items, multi-select, sticky delete bar, post-clean summary.
- **Bottom menu** — Refresh (⌘R), Settings… (⌘,), About CacheBar, Quit (⌘Q).
- **Settings** — refresh interval (persisted in `localStorage`).
- **Safety** — destructive actions require confirmation; cache paths are scanned first for review.

## Install (macOS)

### Download DMG (recommended)

A pre-built **Apple Silicon** (`aarch64`) DMG is hosted on Baidu Netdisk:

| | |
| --- | --- |
| **Link** | https://pan.baidu.com/s/1s698O2B0GMjsj70nlVKhfA?pwd=frog |
| **提取码** | `frog` |

**Steps**

1. Open the link above and download `CacheBar_0.1.0_aarch64.dmg` (or the latest DMG in the share).
2. Double-click the DMG, then drag **CacheBar.app** into **Applications**.
3. **First launch** — if macOS shows an unidentified-developer warning:
   - Open **System Settings → Privacy & Security**, click **Open Anyway**, or
   - Right-click **CacheBar.app** in Applications → **Open**.
4. Click the **CacheBar** icon in the menu bar (rounded app icon) to show or hide the panel.

> Requires **macOS 11+** on Apple Silicon. Intel Macs need a separate build (`x86_64`); see [Building a DMG](#building-a-dmg) below.

### Build from source

```bash
git clone https://github.com/ingeniousfrog/CacheBar.git
cd CacheBar
npm install
npm run tauri dev
```

`npm run tauri dev` starts Vite and the Tauri shell. Use the tray icon to toggle the panel.

## Requirements

- macOS 11+ (Apple Silicon recommended for the pre-built DMG)
- Node.js 18+ and npm (development only)
- Rust stable + Xcode Command Line Tools (`xcode-select --install`) (development only)

## Useful scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server only (UI in browser). |
| `npm run build` | Type-check and build the React bundle to `dist/`. |
| `npm run tauri dev` | Hot-reload Tauri app + Vite. |
| `npm run tauri build` | Release binary and installers. |

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| ⌘R | Refresh status |
| ⌘, | Open Settings |
| ⌘Q | Quit CacheBar |

## Architecture

```
+-----------------------------+         +--------------------------+
|        React + Vite         |  invoke |        Tauri (Rust)      |
|  src/App.tsx                |<------->|  src-tauri/src/main.rs   |
|  - Overview / Cleanup tabs  |         |  - tray + window toggle  |
|  - CPU history (60 samples) |         |  - command bindings      |
+--------------+--------------+         +-----------+--------------+
               ^                                    |
               |  status / clean / …                v
               +--------------------------+  src-tauri/src/core/
                                          status.rs, clean.rs, …
```

### Backend highlights (`src-tauri/src/core/`)

- **`status.rs`** — CPU (`top`), RAM (`sysctl` / `vm_stat`), disk (`df` + `iostat`), network (`netstat`), top processes; stateful rate sampling.
- **`clean.rs`** — categorized scan (`CleanScanResult`), safe path whitelist, APFS snapshot handling.
- **`optimize.rs`** — maintenance tasks (e.g. cache purge).
- **`tray_icon.rs`** — rounded menu-bar tray icon generation.

## Building a DMG

```bash
npm install
npm run tauri build -- --bundles dmg
```

First release build may take several minutes. Output (typical paths):

- `src-tauri/target/release/bundle/dmg/CacheBar_0.1.0_aarch64.dmg`
- `src-tauri/target/release/bundle/macos/CacheBar.app`

Universal binary (`x86_64` + `aarch64`):

```bash
rustup target add x86_64-apple-darwin aarch64-apple-darwin
npm run tauri build -- --target universal-apple-darwin --bundles dmg
```

For distribution outside personal use, sign and notarize the `.app` before sharing the DMG.

## Project layout

```
CacheBar/
├── src/
│   ├── App.tsx           # UI (Overview, Cleanup, modals)
│   ├── main.tsx
│   └── styles.css
├── src-tauri/
│   ├── icons/icon.png    # App & tray source icon (shown above)
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs
│       ├── tray_icon.rs
│       └── core/
└── README.md
```

## License

MIT — see [LICENSE](LICENSE).
