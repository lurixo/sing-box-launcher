export interface ConfigInfo {
  proxy_server: string;
  api_address: string;
  api_secret: string;
}

export interface CoreStatus {
  running: boolean;
  proxy_server: string;
  api_address: string;
  uptime_secs: number;
  proxy_enabled: boolean;
}

export interface ProxyGroup {
  name: string;
  type: string;
  now: string;
  all: string[];
}

export interface AppSettings {
  silent_start: boolean;
  active_config: string;
}

export interface ConfigEntry {
  name: string;
  active: boolean;
}

export type DelayMap = Record<string, number>;

export type Page = "dashboard" | "proxies" | "settings";

export type Theme = "light" | "dark" | "system";
