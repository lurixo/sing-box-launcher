# Maestro

**A lightweight Windows GUI for the [sing-box](https://sing-box.sagernet.org/) proxy core** — built with **Tauri v2** (Rust backend + React/TypeScript frontend) and styled after the **Windows 11 Fluent Design System**.

![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![License](https://img.shields.io/badge/license-GPL--3.0-blue)
![UI](https://img.shields.io/badge/UI-English%20%2B%20%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-success)

> **Disclaimer:** Maestro is an independent, **third-party** GUI for the [sing-box](https://sing-box.sagernet.org/) core. It is **not affiliated with, sponsored by, or endorsed by** the sing-box project or its authors. "sing-box" is referenced only to describe what Maestro is compatible with; all sing-box trademarks and copyrights belong to their respective owners.

---

## Highlights

- 🎛️ **One-click core control** — start, stop, and restart sing-box with automatic config injection; live status, uptime, and outbound IP at a glance.
- 🔀 **Switchable kernel sources** — ship-bundled **lurixo** by default, or pull builds on demand from **SagerNet** or **reF1nd**, all from inside the app.
- ⬆️ **Self-updating** — the portable build updates itself (timestamp-based, SHA-256 verified, restart-and-swap); the kernel updates independently, on your confirmation.
- 📈 **Live traffic overview** — upload and download on a single shared-axis chart, plus connection count, memory (Maestro + core), and cumulative totals.
- 🪵 **Privacy-first logs** — kept in memory only, **never written to disk**; export just the lines you pick (redacted), with a one-shot sanitized crash dump only if something actually crashes.
- 🌐 **System proxy in one click** — toggle the Windows system proxy via the registry; clear warning when a config is TUN-only.
- 🟢 **Color-coded tray** — the tray icon shows state at a glance: **gray** (stopped), **green** (running), **blue** (running + system proxy on).
- 🎨 **Native Fluent look** — light/dark/system theme, dynamic Windows accent color, and a fully **bilingual UI (English / 简体中文)**.

---

## Features

**Core & configuration**
- Start / stop / restart the sing-box process with automatic `clash_api` + `cache_file` injection (your original config is never modified — a `config_runtime.json` is generated).
- Manage multiple named config profiles: create, edit, import, rename, delete, and set the active one.
- Validate & format config JSON before saving.
- View and switch **Selector** proxy groups, and test node latency.
- Live **Connections** view with per-connection close and close-all.

**Kernel sources & updates**
- Choose where the sing-box core comes from: **lurixo** (bundled, default), **SagerNet**, or **reF1nd**.
- Check, download, and apply core updates in-app — the running core keeps serving traffic during the download, and only restarts after you confirm.
- **Clear cache** to remove `cache.db` and leftover downloaded cores (the in-use core is kept).

**App self-update** *(portable edition)*
- Maestro checks for a newer release and, on your confirmation, swaps its own executable and relaunches — updating only the app, never your kernel, settings, or configs.
- Installed (setup.exe) builds intentionally don't self-update; they point you to the latest installer instead.

**Monitoring**
- Traffic overview chart combining upload + download on one shared axis, with live speeds, active connection count, memory usage (Maestro + core), and cumulative up/down totals.
- Outbound IP shown inline — click to copy.

**Privacy & diagnostics**
- Logs live **in memory only** and are never persisted. The core always records full detail; the in-app level filter only changes what you see.
- Export exactly the log lines you select to a text file — credentials are best-effort redacted on the way out.
- A single, redacted `crash-dump.txt` is written **only** on a real crash (panic, unexpected core exit, or an unclean prior shutdown), and surfaced on the next launch.

**System integration**
- One-click Windows **system proxy** toggle (registry + WinINet).
- **Run as administrator** relaunch (UAC) for TUN-mode configs.
- **Autostart** at login, optional **silent start** to tray, and a configurable **startup delay** for boot autostart (lets the network settle).
- **Close to tray**, **exit core on close**, **start core on launch**, **allow multiple instances**, and a **UWP loopback** exemption helper.

**Appearance & language**
- Light / dark / system theme.
- Accent color: follow the Windows accent, pick a preset, or set a custom color (Maestro derives the full tonal scale from it).
- Full **English / 简体中文** interface (the UI defaults to 简体中文).

---

## Installation

Maestro is **Windows-only** and ships in two editions on the [Releases page](https://github.com/lurixo/Maestro/releases). Both bundle the sing-box core — no separate core download or installation step.

| | **Portable** *(recommended)* | **Installer** |
|---|---|---|
| File | `maestro-<version>-windows-amd64v3-portable.zip` | `maestro-<version>-windows-amd64v3-setup.exe` |
| Install | Unzip anywhere and run `Maestro.exe` | Run the NSIS installer (per-user, no admin needed) |
| Data location | `data/` folder beside the executable | `data/` folder inside the install directory |
| **Self-update** | ✅ Updates itself in place | ❌ Update by downloading a new installer |
| Add/Remove Programs | No entry (just delete the folder) | Registered; uninstallable from Windows |

**Which should I pick?** Use the **portable** edition if you want hassle-free, in-app self-updates and a self-contained folder you can move or delete freely. Use the **installer** if you prefer a traditional, system-registered install — it won't be replaced by the portable self-updater.

### System requirements

- **Windows 10 or 11** (64-bit).
- A **CPU that supports the x86-64-v3 microarchitecture** (AVX2 / BMI2 / FMA) — Intel Haswell (2013) / AMD Excavator and newer. Both Maestro and the bundled core are built for this baseline; the kernel already requires it, so Maestro adds no new hardware requirement.
- The **Microsoft Edge WebView2** runtime (preinstalled on Windows 11 and most Windows 10 systems).
- **Administrator rights** are required only for **TUN-mode** configs; Maestro can relaunch itself with a UAC prompt.

---

## Getting started

1. **Download** the [portable zip or installer](https://github.com/lurixo/Maestro/releases) and launch **Maestro**.
2. On the **Dashboard**, add a config: click **New** to paste sing-box config JSON, or **Import** a `.json` file. Use **Check & Format** to validate it, then **Set Active**.
3. Click **Start** to launch the core. Status, uptime, traffic, and your outbound IP appear live.
4. Toggle **System Proxy** to route Windows apps through it (configs with only a TUN inbound don't need this — Maestro will tell you).
5. Pick a node in the proxy groups on the Dashboard, or test node latency to choose the fastest.
6. Close the window to send Maestro to the **tray** — the icon color tells you the state (gray / green / blue). Left-click the tray to bring the window back; right-click for quick start/stop/restart.

> **TUN mode:** if your config uses a TUN inbound, enable **Run as administrator** in **Settings → General** (Maestro relaunches with a UAC prompt). Without elevation the core may fail to start the TUN interface.

---

## Kernel sources

Maestro can fetch the sing-box core from three sources, selectable in **Settings → Core → Kernel source**:

| Source | How it's tracked | Notes |
|--------|------------------|-------|
| **lurixo** *(default)* | Bundled with every Maestro build; compared by monotonic build id | The trusted default — releases carry a published SHA-256 that Maestro **requires** before installing. |
| **SagerNet** | Official upstream `SagerNet/sing-box` GitHub Releases, highest semantic version (pre-releases included) | Fetched on demand. |
| **reF1nd** | `reF1nd/sing-box-releases` GitHub Releases, highest semantic version | Fetched on demand. |

**Switching is safe and explicit.** Pick a source, then **Check** → **Download**. The download is staged next to the running core (which keeps serving traffic); Maestro then asks **"Apply new core?"** and only swaps + restarts the core once you confirm. The previous core is set aside for rollback if the swap fails. When fetching from SagerNet/reF1nd, Maestro prefers the `amd64v3` build (matching the app's microarchitecture) and falls back to the baseline `amd64` build.

Downloads are pinned to the **exact source repository** and follow redirects only within GitHub's own hosts. **Clear cache** (Settings → Core) removes `cache.db` and any leftover downloaded cores while keeping the one in use.

---

## How updates work

Maestro has **two independent update mechanisms**:

### 1. App self-update (portable edition)
- Maestro learns its own build timestamp from a bundled manifest and checks the newest GitHub release.
- Updates are decided by **build timestamp** (not version number) and the download is **SHA-256 verified** against the release's published hash.
- On your confirmation, Maestro swaps its own executable and relaunches automatically. **Only the app binary is replaced** — your kernel, settings, and configs are untouched.
- **Installed builds don't self-update** by swapping the exe (that would desync the installer's registration); they direct you to download the latest installer instead.

### 2. Kernel (sing-box core) update
- Runs against whichever **kernel source** you've selected (see above).
- Download is **staged** while the core keeps running, then applied on a **confirmed restart**, with rollback if the swap fails.
- **lurixo** downloads must match a published SHA-256. **SagerNet/reF1nd** publish no upstream checksum, so integrity rests on the repository-pinned HTTPS download plus an in-session re-verification of the staged bytes at apply time.

---

## Privacy

Maestro is built to keep your data on your machine:

- **Logs are kept in memory only and are never written to disk.** View them live on the **Logs** page; the in-app level filter only changes the view (the core still records full detail).
- **You choose what leaves memory.** Export only the log lines you select to a file of your choosing — the API secret and common credential fields (`password`, `uuid`, `private_key`, `psk`, `secret`, `token`, `auth_str`, `api_secret`) are best-effort redacted first.
- **One-shot crash dump only.** A single, overwrite-only `crash-dump.txt` is written **only** when Maestro or the core actually crashes (or an unclean prior shutdown is detected at startup). It is redacted with the same rules and carries a banner warning that it may still contain network destinations from your session — review before sharing.
- **No telemetry or analytics.** Maestro's only outbound requests are update checks and core/app downloads (to GitHub), an optional outbound-IP lookup you trigger, and the local API of your own running core.

---

## Building from source

Maestro targets **Windows**. The required Rust and Node toolchains are pinned in the repo (`rust-toolchain.toml` and `.nvmrc`); install the [Tauri prerequisites](https://tauri.app/start/prerequisites/) (including the WebView2 runtime and a C++ build environment), then:

```bash
# Clone
git clone https://github.com/lurixo/Maestro.git
cd Maestro

# Install frontend dependencies
npm install

# Run in development
npm run tauri dev

# Build a portable package (no installer)
npx tauri build --no-bundle
```

> Builds target the **x86-64-v3** microarchitecture (configured in `src-tauri/.cargo/config.toml`) to match the bundled core, so the build host must be AVX2-capable. Release artifacts (portable zip + NSIS installer) are produced by CI on tagged versions.

---

## License

[GPL-3.0](LICENSE).

## Acknowledgements

- The [sing-box](https://sing-box.sagernet.org/) project and its authors — the proxy core Maestro drives.
- The kernel-source maintainers: [lurixo](https://github.com/lurixo/sing-box-releases), [SagerNet](https://github.com/SagerNet/sing-box), and [reF1nd](https://github.com/reF1nd/sing-box-releases).
- [Tauri](https://tauri.app/), [React](https://react.dev/), and the [Fluent UI](https://github.com/microsoft/fluentui-system-icons) icon set.
