export type RunningMode = "Service" | "Sidecar" | "NotRunning";

export type ClashInfo = {
  isRunning: boolean;
  runningMode: string;
  mixedPort?: number | null;
  httpPort?: number | null;
  socksPort?: number | null;
  controller?: string | null;
  secret?: string | null;
};

export type SysproxyConfig = {
  enable: boolean;
  host: string;
  port: number;
  bypass: string;
};

export type PrfType = "remote" | "local";

export type PrfItem = {
  uid: string;
  type: PrfType;
  name: string;
  desc?: string;
  file?: string;
  url?: string;
  interval?: number;
  updated?: number;
  selected: boolean;
};

export type ProxyGroupInfo = {
  name: string;
  type: string;
  proxies: string[];
  now?: string | null;
};

export type DelayResult = {
  url: string;
  delay: number | null;
  error?: string | null;
};

export type ClashTab = "proxy" | "profile" | "settings";