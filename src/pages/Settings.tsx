import { useState } from "react";
import {
  WeatherSunnyRegular,
  WeatherMoonRegular,
  DesktopRegular,
  ColorRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { ACCENT_PRESETS } from "../lib/colorEngine";
import type { Theme } from "../types";

const themes: { id: Theme; icon: React.ReactNode; label: string }[] = [
  { id: "light", icon: <WeatherSunnyRegular />, label: "Light" },
  { id: "dark", icon: <WeatherMoonRegular />, label: "Dark" },
  { id: "system", icon: <DesktopRegular />, label: "System" },
];

export function Settings() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const accentColor = useAppStore((s) => s.accentColor);
  const setAccentColor = useAppStore((s) => s.setAccentColor);
  const accentSource = useAppStore((s) => s.accentSource);
  const setAccentSource = useAppStore((s) => s.setAccentSource);

  const [customInput, setCustomInput] = useState(accentColor);

  const handleCustomAccent = () => {
    const hex = customInput.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      setAccentColor(hex);
    }
  };

  return (
    <div
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}
    >
      {/* Page Title */}
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
        Settings
      </h1>
      {/* ─── Theme Mode ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          Appearance
        </div>
        <div className="section-label" style={{ marginBottom: 10 }}>
          Theme
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {themes.map((t) => (
            <button
              key={t.id}
              className={`fluent-btn ${theme === t.id ? "accent" : ""}`}
              onClick={() => setTheme(t.id)}
              style={{ flex: 1, flexDirection: "column", gap: 4, padding: "10px 8px" }}
            >
              <span style={{ fontSize: 18, display: "flex" }}>{t.icon}</span>
              <span style={{ fontSize: 12 }}>{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* ─── Accent Color ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          <ColorRegular style={{ fontSize: 18 }} />
          Accent Color
        </div>

        {/* Follow system toggle */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
            padding: "8px 0",
          }}
        >
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Follow system accent</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Use the accent color from Windows settings
            </div>
          </div>
          <button
            className={`fluent-btn ${accentSource === "system" ? "accent" : ""}`}
            onClick={() => setAccentSource(accentSource === "system" ? "manual" : "system")}
            style={{ minHeight: 28, padding: "4px 12px", fontSize: 12 }}
          >
            {accentSource === "system" ? "ON" : "OFF"}
          </button>
        </div>

        {/* Presets — only when manual */}
        {accentSource === "manual" && (
          <>
            <div className="section-label" style={{ marginBottom: 10 }}>
              Presets
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.hex}
                  className={`accent-swatch ${
                    accentColor.toLowerCase() === preset.hex.toLowerCase() ? "active" : ""
                  }`}
                  style={{ background: preset.hex }}
                  onClick={() => setAccentColor(preset.hex)}
                  aria-label={`Accent color: ${preset.label}`}
                  title={preset.label}
                />
              ))}
            </div>

            {/* Custom hex input */}
            <div className="section-label" style={{ marginBottom: 8 }}>
              Custom
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: "var(--radius-sm)",
                  background: accentColor,
                  border: "1px solid var(--border-default)",
                  flexShrink: 0,
                }}
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flex: 1,
                  background: "var(--bg-card)",
                  border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-sm)",
                  overflow: "hidden",
                }}
              >
                <input
                  type="text"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleCustomAccent()}
                  placeholder="#0078D4"
                  maxLength={7}
                  style={{
                    border: "none",
                    background: "transparent",
                    outline: "none",
                    color: "var(--text-primary)",
                    fontSize: 13,
                    flex: 1,
                    padding: "6px 10px",
                    fontFamily: "monospace",
                  }}
                />
                <button
                  className="fluent-btn accent"
                  onClick={handleCustomAccent}
                  style={{ borderRadius: 0, minHeight: 30, fontSize: 12, padding: "4px 12px", border: "none" }}
                >
                  Apply
                </button>
              </div>
            </div>
          </>
        )}

        {/* Live accent scale preview */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>
            Accent scale
          </div>
          <div
            style={{
              display: "flex",
              borderRadius: "var(--radius-sm)",
              overflow: "hidden",
              height: 28,
            }}
          >
            {(
              [
                "var(--accent-dark-3)",
                "var(--accent-dark-2)",
                "var(--accent-dark-1)",
                "var(--accent-default)",
                "var(--accent-light-1)",
                "var(--accent-light-2)",
                "var(--accent-light-3)",
              ] as const
            ).map((cssVar, i) => (
              <div
                key={i}
                style={{
                  flex: 1,
                  background: cssVar,
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* ─── About ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>
          About
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
          <div>
            <strong style={{ color: "var(--text-primary)" }}>sing-box launcher</strong>{" "}
            v0.1.0
          </div>
          <div>A lightweight GUI for managing the sing-box proxy core.</div>
          <div style={{ marginTop: 4 }}>Built with Tauri v2 + React 19 + Rust</div>
        </div>
      </div>
    </div>
  );
}
