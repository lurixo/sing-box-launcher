import {
  BoardRegular,
  GlobeRegular,
  PlugConnectedRegular,
  TextBulletListSquareRegular,
  SettingsRegular,
  NavigationRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { useT, type TranslationKey } from "../i18n/strings";
import type { Page } from "../types";

const navItems: { id: Page; icon: React.ReactNode; key: TranslationKey }[] = [
  { id: "dashboard", icon: <BoardRegular />, key: "nav.dashboard" },
  { id: "proxies", icon: <GlobeRegular />, key: "nav.proxies" },
  { id: "connections", icon: <PlugConnectedRegular />, key: "nav.connections" },
  { id: "logs", icon: <TextBulletListSquareRegular />, key: "nav.logs" },
  { id: "settings", icon: <SettingsRegular />, key: "nav.settings" },
];

export function Sidebar() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const collapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const t = useT();

  return (
    <nav
      style={{
        width: collapsed ? "var(--sidebar-collapsed)" : "var(--sidebar-width)",
        transition: "width 0.2s ease",
        borderRight: "1px solid var(--border-divider)",
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
        aria-label={t("nav.menu")}
      >
        <NavigationRegular style={{ fontSize: 20, flexShrink: 0 }} />
        {!collapsed && <span>{t("nav.menu")}</span>}
      </button>

      {navItems.map((item) => (
        <button
          key={item.id}
          className={`nav-item ${page === item.id ? "active" : ""}`}
          onClick={() => setPage(item.id)}
          style={{ gap: collapsed ? 0 : 12 }}
          aria-label={t(item.key)}
        >
          <span style={{ fontSize: 20, flexShrink: 0, display: "flex" }}>
            {item.icon}
          </span>
          {!collapsed && <span>{t(item.key)}</span>}
        </button>
      ))}
    </nav>
  );
}
