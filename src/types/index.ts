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
  lang: string;
  allow_multiple: boolean;
  close_to_tray: boolean;
  auto_start_core: boolean;
  exit_core_on_close: boolean;
  startup_delay_secs: number;
  disable_gpu_compositing: boolean;
  kernel_source: KernelSource;
}

export type KernelSource = "lurixo" | "sagernet" | "ref1nd";

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

export interface CoreInfo {
  present: boolean;
  source: KernelSource;
  version: string | null;
}

export interface CoreUpdateCheck {
  source: KernelSource;
  current_version: string | null;
  latest_version: string;
  update_available: boolean;
}

export interface StagedKernel {
  source: KernelSource;
  version: string;
}

export interface AppInfo {
  version: string;
  built_at: string;
}

export interface AppUpdateCheck {
  current_built_at: string;
  latest_version: string;
  latest_built_at: string;
  update_available: boolean;
  installed: boolean;
}

export interface StagedApp {
  version: string;
  built_at: string;
}

export type DelayMap = Record<string, number>;

export type Page = "dashboard" | "connections" | "logs" | "settings";

export type Theme = "light" | "dark" | "system";
