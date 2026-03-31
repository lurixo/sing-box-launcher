// ─── Dynamic Color Engine ───────────────────────────────────────────────────
// All UI colors derive from a single accent hex + theme mode.
// Both Light and Dark modes tint backgrounds from the accent Hue.
// Changing the accent → the entire UI shifts in color atmosphere.
// ────────────────────────────────────────────────────────────────────────────

// ─── HSL Helpers ────────────────────────────────────────────────────────────

export interface HSL {
  h: number; // 0-360
  s: number; // 0-100
  l: number; // 0-100
}

export function hexToHSL(hex: string): HSL {
  let r = 0, g = 0, b = 0;
  const h = hex.replace("#", "");
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16) / 255;
    g = parseInt(h[1] + h[1], 16) / 255;
    b = parseInt(h[2] + h[2], 16) / 255;
  } else {
    r = parseInt(h.substring(0, 2), 16) / 255;
    g = parseInt(h.substring(2, 4), 16) / 255;
    b = parseInt(h.substring(4, 6), 16) / 255;
  }

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let s = 0;
  let hue = 0;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: hue = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: hue = ((b - r) / d + 2) / 6; break;
      case b: hue = ((r - g) / d + 4) / 6; break;
    }
  }

  return {
    h: Math.round(hue * 360),
    s: Math.round(s * 100),
    l: Math.round(l * 100),
  };
}

export function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;

  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// ─── Relative Luminance & Contrast ──────────────────────────────────────────

