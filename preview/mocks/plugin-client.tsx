import { useState } from "react";

export type PluginSurfaceProps = Record<string, any>;
export type PluginHostProps = Record<string, any>;
export type PluginClientContext = Record<string, any>;
export type PluginButtonContentProps = Record<string, any>;
export type PluginButtonMenuEntry = Record<string, any>;

export function useHosts() {
  return [{ serverId: "my-mac", label: "my-mac", status: "online" }];
}

export function useRpc(_contract: unknown) {
  return async (_input: unknown) => ({ ok: true });
}

const values = {
  switchAt: 92,
  alertUrl: "",
  autoSwitch: true,
  autoContinue: true,
  balanceNewAgents: true,
  autoRedeem: false,
  forkOtherProvider: false,
  showComposerPill: true,
  continuePrompt: "",
};

export function useSettings(_definition: unknown) {
  const [current, setCurrent] = useState(values);
  return {
    status: "ready" as const,
    values: current,
    revision: "1",
    saving: false,
    save: async (next: typeof values) => setCurrent(next),
  };
}

export async function openExternalUrl(url: string) {
  window.open(url, "_blank");
}
