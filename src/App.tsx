import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { Dashboard } from "./pages/Dashboard";
import { Proxies } from "./pages/Proxies";
import { Settings } from "./pages/Settings";
import { useAppStore } from "./stores/appStore";
import type { CoreStatus, ProxyGroup } from "./types";

export function App() {
  const page = useAppStore((s) => s.page);
  const fetchStatus = useAppStore((s) => s.fetchStatus);
  const setStatus = useAppStore((s) => s.setStatus);
  const setGroups = useAppStore((s) => s.setGroups);

  // Initialize: fetch status and set up event listeners
  useEffect(() => {
    fetchStatus();

    const unlistenStatus = listen<CoreStatus>("core-status-changed", (e) => {
      setStatus(e.payload);
    });

    const unlistenGroups = listen<ProxyGroup[]>("proxy-groups-updated", (e) => {
      setGroups(e.payload);
    });

    // Poll status every 5 seconds for uptime updates
    const interval = setInterval(fetchStatus, 5000);

    return () => {
      unlistenStatus.then((f) => f());
      unlistenGroups.then((f) => f());
      clearInterval(interval);
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "var(--fluent-bg-mica)",
        backdropFilter: "blur(80px)",
        WebkitBackdropFilter: "blur(80px)",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid var(--fluent-border-subtle)",
      }}
    >
      <TitleBar />

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        <Sidebar />

        <main style={{ flex: 1, overflow: "auto" }}>
          {page === "dashboard" && <Dashboard />}
          {page === "proxies" && <Proxies />}
          {page === "settings" && <Settings />}
        </main>
      </div>
    </div>
  );
}
