import { Channel } from "@tauri-apps/api/core";
import { invokeIpc } from "../lib/ipc";

export interface InterfaceInfo {
  name: string;
  ipv4: string;
  suggestedCidr: string;
  isVirtual: boolean;
}

export interface DiscoveryCandidate {
  ip: string;
  port: number;
  /** open（端口开放未确认）| ssh（已确认）| mdns */
  kind: string;
  banner: string | null;
  hostname: string | null;
  source: string;
}

export const discoveryApi = {
  async interfaces(): Promise<InterfaceInfo[]> {
    return invokeIpc<InterfaceInfo[]>("discovery_interfaces");
  },

  async defaultRoute(): Promise<string | null> {
    const info = await invokeIpc<{ localIp: string | null }>("discovery_default_route");
    return info.localIp;
  },

  async scan(
    cidr: string,
    ports: number[],
    onResult: (c: DiscoveryCandidate) => void,
  ): Promise<number> {
    const channel = new Channel<DiscoveryCandidate>(onResult);
    return invokeIpc<number>("discovery_scan", { cidr, ports, onResult: channel });
  },

  async cancel(): Promise<void> {
    await invokeIpc("discovery_cancel");
  },

  async mdnsStart(onResult: (c: DiscoveryCandidate) => void): Promise<void> {
    const channel = new Channel<DiscoveryCandidate>(onResult);
    await invokeIpc("discovery_mdns_start", { onResult: channel });
  },

  async mdnsCancel(): Promise<void> {
    await invokeIpc("discovery_mdns_cancel");
  },
};
