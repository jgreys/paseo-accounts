import { useHosts, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { zoneNote } from "../shared/format";
import { FAMILIES, FAMILY_HEADING, type AccountView, type Family } from "../shared/model";
import { AccountRow, SectionLabel } from "./account-row";
import { ActivityTab } from "./activity-tab";
import { AddAccountModal } from "./add-account";
import { AgentsTab } from "./agents-tab";
import { CapacityStrip } from "./capacity";
import { ProjectsTab } from "./projects-tab";
import { PreferenceSections } from "./settings-screen";
import { useStore, VISIBLE_POLL_MS, type AccountsStore } from "./store";
import { Button, Card, IconButton, Tabs, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];
type Tab = "accounts" | "agents" | "projects" | "activity" | "settings";

export function AccountsSurface(props: PluginSurfaceProps & { store: AccountsStore }) {
  const { theme, layout, host, store, navigation } = props;
  const { state, error } = useStore(store);
  const text = useText(theme);
  const colors = theme.colors;
  const [tab, setTab] = useState<Tab>("accounts");
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ family: Family; accountId?: string } | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshUsage = useCallback(async () => {
    setRefreshing(true);
    try {
      await store.refresh({ refreshUsage: true });
    } finally {
      setRefreshing(false);
    }
  }, [store]);
  // Each host runs its own copy of the plugin with its own accounts; Paseo's host picker switches.
  const hosts = useHosts();
  const multiHost = hosts.length > 1;
  const hostStatus = hosts.find((entry) => entry.serverId === host.id)?.status;
  const offline = hostStatus !== undefined && hostStatus !== "online";
  // Keep usage moving while the screen is open.
  useEffect(() => store.watch(VISIBLE_POLL_MS), [store]);

  // A provider shows once it's in use: it runs agents, or has an account you added. The rest are
  // one tap away in Add account, so they don't cost a section each.
  const inUse = FAMILIES.filter(
    (family) =>
      state?.agents.some((agent) => agent.family === family && agent.status !== "closed") ||
      state?.accounts.some((account) => account.family === family && account.kind !== "main"),
  );
  // Before anything is in use (a fresh install), show the logins that work.
  const families = inUse.length > 0 ? inUse : FAMILIES.filter((family) => state?.accounts.some((a) => a.family === family && a.status === "ready"));
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId, serverId: host.id }) : undefined;
  const liveAgents = state?.agents.filter((agent) => agent.status !== "closed") ?? [];
  const folderCount = state?.accounts.reduce((sum, account) => sum + account.folders.length, 0) ?? 0;
  const select = (accountId: string) => {
    setTab("accounts");
    setOpenId(accountId);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.compact ? 16 : 28,
          gap: layout.compact ? 16 : 20,
          maxWidth: 880,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flexShrink: 1, gap: 2 }}>
            <Text style={[text.title, { fontSize: 20, letterSpacing: -0.3 }]} accessibilityRole="header">
              Accounts
            </Text>
            {multiHost ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Icon name="Server" size={12} color={colors.foregroundMuted} />
                <Text style={text.small}>on {host.label}</Text>
              </View>
            ) : null}
          </View>
          {state ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <IconButton
                theme={theme}
                icon="RefreshCw"
                label="Refresh usage"
                tooltip="Refresh usage for every account now"
                tooltipPlacement="bottom"
                busy={refreshing}
                onPress={() => void refreshUsage()}
              />
              <Button theme={theme} size="small" tone="primary" icon="Plus" label="Add account" onPress={() => setChoosing(true)} />
            </View>
          ) : null}
        </View>

        {error && (offline || !state) ? (
          <Card theme={theme}>
            <Text style={text.danger}>
              {offline
                ? `Can't reach ${host.label}. Its accounts are saved on that machine${
                    state ? "; this is how they looked last." : " and show up here once it reconnects."
                  }`
                : `Could not reach the daemon: ${error}`}
            </Text>
            <Button theme={theme} label="Try again" icon="RefreshCw" onPress={() => void store.refresh()} />
          </Card>
        ) : null}

        {state?.warnings.map((warning) => (
          <View key={warning} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
            <Icon name="TriangleAlert" size={14} color={colors.statusWarning} />
            <Text style={[text.small, { flex: 1, color: colors.foreground }]}>{warning}</Text>
          </View>
        ))}

        {!state && !error ? <Text style={text.muted}>Loading accounts…</Text> : null}

        {state ? (
          <>
            <CapacityStrip theme={theme} state={state} families={families} compact={layout.compact} onSelect={select} />
            <Tabs
              theme={theme}
              value={tab}
              onChange={(id) => setTab(id as Tab)}
              fill
              tabs={[
                // Five tabs share a phone's width only without their counts.
                {
                  id: "accounts",
                  label: "Accounts",
                  count: layout.compact ? undefined : state.accounts.filter((account) => families.includes(account.family)).length,
                },
                { id: "agents", label: "Agents", count: layout.compact ? undefined : liveAgents.length },
                { id: "projects", label: "Projects", count: layout.compact ? undefined : folderCount },
                { id: "activity", label: "Activity" },
                { id: "settings", label: "Settings" },
              ]}
            />
            {tab === "accounts"
              ? families.map((family) => (
                  <ProviderGroup
                    key={family}
                    theme={theme}
                    family={family}
                    accounts={state.accounts.filter((account) => account.family === family)}
                    agents={liveAgents}
                    nextId={
                      state.accounts.filter((account) => account.family === family && account.status === "ready").length >= 2
                        ? (state.nextUp[family] ?? null)
                        : null
                    }
                    openId={openId}
                    compact={layout.compact}
                    store={store}
                    onToggle={(id) => setOpenId((current) => (current === id ? null : id))}
                    onSignIn={(account) => setAdding({ family, accountId: account.id })}
                    onOpenAgent={openAgent}
                    zone={zoneNote(state.hostTimeZone)}
                  />
                ))
              : null}
            {tab === "agents" ? <AgentsTab theme={theme} state={state} families={families} store={store} onOpenAgent={openAgent} /> : null}
            {tab === "projects" ? <ProjectsTab theme={theme} state={state} store={store} /> : null}
            {tab === "activity" ? <ActivityTab theme={theme} state={state} onOpenAgent={openAgent} /> : null}
            {tab === "settings" ? (
              <View style={{ gap: 16 }}>
                <PreferenceSections theme={theme} store={store} />
                {multiHost ? <HostScope theme={theme} label={host.label} /> : null}
              </View>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      {choosing && state ? (
        <ProviderPicker
          theme={theme}
          state={state}
          onClose={() => setChoosing(false)}
          onPick={(family) => {
            setChoosing(false);
            // A provider whose only login is signed out gets that login back rather than a second one.
            const accounts = state.accounts.filter((account) => account.family === family);
            const lone = accounts.length === 1 && accounts[0]?.status === "signed_out" ? accounts[0] : undefined;
            setAdding({ family, accountId: lone?.id });
          }}
        />
      ) : null}
      {adding ? (
        <AddAccountModal
          theme={theme}
          layout={layout}
          host={host}
          multiHost={multiHost}
          store={store}
          family={adding.family}
          accountId={adding.accountId}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </View>
  );
}

function ProviderGroup({
  theme,
  family,
  accounts,
  agents,
  nextId,
  openId,
  compact,
  store,
  onToggle,
  onSignIn,
  onOpenAgent,
  zone,
}: {
  theme: Theme;
  zone: string;
  family: Family;
  accounts: AccountView[];
  agents: NonNullable<ReturnType<typeof useStore>["state"]>["agents"];
  nextId: string | null;
  openId: string | null;
  compact: boolean;
  store: AccountsStore;
  onToggle(accountId: string): void;
  onSignIn(account: AccountView): void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const text = useText(theme);
  const colors = theme.colors;
  return (
    <View style={{ gap: 8 }}>
      <SectionLabel theme={theme} label={FAMILY_HEADING[family]} />
      {accounts.length === 0 ? (
        <Text style={text.muted}>No accounts yet.</Text>
      ) : (
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
          {accounts.map((account, index) => (
            <AccountRow
              key={account.id}
              theme={theme}
              account={account}
              agents={agents.filter((agent) => agent.accountId === account.id)}
              next={account.id === nextId}
              open={account.id === openId}
              compact={compact}
              divided={index > 0}
              store={store}
              onToggle={() => onToggle(account.id)}
              onSignIn={() => onSignIn(account)}
              onOpenAgent={onOpenAgent}
              zone={zone}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Add account starts here: every provider installed on this host, whether or not it's in use yet. */
function ProviderPicker({
  theme,
  state,
  onClose,
  onPick,
}: {
  theme: Theme;
  state: NonNullable<ReturnType<typeof useStore>["state"]>;
  onClose(): void;
  onPick(family: Family): void;
}) {
  const text = useText(theme);
  const colors = theme.colors;
  const families = state.installed.length > 0 ? state.installed : (["claude", "codex"] as Family[]);
  return (
    <Modal title="Add an account" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={{ gap: 6 }}>
          {families.map((family) => {
            const count = state.accounts.filter((account) => account.family === family && account.status !== "signed_out").length;
            return (
              <Pressable
                key={family}
                accessibilityRole="button"
                onPress={() => onPick(family)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 12,
                  paddingHorizontal: 14,
                  minHeight: 48,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: colors.border,
                  backgroundColor: colors.surface2,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <Text style={[text.strong, { flex: 1 }]}>{FAMILY_HEADING[family]}</Text>
                <Text style={text.small}>{count === 0 ? "none yet" : `${count} signed in`}</Text>
                <Icon name="ChevronRight" size={16} color={colors.foregroundMuted} />
              </Pressable>
            );
          })}
        </View>
        <Text style={text.small}>Other providers show up here once their CLI is installed on this host.</Text>
      </Modal.Content>
    </Modal>
  );
}

/** Says whose accounts these are when the app knows several hosts. */
function HostScope({ theme, label }: { theme: Theme; label: string }) {
  const text = useText(theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name="Server" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text.strong}>Accounts on {label}</Text>
        <Text style={text.small}>
          Only agents on this host use them. Each host keeps its own accounts and settings, so sign in on
          each host you use. Switch hosts with the host picker at the top; a host shows up there once this plugin
          is installed on it.
        </Text>
      </View>
    </View>
  );
}
