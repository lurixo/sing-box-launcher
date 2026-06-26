# Maestro

A lightweight Windows GUI for managing the [sing-box](https://sing-box.sagernet.org/) proxy core, built with **Tauri v2** (Rust backend + React frontend) and styled with **Windows Fluent Design System**.

## Features

- **Portable** — Single self-contained folder, no installer; all data lives in a `data/` folder beside the executable
- **Bundled Core** — The `sing-box.exe` core is packaged with each build
- **Core Updates** — Check for and download newer cores from [sing-box-releases](https://github.com/lurixo/sing-box-releases/releases) in-app
- **Core Management** — Start, stop, and restart the sing-box process with automatic config injection
- **Config Profiles** — Manage multiple named configs (create, edit, import, rename, delete, set active)
- **System Proxy** — Toggle Windows system proxy via registry with one click
- **Proxy Groups** — View and switch Selector-type proxy groups, test node latency
- **System Tray** — Minimize to tray with color-coded status icons (gray/green/blue)
- **Autostart** — Launch at login, with optional silent start to tray
- **Fluent UI** — Windows 11 native look with light/dark theme and dynamic accent color

## Screenshots

The app features three main panels:
- **Dashboard** — Core status, uptime, connection info, and quick controls
- **Proxies** — Group selector with node cards, delay testing, and search
- **Settings** — Theme switching and app info

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Rust** | stable (1.85+) | `rustup default stable` |
| **Node.js** | 22.x LTS | [nodejs.org](https://nodejs.org/) |
| **Tauri CLI** | 2.x | Installed via npm devDependency |

### Windows-specific

This project targets **Windows only**. The system proxy feature uses Windows Registry and WinINet APIs.

## Setup

```bash
# Clone the repo
git clone https://github.com/lurixo/sing-box-launcher.git
cd sing-box-launcher

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev

# Build a portable package (no installer)
npx tauri build --no-bundle
```

A production build is produced by CI as `maestro-portable.zip`: a folder with
`Maestro.exe` at the root and a `data/` subdirectory holding the bundled
`sing-box.exe` core, `EnableLoopback.exe`, `singbox-build-info.json`, plus
configs, settings and runtime files. Unzip it anywhere and run — no installation
required. (Requires the Microsoft Edge WebView2 runtime, present on Windows 11
and most Windows 10 systems.)

### Configs and the core

- The core (`sing-box.exe`) ships bundled. Use **Settings → Core** to check for and
  download a newer build from [sing-box-releases](https://github.com/lurixo/sing-box-releases/releases).
- Configs are named profiles stored under `data/configs/<name>.json`. Create, edit, or
  import them from the Dashboard; select the active one to run.
- On start, the launcher reads the active config, injects `clash_api`/`cache_file`
  settings, writes `config_runtime.json` (the original is never modified), and runs
  `sing-box.exe run -c config_runtime.json -D <base_dir>`.

## Project Structure

```
sing-box-launcher/
├── src/                        # React frontend
│   ├── components/
│   │   ├── TitleBar.tsx        # Custom window title bar
│   │   └── Sidebar.tsx         # NavigationView sidebar
│   ├── pages/
│   │   ├── Dashboard.tsx       # Status cards & controls
│   │   ├── Proxies.tsx         # Proxy group/node management
│   │   └── Settings.tsx        # Theme & about
│   ├── stores/
│   │   └── appStore.ts         # Zustand state management
│   ├── styles/
│   │   └── globals.css         # Fluent Design tokens & components
│   ├── types/
│   │   └── index.ts            # TypeScript type definitions
│   ├── App.tsx                 # Root component
│   └── main.tsx                # Entry point
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   ├── main.rs             # Entry point
│   │   ├── lib.rs              # Tauri setup & IPC commands
│   │   ├── manager.rs          # sing-box process lifecycle
│   │   ├── config.rs           # Config parsing & injection
│   │   ├── core_update.rs      # Core bundling & in-app updates
│   │   ├── proxy.rs            # Windows system proxy (registry + WinINet)
│   │   ├── clash.rs            # Clash API HTTP client
│   │   ├── groups.rs           # Proxy group state
│   │   ├── settings.rs         # App settings & config profiles
│   │   ├── accent.rs           # Windows accent color
│   │   ├── tray.rs             # System tray icon & menu
│   │   └── error.rs            # Unified error types
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── default.json        # Tauri v2 permissions
├── .github/workflows/
│   ├── build.yml               # CI: build on push/PR
│   └── release.yml             # CD: publish on tag
├── package.json
├── vite.config.ts
└── tsconfig.json
```

## IPC Commands

| Command | Signature | Description |
|---------|-----------|-------------|
| `start_core` | `() → ConfigInfo` | Start sing-box, returns proxy/API addresses |
| `stop_core` | `() → ()` | Stop sing-box, clear system proxy |
| `restart_core` | `() → ConfigInfo` | Stop then start |
| `get_status` | `() → CoreStatus` | Current running state and uptime |
| `toggle_system_proxy` | `() → bool` | Toggle Windows proxy, returns new state |
| `get_proxy_groups` | `() → ProxyGroup[]` | List all Selector groups |
| `switch_proxy` | `(group, node) → ()` | Switch selected node in a group |
| `test_group_delay` | `(group) → {name: delay}` | Test latency for all nodes |
| `open_base_dir` | `() → ()` | Open exe directory in Explorer |
| `list_configs` / `get_config` | `() → ConfigEntry[]` / `(name) → string` | List/read config profiles |
| `save_config` / `create_config` | `(name, content) → ()` / `(name) → ()` | Save or create a config profile |
| `delete_config` / `rename_config` | `(name) → ()` / `(old, new) → ()` | Delete or rename a config profile |
| `get_settings` / `set_silent_start` | `() → AppSettings` / `(enabled) → ()` | Read settings / toggle silent start |
| `set_active_config` | `(name) → ()` | Select the active config profile |
| `get_system_accent` | `() → string` | Windows accent color as hex |
| `enable_uwp_loopback` | `() → string` | Launch the UWP loopback exemption tool |
| `get_core_info` | `() → CoreInfo` | Installed core presence and build info |
| `check_core_update` | `() → CoreUpdateCheck` | Compare installed core against latest |
| `update_core` | `() → BuildInfo` | Download, verify, and install the latest core |

## CI/CD

### Build (on every push/PR to main)

The `build.yml` workflow:
- Builds on `windows-latest`
- Installs Rust stable + Node.js 22.x
- Downloads the latest `sing-box.exe` core per `singbox-build-info.json` (sha256-verified)
- Runs `npx tauri build --no-bundle`
- Assembles and uploads `maestro-portable.zip` (7-day retention)

### Release (on version tag)

To create a release:

```bash
# Tag a version
git tag v1.0.0
git push origin v1.0.0
```

The `release.yml` workflow will:
- Build the application and bundle the core
- Create a GitHub Release titled "Maestro v1.0.0"
- Upload the portable `.zip` as a release asset
- Auto-generate changelog from commits since the last tag

## Tech Stack

### Backend (Rust)
- **tauri** 2.10 — Application framework
- **tauri-build** 2.5 — Build script
- **thiserror** 2.0 — Error derive macro
- **anyhow** 1.0 — Application error handling
- **urlencoding** 2.1 — URL percent-encoding
- **tokio** ~1.47 LTS — Async runtime
- **reqwest** 0.13 — HTTP client (Clash API, core downloads)
- **serde/serde_json** 1.0 — Serialization
- **zip** 8 — Core archive extraction
- **sha2** 0.10 — Core download verification
- **winreg** 0.56 — Windows Registry
- **windows** 0.61 — Win32 API (WinINet)
- **tracing** 0.1 — Structured logging

### Frontend (TypeScript/React)
- **React** 19.2 — UI framework
- **Zustand** 5.0 — State management
- **Tailwind CSS** 4.1 — Utility-first CSS (v4, CSS-first config)
- **Vite** 8.0 — Build tool (Rolldown)
- **TypeScript** 6.0 — Type checking
- **@fluentui/react-icons** — Fluent Design icons

## License

GPL-3.0
