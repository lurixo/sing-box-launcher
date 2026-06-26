import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyThemeTokens, type ThemeMode } from "../lib/colorEngine";
import type { Lang } from "../i18n/strings";
import type {
  CoreStatus,
  ConfigInfo,
  ProxyGroup,
  DelayMap,
  Page,
  Theme,
} from "../types";

interface AppState {
  // Navigation
  page: Page;
  sidebarCollapsed: boolean;
  setPage: (page: Page) => void;
  toggleSidebar: () => void;

  // Theme
  theme: Theme;
  accentColor: string;
  accentSource: "system" | "manual";
  setTheme: (theme: Theme) => void;
  setAccentColor: (hex: string) => void;
  setAccentSource: (source: "system" | "manual") => void;
  fetchSystemAccent: () => Promise<void>;

  // Language
  lang: Lang;
  setLang: (lang: Lang) => void;

  // Core status
  status: CoreStatus;
  loading: boolean;
  error: string | null;

  // Proxy groups
  groups: ProxyGroup[];
  delays: Record<string, DelayMap>;
  testingGroup: string | null;

  // Outbound-IP refresh signal (bumped on clash-mode or node switch)
  ipNonce: number;

  // Actions
  fetchStatus: () => Promise<void>;
  startCore: () => Promise<void>;
  stopCore: () => Promise<void>;
  restartCore: () => Promise<void>;
  toggleProxy: () => Promise<void>;
  fetchGroups: () => Promise<void>;
  switchProxy: (group: string, node: string) => Promise<void>;
  testDelay: (group: string) => Promise<void>;
  bumpIp: () => void;

  // Internal
  setStatus: (status: CoreStatus) => void;
  setGroups: (groups: ProxyGroup[]) => void;
  clearError: () => void;
}

const defaultStatus: CoreStatus = {
  running: false,
  proxy_server: "",
  api_address: "",
  uptime_secs: 0,
  proxy_enabled: false,
};

// ─── Persistence ────────────────────────────────────────────────────────────

const STORAGE_THEME = "sb-theme";
const STORAGE_ACCENT = "sb-accent";
const STORAGE_ACCENT_SRC = "sb-accent-source";
const STORAGE_LANG = "sb-lang";
const DEFAULT_ACCENT = "#0078D4";

function load(key: string, fallback: string): string {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
}
function save(key: string, val: string) {
  try { localStorage.setItem(key, val); } catch { /* noop */ }
}

// ─── Resolve system preference → ThemeMode ──────────────────────────────────

function resolveMode(theme: Theme): ThemeMode {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return theme;
}

