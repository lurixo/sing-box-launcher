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
  run_as_admin: boolean;
  log_level: string;
  log_persist: boolean;
  lang: string;
  allow_multiple: boolean;
  close_to_tray: boolean;
  auto_start_core: boolean;
  exit_core_on_close: boolean;
  startup_delay_secs: number;
  disable_gpu_compositing: boolean;
}

export interface LogLine {
  source: string;
  level: string;
  message: string;
  seq: number;
  ts: number;
}

export interface OutboundIpInfo {
  ip: string;
  country: string;
  asn: string;
}

export interface CoreMetrics {
  memory: number;
  goroutines: number;
  connections_in: number;
  connections_out: number;
  uplink: number;
  downlink: number;
  uplink_total: number;
  downlink_total: number;
}

export interface ClashModeInfo {
  modes: string[];
  current: string;
}

export interface ConnInfo {
  id: string;
  network: string;
  protocol: string;
  source: string;
  destination: string;
  domain: string;
  outbound: string;
  chain: string[];
  rule: string;
  upload: number;
  download: number;
  created_at: number;
}

export interface ConfigEntry {
  name: string;
  active: boolean;
}

export interface CheckResult {
  ok: boolean;
  message: string;
  content: string;
}

export interface CoreBuildInfo {
  version: string;
  windows_asset: string;
  windows_sha256: string;
  built_at: string;
  run_id: string;
}

export interface CoreInfo {
  present: boolean;
  build: CoreBuildInfo | null;
}

export interface CoreUpdateCheck {
  current: CoreBuildInfo | null;
  latest: CoreBuildInfo;
  update_available: boolean;
}

export type DelayMap = Record<string, number>;

export type Page = "dashboard" | "connections" | "logs" | "settings";

export type Theme = "light" | "dark" | "system";
