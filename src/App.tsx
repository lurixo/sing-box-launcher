import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { Connections } from "./pages/Connections";
import { Logs } from "./pages/Logs";
import { Settings } from "./pages/Settings";
import { useAppStore } from "./stores/appStore";
import type { CoreStatus, ProxyGroup, Page, AppSettings } from "./types";

export function App() {
  const page = useAppStore((s) => s.page);
  const fetchStatus = useAppStore((s) => s.fetchStatus);
  const setStatus = useAppStore((s) => s.setStatus);
  const setGroups = useAppStore((s) => s.setGroups);
  const setPage = useAppStore((s) => s.setPage);
  const startCore = useAppStore((s) => s.startCore);
  const stopCore = useAppStore((s) => s.stopCore);
  const restartCore = useAppStore((s) => s.restartCore);

  // Initialize: fetch status and set up event listeners
  useEffect(() => {
    fetchStatus();

    // Auto-start the core on launch if enabled (and not already running, e.g.
    // when the core was left running after a previous close).
    (async () => {
      try {
        const s = await invoke<AppSettings>("get_settings");
        if (s.auto_start_core) {
          const st = await invoke<CoreStatus>("get_status");
          if (!st.running) startCore();
        }
      } catch { /* ignore */ }
    })();

    const unlistenStatus = listen<CoreStatus>("core-status-changed", (e) => {
      setStatus(e.payload);
    });

    const unlistenGroups = listen<ProxyGroup[]>("proxy-groups-updated", (e) => {
      setGroups(e.payload);
    });

    // Tray can request navigation (e.g. "active connections").
    const unlistenNav = listen<string>("navigate", (e) => {
      setPage(e.payload as Page);
    });

    // Tray core controls run through the same commands as the GUI buttons.
    const unlistenAction = listen<string>("tray-action", (e) => {
      if (e.payload === "start") startCore();
      else if (e.payload === "stop") stopCore();
      else if (e.payload === "restart") restartCore();
    });

    // Poll status every 5 seconds for uptime updates
    const interval = setInterval(fetchStatus, 5000);

    return () => {
      unlistenStatus.then((f) => f());
      unlistenGroups.then((f) => f());
      unlistenNav.then((f) => f());
      unlistenAction.then((f) => f());
      clearInterval(interval);
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--bg-base)",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--border-subtle)",
      }}
    >
      <TitleBar />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Sidebar />

        <main style={{ flex: 1, overflow: "auto" }}>
          {page === "dashboard" && <Dashboard />}
          {page === "connections" && <Connections />}
          {page === "logs" && <Logs />}
          {page === "settings" && <Settings />}
        </main>
      </div>
    </div>
  );
}