// ─── Store ──────────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>((set, get) => ({
  // Navigation
  page: "dashboard",
  sidebarCollapsed: false,
  setPage: (page) => set({ page }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  // Theme
  theme: load(STORAGE_THEME, "system") as Theme,
  accentColor: load(STORAGE_ACCENT, DEFAULT_ACCENT),
  accentSource: load(STORAGE_ACCENT_SRC, "system") as "system" | "manual",

  setTheme: (theme) => {
    set({ theme });
    save(STORAGE_THEME, theme);
    applyThemeTokens(get().accentColor, resolveMode(theme));
  },

  setAccentColor: (hex) => {
    set({ accentColor: hex, accentSource: "manual" });
    save(STORAGE_ACCENT, hex);
    save(STORAGE_ACCENT_SRC, "manual");
    applyThemeTokens(hex, resolveMode(get().theme));
  },

  setAccentSource: (source) => {
    set({ accentSource: source });
    save(STORAGE_ACCENT_SRC, source);
    if (source === "system") {
      get().fetchSystemAccent();
    }
  },

  // Language
  lang: ((v) => (v === "en" || v === "zh-CN" ? v : "zh-CN"))(load(STORAGE_LANG, "zh-CN")) as Lang,
  setLang: (lang) => {
    save(STORAGE_LANG, lang);
    set({ lang });
    // Persist for the Rust side (tray menu) too; best-effort.
    invoke("set_lang", { lang }).catch(() => {});
  },

  fetchSystemAccent: async () => {
    try {
      const hex = await invoke<string>("get_system_accent");
      if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
        set({ accentColor: hex });
        save(STORAGE_ACCENT, hex);
        applyThemeTokens(hex, resolveMode(get().theme));
      }
    } catch {
      // Fallback: keep current accent
    }
  },

  // Core status
  status: defaultStatus,
  loading: false,
  error: null,

  // Proxy groups
  groups: [],
  delays: {},
  testingGroup: null,
  ipNonce: 0,

  // Actions
  fetchStatus: async () => {
    try {
      const status = await invoke<CoreStatus>("get_status");
      set({ status });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  startCore: async () => {
    set({ loading: true, error: null });
    try {
      await invoke<ConfigInfo>("start_core");
      const status = await invoke<CoreStatus>("get_status");
      set({ status, loading: false });
      setTimeout(() => get().fetchGroups(), 1500);
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  stopCore: async () => {
    set({ loading: true, error: null });
    try {
      await invoke("stop_core");
      const status = await invoke<CoreStatus>("get_status");
      set({ status, loading: false, groups: [], delays: {} });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  restartCore: async () => {
    set({ loading: true, error: null });
    const win = getCurrentWindow();
    try {
      // Visible restart: clearly show the app "exit" (stop core + hide window),
      // a perceptible pause, then bring it back (start core + raise window) —
      // so the user sees two distinct phases rather than an instant swap.
      await invoke("stop_core");
      set({ status: await invoke<CoreStatus>("get_status"), groups: [], delays: {} });
      await new Promise((r) => setTimeout(r, 450));   // let "stopped" register
      await win.hide();                                // visible exit
      await new Promise((r) => setTimeout(r, 1500));   // perceptible gap
      await invoke<ConfigInfo>("start_core");
      const status = await invoke<CoreStatus>("get_status");
      set({ status, loading: false });
      try {
        await win.unminimize(); await win.show(); await win.setFocus();
        await win.setAlwaysOnTop(true); await win.setAlwaysOnTop(false);
      } catch { /* noop */ }
      setTimeout(() => get().fetchGroups(), 1500);
    } catch (e) {
      try { await win.show(); await win.setFocus(); } catch { /* noop */ }
      set({ error: String(e), loading: false });
    }
  },

  toggleProxy: async () => {
    set({ error: null });
    try {
      await invoke<boolean>("toggle_system_proxy");
      const status = await invoke<CoreStatus>("get_status");
      set({ status });
    } catch (e) {
      set({ error: String(e) });
    }
  },

  fetchGroups: async () => {
    try {
      const groups = await invoke<ProxyGroup[]>("get_proxy_groups");
      set({ groups });
    } catch {
      // Groups not ready yet
    }
  },

  switchProxy: async (group, node) => {
    try {
      await invoke("switch_proxy", { group, node });
      // Node changed → outbound route changed; re-resolve the outbound IP.
      set((s) => ({
        groups: s.groups.map((g) => g.name === group ? { ...g, now: node } : g),
        ipNonce: s.ipNonce + 1,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  testDelay: async (group) => {
    set({ testingGroup: group });
    try {
      const result = await invoke<DelayMap>("test_group_delay", { group });
      set((s) => ({ delays: { ...s.delays, [group]: result }, testingGroup: null }));
    } catch (e) {
      set({ error: String(e), testingGroup: null });
    }
  },

  bumpIp: () => set((s) => ({ ipNonce: s.ipNonce + 1 })),

  setStatus: (status) => set({ status }),
  setGroups: (groups) => set({ groups }),
  clearError: () => set({ error: null }),
}));

// ─── Initialization ─────────────────────────────────────────────────────────

if (typeof window !== "undefined") {
  // Listen for OS theme changes
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const { theme, accentColor } = useAppStore.getState();
      if (theme === "system") {
        applyThemeTokens(accentColor, resolveMode("system"));
      }
    });

  // Apply initial theme
  const { theme, accentColor, accentSource } = useAppStore.getState();

  // If following system accent, fetch it first
  if (accentSource === "system") {
    useAppStore.getState().fetchSystemAccent().then(() => {
      const current = useAppStore.getState().accentColor;
      applyThemeTokens(current, resolveMode(theme));
    });
  } else {
    applyThemeTokens(accentColor, resolveMode(theme));
  }
}
