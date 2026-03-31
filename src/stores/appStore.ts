import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { applyThemeTokens, type ThemeMode } from "../lib/colorEngine";
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

  // Core status
  status: CoreStatus;
  loading: boolean;
  error: string | null;

  // Proxy groups
  groups: ProxyGroup[];
  selectedGroup: string | null;
  delays: Record<string, DelayMap>;
  testingGroup: string | null;

  // Actions
  fetchStatus: () => Promise<void>;
  startCore: () => Promise<void>;
  stopCore: () => Promise<void>;
  restartCore: () => Promise<void>;
  toggleProxy: () => Promise<void>;
  fetchGroups: () => Promise<void>;
  switchProxy: (group: string, node: string) => Promise<void>;
  testDelay: (group: string) => Promise<void>;
  selectGroup: (group: string) => void;

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
  selectedGroup: null,
  delays: {},
  testingGroup: null,

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
      set({ status, loading: false, groups: [], selectedGroup: null, delays: {} });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  restartCore: async () => {
    set({ loading: true, error: null });
    try {
      await invoke<ConfigInfo>("restart_core");
      const status = await invoke<CoreStatus>("get_status");
      set({ status, loading: false, delays: {} });
      setTimeout(() => get().fetchGroups(), 1500);
    } catch (e) {
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
      const selectedGroup =
        get().selectedGroup && groups.find((g) => g.name === get().selectedGroup)
          ? get().selectedGroup
          : groups[0]?.name ?? null;
      set({ groups, selectedGroup });
    } catch {
      // Groups not ready yet
    }
  },

  switchProxy: async (group, node) => {
    try {
      await invoke("switch_proxy", { group, node });
      set((s) => ({
        groups: s.groups.map((g) => g.name === group ? { ...g, now: node } : g),
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

  selectGroup: (group) => set({ selectedGroup: group }),

  setStatus: (status) => set({ status }),
  setGroups: (groups) => {
    const selectedGroup =
      get().selectedGroup && groups.find((g) => g.name === get().selectedGroup)
        ? get().selectedGroup
        : groups[0]?.name ?? null;
    set({ groups, selectedGroup });
  },
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
