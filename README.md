# sing-box-launcher

A lightweight Windows GUI for managing the [sing-box](https://sing-box.sagernet.org/) proxy core, built with **Tauri v2** (Rust backend + React frontend) and styled with **Windows Fluent Design System**.

## Features

- **Core Management** — Start, stop, and restart the sing-box process with automatic config injection
- **System Proxy** — Toggle Windows system proxy via registry with one click
- **Proxy Groups** — View and switch Selector-type proxy groups, test node latency
- **System Tray** — Minimize to tray with color-coded status icons (gray/green/blue)
- **Fluent UI** — Windows 11 native look with Mica/Acrylic effects, light/dark theme support

## Screenshots

The app features three main panels:
- **Dashboard** — Core status, uptime, connection info, and quick controls
- **Proxies** — Group selector with node cards, delay testing, and search
- **Settings** — Theme switching and app info

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Rust** | stable (1.85+) | `rustup default stable` |
| **Node.js** | 24.x LTS | [nodejs.org](https://nodejs.org/) |
| **Tauri CLI** | 2.x | Installed via npm devDependency |

### Windows-specific

This project targets **Windows only**. The system proxy feature uses Windows Registry and WinINet APIs.

## Setup

```bash
# Clone the repo
git clone https://github.com/your-org/sing-box-launcher.git
cd sing-box-launcher

# Install frontend dependencies
npm install

# Run in development mode
npm run tauri dev

# Build for production
npm run tauri build
```

### sing-box setup

Place the following files in the same directory as the built executable:

1. `sing-box.exe` — The sing-box binary
2. `config.json` — Your sing-box configuration

The launcher will:
- Read `config.json` and inject `clash_api` settings for proxy group management
- Write `config_runtime.json` (the original `config.json` is never modified)
- Start `sing-box.exe run -c config_runtime.json`

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
│   │   ├── proxy.rs            # Windows system proxy (registry + WinINet)
│   │   ├── clash.rs            # Clash API HTTP client
│   │   ├── groups.rs           # Proxy group state
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

## CI/CD

### Build (on every push/PR to main)

The `build.yml` workflow:
- Builds on `windows-latest`
- Installs Rust stable + Node.js 24.x
- Runs `npm ci` + `npm run tauri build`
- Uploads `.msi` and `.exe` installers as artifacts (7-day retention)

### Release (on version tag)

To create a release:

```bash
# Tag a version
git tag v1.0.0
git push origin v1.0.0
```

The `release.yml` workflow will:
- Build the application
- Create a GitHub Release titled "sing-box-launcher v1.0.0"
- Upload `.msi` and `.exe` installers as release assets
- Auto-generate changelog from commits since the last tag

## Tech Stack

### Backend (Rust)
- **tauri** 2.10 — Application framework
- **tokio** ~1.47 LTS — Async runtime
- **reqwest** 0.13 — HTTP client (Clash API)
- **serde/serde_json** 1.0 — Serialization
- **winreg** 0.56 — Windows Registry
- **windows** 0.61 — Win32 API (WinINet)
- **tracing** 0.1 — Structured logging

### Frontend (TypeScript/React)
- **React** 19.2 — UI framework
- **Zustand** 5.0 — State management
- **Tailwind CSS** 4.1 — Utility-first CSS (v4, CSS-first config)
- **Vite** 8.0 — Build tool (Rolldown)
- **@fluentui/react-icons** — Fluent Design icons

## License

GPL-3.0
