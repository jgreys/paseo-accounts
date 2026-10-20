import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { folderName, roomLeft, roomTone, shortLabel } from "../shared/format";
import { FAMILY_HEADING, type AccountView, type AgentRoute, type Family, type StateView } from "../shared/model";
import { setAgentAccount } from "../shared/rpc";
import { SectionLabel } from "./account-row";
import { describeReopen } from "./reopen-text";
import { describe, type AccountsStore } from "./store";
import { Dot, toneColor, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/** Every live agent with the account it runs on, and a quick way to move it. */
export function AgentsTab({
  theme,
  state,
  families,
  store,
  onOpenAgent,
}: {
  theme: Theme;
  state: StateView;
  families: readonly Family[];
  store: AccountsStore;
  onOpenAgent?: (agentId: string) => void;
}) {
  const text = useText(theme);
  const colors = theme.colors;
  const [moving, setMoving] = useState<AgentRoute | null>(null);
  const live = state.agents.filter((agent) => agent.status !== "closed");
  if (live.length === 0) {
    return <Text style={text.muted}>No agents are running on these accounts right now.</Text>;
  }
  return (
    <View style={{ gap: 20 }}>
      {families.map((family) => {
        const agents = live.filter((agent) => agent.family === family);
        if (agents.length === 0) return null;
        return (
          <View key={family} style={{ gap: 8 }}>
            <SectionLabel theme={theme} label={`${FAMILY_HEADING[family]} · ${agents.length}`} />
            <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
              {agents.map((agent, index) => (
                <AgentRow
                  key={agent.agentId}
                  theme={theme}
                  agent={agent}
                  account={state.accounts.find((account) => account.id === agent.accountId)}
                  pending={state.accounts.find((account) => account.id === agent.pendingAccountId)}
                  divided={index > 0}
                  onOpen={onOpenAgent ? () => onOpenAgent(agent.agentId) : undefined}
                  onMove={() => setMoving(agent)}
                />
              ))}
            </View>
          </View>
        );
      })}
      {moving ? <MoveModal theme={theme} agent={moving} state={state} store={store} onClose={() => setMoving(null)} /> : null}
    </View>
  );
}

function AgentRow({
  theme,
  agent,
  account,
  pending,
  divided,
  onOpen,
  onMove,
}: {
  theme: Theme;
  agent: AgentRoute;
  account: AccountView | undefined;
  pending: AccountView | undefined;
  divided: boolean;
  onOpen?: () => void;
  onMove(): void;
}) {
  const text = useText(theme);
  const colors = theme.colors;
  const running = agent.status === "running";
  return (
    <View
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: divided ? 1 : 0, borderTopColor: colors.border }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${agent.title ?? "agent"}`}
        disabled={!onOpen}
        onPress={onOpen}
        style={({ pressed }) => ({ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 10, opacity: pressed ? 0.6 : 1 })}
      >
        <Dot color={running ? colors.accent : agent.status === "error" ? colors.statusDanger : colors.border} />
        <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
          <Text style={[text.body, { fontSize: 13, fontWeight: "500" }]} numberOfLines={1}>
            {agent.title ?? "Untitled agent"}
          </Text>
          <Text style={[text.small, { fontSize: 11 }]} numberOfLines={1}>
            {[agent.cwd ? folderName(agent.cwd) : null, running ? "working" : agent.status === "error" ? "stopped with an error" : "idle", pending ? `still on ${pending.label} until it restarts` : null]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Account: ${account?.label ?? "none"}. Change`}
        onPress={onMove}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          maxWidth: 160,
          paddingHorizontal: 10,
          minHeight: 30,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface2,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {account ? <Dot color={toneColor(theme, roomTone(account))} size={6} /> : null}
        <Text style={{ flexShrink: 1, color: colors.foreground, fontSize: 12, fontWeight: "600" }} numberOfLines={1}>
          {account ? shortLabel(account, 14) : "Choose"}
        </Text>
        {agent.pinned ? <Icon name="Pin" size={11} color={colors.foregroundMuted} /> : null}
        <Icon name="ChevronsUpDown" size={12} color={colors.foregroundMuted} />
      </Pressable>
    </View>
  );
}

function MoveModal({ theme, agent, state, store, onClose }: { theme: Theme; agent: AgentRoute; state: StateView; store: AccountsStore; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const colors = theme.colors;
  const [saving, setSaving] = useState<string | null>(null);
  const accounts = state.accounts.filter((account) => account.family === agent.family);
  const choose = async (accountId: string | null) => {
    setSaving(accountId ?? "default");
    try {
      const result = await store.rpc(setAgentAccount, { agentId: agent.agentId, accountId });
      const target = accountId ? accounts.find((account) => account.id === accountId)?.label : "the default";
      toast.show(describeReopen(`Moved to ${target}`, result), { variant: "success", durationMs: 5_000 });
      onClose();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setSaving(null);
    }
  };
  const option = (key: string, label: string, detail: string, selected: boolean, onPress: () => void, color?: string) => (
    <Pressable
      key={key}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      disabled={saving !== null}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        paddingHorizontal: 12,
        minHeight: 44,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: selected ? colors.accent : colors.border,
        backgroundColor: colors.surface2,
        opacity: pressed || (saving !== null && saving !== key) ? 0.6 : 1,
      })}
    >
      {color ? <Dot color={color} /> : <Icon name="Star" size={12} color={colors.foregroundMuted} />}
      <Text style={[text.strong, { flex: 1, fontSize: 13 }]} numberOfLines={1}>
        {label}
      </Text>
      <Text style={[text.small, { fontVariant: ["tabular-nums"] }]}>{saving === key ? "Moving…" : detail}</Text>
    </Pressable>
  );
  return (
    <Modal title={`Move “${agent.title ?? "agent"}”`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        {!agent.movable ? (
          <Text style={text.muted}>This ChatGPT conversation can't change accounts in place; picking one continues it in a new agent.</Text>
        ) : null}
        <View style={{ gap: 6 }}>
          {option("default", "Follow the default", "", !agent.pinned, () => void choose(null))}
          {accounts.map((account) => {
            const left = roomLeft(account);
            const detail = account.status === "ready" ? (left === null ? "" : `${Math.round(100 - left)}% used`) : account.status.replace("_", " ");
            return option(account.id, account.label, detail, agent.pinned && agent.accountId === account.id, () => void choose(account.id), toneColor(theme, roomTone(account)));
          })}
        </View>
      </Modal.Content>
    </Modal>
  );
}
