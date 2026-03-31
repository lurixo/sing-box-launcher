import {
  WeatherSunnyRegular,
  WeatherMoonRegular,
  DesktopRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "@/stores/appStore";
import type { Theme } from "@/types";

const themes: { id: Theme; icon: React.ReactNode; label: string }[] = [
  { id: "light", icon: <WeatherSunnyRegular />, label: "Light" },
  { id: "dark", icon: <WeatherMoonRegular />, label: "Dark" },
  { id: "system", icon: <DesktopRegular />, label: "System" },
];

export function Settings() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  return (
    <div className="animate-in" style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}>
      {/* Appearance */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 14,
          }}
        >
          Appearance
        </div>

        <div
          style={{
            fontSize: 12,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.04em",
            color: "var(--fluent-text-secondary)",
            marginBottom: 10,
          }}
        >
          Theme
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {themes.map((t) => (
            <button
              key={t.id}
              className={`fluent-btn ${theme === t.id ? "accent" : ""}`}
              onClick={() => setTheme(t.id)}
              style={{ flex: 1 }}
            >
              <span style={{ fontSize: 18 }}>{t.icon}</span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* About */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 600,
            marginBottom: 14,
          }}
        >
          About
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            fontSize: 13,
            color: "var(--fluent-text-secondary)",
          }}
        >
          <div>
            <strong style={{ color: "var(--fluent-text-primary)" }}>sing-box launcher</strong>{" "}
            v0.1.0
          </div>
          <div>A lightweight GUI for managing the sing-box proxy core.</div>
          <div style={{ marginTop: 4 }}>
            Built with Tauri v2 + React 19 + Rust
          </div>
        </div>
      </div>
    </div>
  );
}
