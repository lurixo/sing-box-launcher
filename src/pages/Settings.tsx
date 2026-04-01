import { useState, useEffect } from "react";
import {
  WeatherSunnyRegular,
  WeatherMoonRegular,
  DesktopRegular,
  ColorRegular,
  GlobeRegular,
} from "@fluentui/react-icons";
import { useAppStore } from "../stores/appStore";
import { ACCENT_PRESETS } from "../lib/colorEngine";
import { invoke } from "@tauri-apps/api/core";
import { enable, disable, isEnabled } from "@tauri-apps/plugin-autostart";
import { useReveal } from "../hooks/useReveal";
import type { Theme, AppSettings } from "../types";

const themes: { id: Theme; icon: React.ReactNode; label: string }[] = [
  { id: "light", icon: <WeatherSunnyRegular />, label: "Light" },
  { id: "dark", icon: <WeatherMoonRegular />, label: "Dark" },
  { id: "system", icon: <DesktopRegular />, label: "System" },
];

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      style={{
        width: 44,
        height: 24,
        borderRadius: 12,
        border: "none",
        background: checked ? "var(--accent-default)" : "var(--border-default)",
        cursor: disabled ? "not-allowed" : "pointer",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: checked ? 23 : 3,
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.2s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
        }}
      />
    </button>
  );
}

