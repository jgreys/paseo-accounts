import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { FAMILY_LABEL, familyLabel, type Family } from "../shared/model";
import { forkAgent } from "../shared/rpc";
import { describe, type AccountsStore } from "./store";
import { Button, useText } from "./ui";

/**
 * Confirmation for carrying a stopped agent's work on with another provider. It starts a new agent
 * that goes straight to work, so it's worth a second look; refusals (say, no mode as careful as this
 * agent's) show right here.
 */
export function forkPopover(store: AccountsStore, agentId: string, from: Family, to: string, toLabel?: string): ComponentType<PluginButtonContentProps> {
  return function ForkPopover({ theme, close }: PluginButtonContentProps) {
    const toast = useToast();
    const text = useText(theme);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const target = toLabel ?? familyLabel(to);

    const start = async () => {
      setBusy(true);
      setError(null);
      try {
        const fork = await store.rpc(forkAgent, { agentId, to });
        close();
        toast.show(`Continuing on ${target} in “${fork.title}”`, { variant: "success", durationMs: 5_000 });
      } catch (failure) {
        setError(describe(failure));
        setBusy(false);
      }
    };

    return (
      <View style={{ gap: 12, maxWidth: 360 }}>
        <Text style={text.heading}>Continue on {target}?</Text>
        <Text style={text.body}>
          Every {FAMILY_LABEL[from]} account is at its limit. This starts a new {target} agent in this workspace
          with the conversation so far. This agent stays as it is.
        </Text>
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Not now" tooltip="Close without starting a new agent" tooltipAlign="end" onPress={close} disabled={busy} />
          <Button
            theme={theme}
            tone="primary"
            icon="GitFork"
            label={`Continue on ${target}`}
            tooltip={`Start a new ${target} agent with this conversation so far`}
            tooltipAlign="end"
            busy={busy}
            onPress={() => void start()}
          />
        </View>
      </View>
    );
  };
}
