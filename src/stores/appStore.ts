import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type {
  CoreStatus,
  ConfigInfo,
  ProxyGroup,
  DelayMap,
  Page,
  Theme,
} from "@/types";

interface AppState {
  // Navigation
  page: Page;
  sidebarCollapsed: boolean;
  setPage: (page: Page) => void;
  toggleSidebar: () => void;

  // Theme
  theme: Theme;
  setTheme: (theme: Theme) => void;

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

export const useAppStore = create<AppState>((set, get) => ({
  // Navigation
  page: "dashboard",
  sidebarCollapsed: false,
  setPage: (page) => set({ page }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

  // Theme
  theme: "system",
  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme);
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
      // Groups will arrive via event, but also fetch directly
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
      set({
        status,
        loading: false,
        groups: [],
        selectedGroup: null,
        delays: {},
      });
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
    } catch (e) {
      // Groups not ready yet, ignore
    }
  },

  switchProxy: async (group, node) => {
    try {
      await invoke("switch_proxy", { group, node });
      // Update local state immediately for responsiveness
      set((s) => ({
        groups: s.groups.map((g) =>
          g.name === group ? { ...g, now: node } : g
        ),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  testDelay: async (group) => {
    set({ testingGroup: group });
    try {
      const result = await invoke<DelayMap>("test_group_delay", { group });
      set((s) => ({
        delays: { ...s.delays, [group]: result },
        testingGroup: null,
      }));
    } catch (e) {
      set({ error: String(e), testingGroup: null });
    }
  },

  selectGroup: (group) => set({ selectedGroup: group }),

  // Internal
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

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.classList.toggle("dark", prefersDark);
  } else {
    root.classList.toggle("dark", theme === "dark");
  }
}

// Listen for system theme changes
if (typeof window !== "undefined") {
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      const theme = useAppStore.getState().theme;
      if (theme === "system") {
        applyTheme("system");
      }
    });

  // Apply initial theme
  applyTheme("system");
}