function hexToRGB(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRGB(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(c1: string, c2: string): number {
  const l1 = relativeLuminance(c1);
  const l2 = relativeLuminance(c2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ─── Accent 7-Level Shade Generation ────────────────────────────────────────

export interface AccentShades {
  default: string;
  light1: string;
  light2: string;
  light3: string;
  dark1: string;
  dark2: string;
  dark3: string;
}

export function generateAccentShades(hex: string): AccentShades {
  const { h, s, l } = hexToHSL(hex);
  return {
    default: hex,
    light1: hslToHex(h, Math.max(0, s - 5), Math.min(100, l + 8)),
    light2: hslToHex(h, Math.max(0, s - 12), Math.min(100, l + 18)),
    light3: hslToHex(h, Math.max(0, s - 20), Math.min(100, l + 30)),
    dark1: hslToHex(h, s, Math.max(0, l - 8)),
    dark2: hslToHex(h, s, Math.max(0, l - 15)),
    dark3: hslToHex(h, s, Math.max(0, l - 25)),
  };
}

// ─── Accent-Derived Background Generation ───────────────────────────────────
// Both Light and Dark derive backgrounds from accent Hue — unified logic.

interface ThemeBg {
  base: string;
  surface: string;
  card: string;
  cardHover: string;
  cardActive: string;
  subtle: string;
  subtleHover: string;
  selected: string;
  selectedHover: string;
  borderDefault: string;
  borderCard: string;
  borderDivider: string;
  borderSubtle: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textDisabled: string;
  shadowCard: string;
  shadowDialog: string;
  shadowFlyout: string;
}

function generateLightBg(accentHex: string): ThemeBg {
  const { h } = hexToHSL(accentHex);
  return {
    // Background layers: base (darkest) → surface → card (lightest)
    // Each step ≥ 5% lightness difference for clear visual separation
    base:          hslToHex(h, 8, 91),
    surface:       hslToHex(h, 5, 96),
    card:          hslToHex(h, 3, 100),
    cardHover:     hslToHex(h, 4, 97),
    cardActive:    hslToHex(h, 5, 94),
    subtle:        hslToHex(h, 5, 94),
    subtleHover:   hslToHex(h, 6, 91),
    selected:      hslToHex(h, 22, 90),
    selectedHover: hslToHex(h, 28, 85),

    // Borders: clearly visible against backgrounds
    borderDefault: hslToHex(h, 6, 82),
    borderCard:    hslToHex(h, 5, 85),
    borderDivider: hslToHex(h, 7, 80),
    borderSubtle:  hslToHex(h, 4, 88),

    // Text: near-neutral (S ≤ 3%), strong contrast
    textPrimary:   hslToHex(h, 8, 8),
    textSecondary: hslToHex(h, 3, 32),
    textTertiary:  hslToHex(h, 2, 52),
    textDisabled:  hslToHex(h, 2, 68),

    // Shadows: slightly stronger for depth
    shadowCard:    "0 2px 6px rgba(0,0,0,0.06), 0 0 2px rgba(0,0,0,0.03)",
    shadowDialog:  "0 8px 32px rgba(0,0,0,0.16)",
    shadowFlyout:  "0 4px 16px rgba(0,0,0,0.10)",
  };
}

function generateDarkBg(accentHex: string): ThemeBg {
  const { h } = hexToHSL(accentHex);
  return {
    // Background layers: base (darkest) → surface → card (lightest)
    base:          hslToHex(h, 20, 8),
    surface:       hslToHex(h, 18, 13),
    card:          hslToHex(h, 15, 18),
    cardHover:     hslToHex(h, 14, 22),
    cardActive:    hslToHex(h, 13, 15),
    subtle:        hslToHex(h, 14, 11),
    subtleHover:   hslToHex(h, 14, 15),
    selected:      hslToHex(h, 24, 22),
    selectedHover: hslToHex(h, 28, 26),

    // Borders: visible on dark backgrounds
    borderDefault: hslToHex(h, 10, 22),
    borderCard:    hslToHex(h, 8, 20),
    borderDivider: hslToHex(h, 10, 18),
    borderSubtle:  hslToHex(h, 6, 14),

    // Text: near-neutral, high contrast
    textPrimary:   "#EFEFEF",
    textSecondary: hslToHex(h, 6, 65),
    textTertiary:  hslToHex(h, 5, 48),
    textDisabled:  hslToHex(h, 4, 32),

    shadowCard:    "0 2px 4px rgba(0,0,0,0.24), 0 0 2px rgba(0,0,0,0.14)",
    shadowDialog:  "0 8px 32px rgba(0,0,0,0.48)",
    shadowFlyout:  "0 4px 16px rgba(0,0,0,0.36)",
  };
}

// ─── Text-on-Accent: ensures contrast ≥ 4.5:1 ─────────────────────────────

export function getTextOnAccent(accentHex: string): string {
  return contrastRatio(accentHex, "#FFFFFF") >= 4.5 ? "#FFFFFF" : "#1A1A1A";
}

// ─── Status Colors per theme ────────────────────────────────────────────────

interface StatusColors {
  success: string;
  successBg: string;
  warning: string;
  warningBg: string;
  danger: string;
  dangerBg: string;
}

function getStatusColors(isDark: boolean): StatusColors {
  if (isDark) {
    return {
      success: "#6CCB5F",  successBg: "rgba(108, 203, 95, 0.12)",
      warning: "#FCE100",  warningBg: "rgba(252, 225, 0, 0.12)",
      danger:  "#FF99A4",  dangerBg:  "rgba(255, 153, 164, 0.12)",
    };
  }
  return {
    success: "#0F7B0F",  successBg: "rgba(15, 123, 15, 0.08)",
    warning: "#9D5D00",  warningBg: "rgba(157, 93, 0, 0.08)",
    danger:  "#C42B1C",  dangerBg:  "rgba(196, 43, 28, 0.08)",
  };
}

// ─── Full Theme Token Application ───────────────────────────────────────────

export type ThemeMode = "light" | "dark";

export function applyThemeTokens(accent: string, mode: ThemeMode) {
  const root = document.documentElement;
  const shades = generateAccentShades(accent);
  const isDark = mode === "dark";
  const bg = isDark ? generateDarkBg(accent) : generateLightBg(accent);
  const status = getStatusColors(isDark);
  const textOnAccent = getTextOnAccent(accent);

  // ─── Accent color scale ───
  root.style.setProperty("--accent-default", shades.default);
  root.style.setProperty("--accent-light-1", shades.light1);
  root.style.setProperty("--accent-light-2", shades.light2);
  root.style.setProperty("--accent-light-3", shades.light3);
  root.style.setProperty("--accent-dark-1", shades.dark1);
  root.style.setProperty("--accent-dark-2", shades.dark2);
  root.style.setProperty("--accent-dark-3", shades.dark3);

  // ─── Backgrounds ───
  root.style.setProperty("--bg-base", bg.base);
  root.style.setProperty("--bg-surface", bg.surface);
  root.style.setProperty("--bg-card", bg.card);
  root.style.setProperty("--bg-card-hover", bg.cardHover);
  root.style.setProperty("--bg-card-active", bg.cardActive);
  root.style.setProperty("--bg-subtle", bg.subtle);
  root.style.setProperty("--bg-subtle-hover", bg.subtleHover);
  root.style.setProperty("--bg-selected", bg.selected);
  root.style.setProperty("--bg-selected-hover", bg.selectedHover);

  // ─── Text ───
  root.style.setProperty("--text-primary", bg.textPrimary);
  root.style.setProperty("--text-secondary", bg.textSecondary);
  root.style.setProperty("--text-tertiary", bg.textTertiary);
  root.style.setProperty("--text-disabled", bg.textDisabled);
  root.style.setProperty("--text-on-accent", textOnAccent);

  // ─── Borders ───
  root.style.setProperty("--border-default", bg.borderDefault);
  root.style.setProperty("--border-card", bg.borderCard);
  root.style.setProperty("--border-divider", bg.borderDivider);
  root.style.setProperty("--border-subtle", bg.borderSubtle);
  root.style.setProperty("--border-accent", isDark ? shades.light1 : shades.dark2);
  root.style.setProperty("--border-focus", isDark ? shades.light1 : shades.default);

  // ─── Shadows ───
  root.style.setProperty("--shadow-card", bg.shadowCard);
  root.style.setProperty("--shadow-dialog", bg.shadowDialog);
  root.style.setProperty("--shadow-flyout", bg.shadowFlyout);

  // ─── Status colors ───
  root.style.setProperty("--status-success", status.success);
  root.style.setProperty("--status-success-bg", status.successBg);
  root.style.setProperty("--status-warning", status.warning);
  root.style.setProperty("--status-warning-bg", status.warningBg);
  root.style.setProperty("--status-danger", status.danger);
  root.style.setProperty("--status-danger-bg", status.dangerBg);

  // ─── Theme class ───
  root.classList.toggle("dark", isDark);
  root.style.setProperty("color-scheme", isDark ? "dark" : "light");
}

// ─── Preset Accent Palette (from Windows 11) ────────────────────────────────

export const ACCENT_PRESETS: { hex: string; label: string }[] = [
  { hex: "#0078D4", label: "Blue" },
  { hex: "#0099BC", label: "Teal" },
  { hex: "#038387", label: "Dark Teal" },
  { hex: "#00B294", label: "Seafoam" },
  { hex: "#0063B1", label: "Navy" },
  { hex: "#6B69D6", label: "Indigo" },
  { hex: "#8B5CF6", label: "Purple" },
  { hex: "#C239B3", label: "Orchid" },
  { hex: "#9A0089", label: "Magenta" },
  { hex: "#E81123", label: "Red" },
  { hex: "#FF8C00", label: "Orange" },
  { hex: "#10B981", label: "Emerald" },
];