export function Settings() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const accentColor = useAppStore((s) => s.accentColor);
  const setAccentColor = useAppStore((s) => s.setAccentColor);
  const accentSource = useAppStore((s) => s.accentSource);
  const setAccentSource = useAppStore((s) => s.setAccentSource);
  const revealRef = useReveal<HTMLDivElement>();

  const [customInput, setCustomInput] = useState(accentColor);

  // ─── Autostart state ─────────────────────────────────────────────
  const [autostart, setAutostart] = useState(false);
  const [silentStart, setSilentStart] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);

  // ─── UWP state ───────────────────────────────────────────────────
  const [uwpLoading, setUwpLoading] = useState(false);
  const [uwpResult, setUwpResult] = useState<string | null>(null);

  // Load autostart + settings on mount
  useEffect(() => {
    (async () => {
      try {
        const enabled = await isEnabled();
        setAutostart(enabled);
        const settings = await invoke<AppSettings>("get_settings");
        setSilentStart(settings.silent_start);
      } catch {
        // ignore
      }
      setAutostartLoading(false);
    })();
  }, []);

  const handleAutostartToggle = async (val: boolean) => {
    try {
      if (val) {
        await enable();
      } else {
        await disable();
        // Also disable silent start when autostart is off
        setSilentStart(false);
        await invoke("set_silent_start", { enabled: false });
      }
      setAutostart(val);
    } catch {
      // ignore
    }
  };

  const handleSilentToggle = async (val: boolean) => {
    try {
      await invoke("set_silent_start", { enabled: val });
      setSilentStart(val);
    } catch {
      // ignore
    }
  };

  const handleUwpLoopback = async () => {
    setUwpLoading(true);
    setUwpResult(null);
    try {
      const result = await invoke<string>("enable_uwp_loopback");
      setUwpResult(result);
    } catch (e) {
      setUwpResult(`Error: ${e}`);
    }
    setUwpLoading(false);
  };

  const handleCustomAccent = () => {
    const hex = customInput.trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      setAccentColor(hex);
    }
  };

  return (
    <div
      ref={revealRef}
      className="animate-in"
      style={{ padding: "24px 28px", display: "flex", flexDirection: "column", gap: 20 }}
    >
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0, color: "var(--text-primary)" }}>
        Settings
      </h1>

      {/* ─── General ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>General</div>

        {/* Autostart */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Launch at startup</div>
          </div>
          {autostartLoading ? (
            <span className="progress-ring" style={{ width: 20, height: 20, borderWidth: 2 }} />
          ) : (
            <ToggleSwitch checked={autostart} onChange={handleAutostartToggle} />
          )}
        </div>

        {/* Silent Start - only visible when autostart is ON */}
        {autostart && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid var(--border-divider)" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>Silent start</div>
              <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
                Minimize to tray on launch
              </div>
            </div>
            <ToggleSwitch checked={silentStart} onChange={handleSilentToggle} />
          </div>
        )}

        {/* UWP Loopback */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>UWP loopback</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Launch loopback tool so UWP apps can use the local proxy
            </div>
          </div>
          <button
            className="fluent-btn reveal-target"
            onClick={handleUwpLoopback}
            disabled={uwpLoading}
            style={{ fontSize: 12, minHeight: 28, padding: "4px 14px" }}
          >
            {uwpLoading ? (
              <span className="progress-ring" style={{ width: 14, height: 14, borderWidth: 2 }} />
            ) : (
              <GlobeRegular style={{ fontSize: 14 }} />
            )}
            Open Tool
          </button>
        </div>

        {uwpResult && (
          <div
            className="infobar"
            style={{
              marginTop: 4,
              background: uwpResult.startsWith("Error") ? "var(--status-danger-bg)" : "var(--status-success-bg)",
              borderColor: uwpResult.startsWith("Error") ? "var(--status-danger)" : "var(--status-success)",
            }}
          >
            {uwpResult}
          </div>
        )}
      </div>

      {/* ─── Theme Mode ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>Appearance</div>
        <div className="section-label" style={{ marginBottom: 10 }}>Theme</div>
        <div style={{ display: "flex", gap: 8 }}>
          {themes.map((t) => (
            <button
              key={t.id}
              className={`fluent-btn reveal-target ${theme === t.id ? "accent" : ""}`}
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

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, padding: "8px 0" }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>Follow system accent</div>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>
              Use the accent color from Windows settings
            </div>
          </div>
          <ToggleSwitch
            checked={accentSource === "system"}
            onChange={(v) => setAccentSource(v ? "system" : "manual")}
          />
        </div>

        {accentSource === "manual" && (
          <>
            <div className="section-label" style={{ marginBottom: 10 }}>Presets</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 16 }}>
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.hex}
                  className={`accent-swatch ${accentColor.toLowerCase() === preset.hex.toLowerCase() ? "active" : ""}`}
                  style={{ background: preset.hex }}
                  onClick={() => setAccentColor(preset.hex)}
                  aria-label={`Accent color: ${preset.label}`}
                  title={preset.label}
                />
              ))}
            </div>

            <div className="section-label" style={{ marginBottom: 8 }}>Custom</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div
                style={{
                  width: 32, height: 32, borderRadius: "var(--radius-sm)",
                  background: accentColor, border: "1px solid var(--border-default)", flexShrink: 0,
                }}
              />
              <div
                style={{
                  display: "flex", alignItems: "center", flex: 1,
                  background: "var(--bg-card)", border: "1px solid var(--border-default)",
                  borderRadius: "var(--radius-sm)", overflow: "hidden",
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
                    border: "none", background: "transparent", outline: "none",
                    color: "var(--text-primary)", fontSize: 13, flex: 1,
                    padding: "6px 10px", fontFamily: "monospace",
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

        {/* Accent scale preview */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 8 }}>Accent scale</div>
          <div style={{ display: "flex", borderRadius: "var(--radius-sm)", overflow: "hidden", height: 28 }}>
            {[
              "var(--accent-dark-3)", "var(--accent-dark-2)", "var(--accent-dark-1)",
              "var(--accent-default)",
              "var(--accent-light-1)", "var(--accent-light-2)", "var(--accent-light-3)",
            ].map((cssVar, i) => (
              <div key={i} style={{ flex: 1, background: cssVar }} />
            ))}
          </div>
        </div>
      </div>

      {/* ─── About ─── */}
      <div className="fluent-card" style={{ padding: "18px 20px" }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>About</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
          <div>
            <strong style={{ color: "var(--text-primary)" }}>sing-box launcher</strong>{" "}v0.1.0
          </div>
          <div>A lightweight GUI for managing the sing-box proxy core.</div>
          <div style={{ marginTop: 4 }}>Built with Tauri v2 + React 19 + Rust</div>
        </div>
      </div>
    </div>
  );
}
