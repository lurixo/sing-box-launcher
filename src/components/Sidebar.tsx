import {
  BoardRegular,
  GlobeRegular,
  SettingsRegular,
  NavigationRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import type { Page } from "../types";

const navItems: { id: Page; icon: React.ReactNode; label: string }[] = [
  { id: "dashboard", icon: <BoardRegular />, label: "Dashboard" },
  { id: "proxies", icon: <GlobeRegular />, label: "Proxies" },
  { id: "settings", icon: <SettingsRegular />, label: "Settings" },
];

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);

  return (
    <nav
      style={{
        width: collapsed ? "var(--sidebar-collapsed)" : "var(--sidebar-width)",
        transition: "width 0.2s ease",
        borderRight: "1px solid var(--fluent-border-divider)",
        display: "flex",
        flexDirection: "column",
        padding: "8px 6px",
        gap: 2,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <button
        className="nav-item"
        onClick={toggleSidebar}
        style={{ marginBottom: 8, gap: collapsed ? 0 : 12 }}
        aria-label="Toggle sidebar"
      >
        <NavigationRegular style={{ fontSize: 20, flexShrink: 0 }} />
        {!collapsed && <span>Menu</span>}
      </button>

      {navItems.map((item) => (
        <button
          key={item.id}
          className={`nav-item ${page === item.id ? "active" : ""}`}
          onClick={() => setPage(item.id)}
          style={{ gap: collapsed ? 0 : 12 }}
          aria-label={item.label}
        >
          <span style={{ fontSize: 20, flexShrink: 0, display: "flex" }}>
            {item.icon}
          </span>
          {!collapsed && <span>{item.label}</span>}
        </button>
      ))}
    </nav>
  );
}
