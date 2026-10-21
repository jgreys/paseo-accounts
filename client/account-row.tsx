import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { accountSubtitle, folderName, formatAge, formatPlan, formatWhen, nextRefill, roomLeft, roomTone } from "../shared/format";
import type { AccountView, AgentRoute } from "../shared/model";
import {
  clearAccountLimit,
  removeAccount,
  renameAccount,
  signOutAccount,
  setAccountEnabled,
  setAccountFolders,
  setAccountPriority,
  setDefaultAccount,
} from "../shared/rpc";
import { describeReopen } from "./reopen-text";
import { ResetConfirm, redeemToast, resetBadge } from "./reset-confirm";
import { describe, type AccountsStore } from "./store";
import { Badge, Button, Dot, Meter, Tabs, toneColor, UsageBar, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];
type Busy = "default" | "remove" | "signout" | "clear" | "toggle" | null;

/**
 * One account as a compact row: who it is, how much is used and when it refills. Opening it
 * shows every usage window, the agents on it, its project folders and every action, labelled.
 */
export function AccountRow({
  theme,
  account,
  agents,
  next,
  open,
  compact,
  divided,
  store,
  onToggle,
  onSignIn,
  onOpenAgent,
  zone = "",
}: {
  theme: Theme;
  account: AccountView;
  agents: AgentRoute[];
  next: boolean;
  /** Names the host's time zone after forecast times when the viewer's differs, e.g. " (Seoul time)". */
  zone?: string;
  open: boolean;
  compact: boolean;
  divided: boolean;
  store: AccountsStore;
  onToggle(): void;
  onSignIn(): void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const text = useText(theme);
  const colors = theme.colors;
  const left = roomLeft(account);
  const tone = roomTone(account);
  const refill = nextRefill(account);
  const plan = formatPlan(account.plan);
  const subtitle = [accountSubtitle(account), plan].filter(Boolean).join(" · ");
  const status =
    account.status === "signed_out"
      ? "Signed out"
      : account.status === "disabled"
        ? "Disabled"
        : account.status === "limited"
          ? "Limit reached"
          : left === null
            ? "Usage not reported"
            : `${Math.round(100 - left)}% used`;

  const meter = (
    <View style={{ width: compact ? undefined : 220, gap: 5 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 0,
            fontSize: 13,
            fontWeight: "600",
            fontVariant: ["tabular-nums"],
            color: tone === "unknown" || tone === "off" ? colors.foregroundMuted : toneColor(theme, tone),
          }}
        >
          {status}
        </Text>
        {refill ? (
          <Text
            style={[text.small, { flexShrink: 1, fontSize: 11, fontVariant: ["tabular-nums"], textAlign: "right" }]}
            numberOfLines={1}
          >
            {account.status === "limited" ? "back" : "refills"} {refill}
          </Text>
        ) : null}
      </View>
      {account.status === "signed_out" || account.status === "disabled" ? null : (
        <Meter theme={theme} used={left === null ? null : 100 - left} tone={tone} />
      )}
    </View>
  );

  return (
    <View style={{ borderTopWidth: divided ? 1 : 0, borderTopColor: colors.border }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${account.label}, ${status}`}
        onPress={onToggle}
        style={({ pressed }) => ({ paddingHorizontal: 14, paddingVertical: 12, gap: 10, opacity: pressed ? 0.75 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <Initial theme={theme} label={account.label} ring={toneColor(theme, tone)} dim={tone === "off"} />
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={[text.strong, { flexShrink: 1 }]} numberOfLines={1}>
                {account.label}
              </Text>
              {next ? <Badge theme={theme} label="Next up" tone="accent" /> : null}
              {account.isDefault ? <Badge theme={theme} label="Default" /> : null}
              {account.priority === "first" ? <Badge theme={theme} label="Used first" /> : null}
              {account.priority === "last" ? <Badge theme={theme} label="Overflow" /> : null}
              {account.forecast?.runsOutAt && account.status === "ready" ? (
                <Badge
                  theme={theme}
                  label={`${account.forecast.windowLabel} runs out ${account.forecast.runsOutText ?? formatWhen(account.forecast.runsOutAt)}${zone}`}
                  tone="warning"
                />
              ) : null}
              {account.folders.map((folder) => (
                <Badge key={folder} theme={theme} label={folderName(folder)} />
              ))}
            </View>
            <Text style={text.small} numberOfLines={1}>
              {[subtitle, agents.length ? `${agents.length} agent${agents.length === 1 ? "" : "s"}` : null]
                .filter(Boolean)
                .join(" · ") || " "}
            </Text>
          </View>
          {compact ? null : meter}
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={16} color={colors.foregroundMuted} />
        </View>
        {compact ? meter : null}
      </Pressable>
      {open ? (
        <AccountDetail
          zone={zone}
          theme={theme}
          account={account}
          agents={agents}
          store={store}
          indent={compact ? 14 : 56}
          onSignIn={onSignIn}
          onOpenAgent={onOpenAgent}
        />
      ) : null}
    </View>
  );
}

function AccountDetail({
  theme,
  account,
  agents,
  store,
  indent,
  onSignIn,
  onOpenAgent,
  zone,
}: {
  theme: Theme;
  account: AccountView;
  agents: AgentRoute[];
  store: AccountsStore;
  /** Lines the details up under the account's name on wide screens. */
  indent: number;
  zone: string;
  onSignIn(): void;
  onOpenAgent?: (agentId: string) => void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const colors = theme.colors;
  const [busy, setBusy] = useState<Busy>(null);
  const [renaming, setRenaming] = useState(false);
  const [editingFolders, setEditingFolders] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const resets = account.usage?.resets ?? null;
  const windows = account.usage?.windows ?? [];
  const signedOut = account.status === "signed_out";
  const disabled = account.status === "disabled";

  const run = useCallback(
    async (kind: Exclude<Busy, null>, action: () => Promise<string>) => {
      setBusy(kind);
      try {
        toast.show(await action(), { variant: "success", durationMs: 5_000 });
        await store.refresh();
      } catch (error) {
        toast.error(describe(error));
      } finally {
        setBusy(null);
      }
    },
    [store, toast],
  );

  const toggle = () =>
    run("toggle", async () => {
      const enabling = disabled;
      const result = await store.rpc(setAccountEnabled, { accountId: account.id, enabled: enabling });
      const stayed =
        result.stayed > 0 ? ` · ${result.stayed} conversation${result.stayed === 1 ? " stays" : "s stay"} on it` : "";
      return `${describeReopen(`${account.label} is ${enabling ? "enabled" : "disabled"}`, result)}${stayed}`;
    });
  const makeDefault = () =>
    run("default", async () =>
      describeReopen(`${account.label} is now the default`, await store.rpc(setDefaultAccount, { accountId: account.id })),
    );
  const markAvailable = () =>
    run("clear", async () => {
      await store.rpc(clearAccountLimit, { accountId: account.id });
      return `${account.label} is available again`;
    });
  // Only these CLIs can sign an account out on its own; the others' sign-in goes with the account.
  const canSignOut = (account.family === "claude" || account.family === "codex") && !signedOut;
  const moved = (done: string, count: number) => (count > 0 ? `${done}; ${count} agent(s) moved` : done);
  const remove = () =>
    run("remove", async () => {
      const result = await store.rpc(removeAccount, { accountId: account.id });
      setConfirmRemove(false);
      return moved(`Removed ${account.label}`, result.movedAgents);
    });
  const signOut = () =>
    run("signout", async () => {
      const result = await store.rpc(signOutAccount, { accountId: account.id });
      setConfirmSignOut(false);
      return moved(`Signed out ${account.label}`, result.movedAgents);
    });

  return (
    <View style={{ paddingLeft: indent, paddingRight: 14, paddingBottom: 14, paddingTop: 2, gap: 16 }}>
      {signedOut ? (
        <Text style={text.muted}>This account is signed out. Sign in again to use it.</Text>
      ) : windows.length > 0 ? (
        <View style={{ gap: 10 }}>
          {windows.map((limit) => (
            <UsageBar key={limit.id} theme={theme} limit={limit} />
          ))}
          {account.usage ? (
            <Text style={[text.small, { fontSize: 11 }]}>
              Updated {formatAge(account.usage.fetchedAt)}
              {account.usage.error ? ` · ${account.usage.error}` : ""}
            </Text>
          ) : null}
        </View>
      ) : (
        <Text style={text.muted}>{account.usage?.error ?? "Usage shows up after this account is next used."}</Text>
      )}
      {resets?.blockedReason ? <Text style={text.small}>{resets.blockedReason}</Text> : null}

      {account.forecast || account.trend.some((point) => point !== null) ? <Trend theme={theme} account={account} zone={zone} /> : null}

      {agents.length > 0 ? (
        <View style={{ gap: 6 }}>
          <SectionLabel theme={theme} label="Agents" />
          {agents.slice(0, 6).map((agent) => (
            <Pressable
              key={agent.agentId}
              accessibilityRole="button"
              disabled={!onOpenAgent}
              onPress={() => onOpenAgent?.(agent.agentId)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                paddingVertical: 3,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Dot
                color={
                  agent.status === "running" ? colors.accent : agent.status === "error" ? colors.statusDanger : colors.border
                }
                size={6}
              />
              <Text style={[text.body, { flex: 1, fontSize: 13 }]} numberOfLines={1}>
                {agent.title ?? "Untitled agent"}
              </Text>
              {agent.cwd ? <Text style={[text.small, { fontSize: 11 }]}>{folderName(agent.cwd)}</Text> : null}
            </Pressable>
          ))}
          {agents.length > 6 ? (
            <Text style={[text.small, { fontSize: 11 }]}>and {agents.length - 6} more in the Agents tab</Text>
          ) : null}
        </View>
      ) : null}

      {!signedOut ? (
        <View style={{ gap: 6 }}>
          <SectionLabel theme={theme} label="Priority" />
          <Tabs
            theme={theme}
            value={account.priority}
            onChange={(priority) =>
              void store
                .rpc(setAccountPriority, { accountId: account.id, priority: priority as AccountView["priority"] })
                .catch((error: unknown) => toast.error(describe(error)))
            }
            tabs={[
              { id: "first", label: "Use first" },
              { id: "normal", label: "Normal" },
              { id: "last", label: "Only when others are out" },
            ]}
          />
        </View>
      ) : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {signedOut ? <Button theme={theme} size="small" tone="primary" icon="LogIn" label="Sign in" onPress={onSignIn} /> : null}
        {account.status === "limited" ? (
          <Button
            theme={theme}
            size="small"
            icon="CircleCheck"
            label="Mark available"
            tooltip="It has room again, e.g. after upgrading"
            busy={busy === "clear"}
            onPress={() => void markAvailable()}
          />
        ) : null}
        {resets && !signedOut ? (
          <Button
            theme={theme}
            size="small"
            icon="TimerReset"
            label={`Use reset · ${resetBadge(resets)}`}
            disabled={!resets.usableNow}
            onPress={() => setConfirmReset(true)}
          />
        ) : null}
        {!account.isDefault && !signedOut && !disabled ? (
          <Button
            theme={theme}
            size="small"
            icon="Star"
            label="Make default"
            busy={busy === "default"}
            onPress={() => void makeDefault()}
          />
        ) : null}
        <Button theme={theme} size="small" icon="Folder" label="Project folders" onPress={() => setEditingFolders(true)} />
        <Button
          theme={theme}
          size="small"
          icon={disabled ? "CirclePlay" : "CirclePause"}
          label={disabled ? "Enable" : "Disable for now"}
          busy={busy === "toggle"}
          onPress={() => void toggle()}
        />
        <Button theme={theme} size="small" icon="Pencil" label="Rename" onPress={() => setRenaming(true)} />
        {canSignOut ? (
          <Button theme={theme} size="small" icon="LogOut" label="Sign out" busy={busy === "signout"} onPress={() => setConfirmSignOut(true)} />
        ) : null}
        {account.kind !== "main" ? (
          <Button
            theme={theme}
            size="small"
            tone="danger"
            icon="Trash2"
            label="Remove"
            busy={busy === "remove"}
            onPress={() => setConfirmRemove(true)}
          />
        ) : null}
      </View>

      <Modal title="Use a banked reset?" open={confirmReset} onOpenChange={setConfirmReset}>
        <Modal.Content>
          <ResetConfirm
            theme={theme}
            store={store}
            account={account}
            onCancel={() => setConfirmReset(false)}
            onFinished={(result) => {
              setConfirmReset(false);
              const { message, variant } = redeemToast(account.label, result);
              if (variant === "error") toast.error(message);
              else toast.show(message, { variant, durationMs: 5_000 });
            }}
          />
        </Modal.Content>
      </Modal>
      {renaming ? <RenameModal theme={theme} account={account} store={store} onClose={() => setRenaming(false)} /> : null}
      {editingFolders ? (
        <FoldersModal theme={theme} account={account} store={store} onClose={() => setEditingFolders(false)} />
      ) : null}
      <Modal title={`Sign out ${account.label}?`} open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <Modal.Content>
          <Text style={text.body}>
            {account.kind === "main"
              ? `This signs the ${account.family === "codex" ? "codex" : "claude"} CLI login out on this machine, for the terminal too. Agents using it move to your other accounts. Sign it in again from here at any time, with this account or another one.`
              : "This signs the account out on this machine but keeps it in the list, with its settings and project folders. Agents using it move to your other accounts. Sign it in again from here at any time."}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" onPress={() => setConfirmSignOut(false)} />
            <Button theme={theme} tone="danger" icon="LogOut" label="Sign out" busy={busy === "signout"} onPress={() => void signOut()} />
          </View>
        </Modal.Content>
      </Modal>
      <Modal title={`Remove ${account.label}?`} open={confirmRemove} onOpenChange={setConfirmRemove}>
        <Modal.Content>
          <Text style={text.body}>
            {account.family !== "codex"
              ? "This signs the account out on this machine and deletes its saved login. Agents using it move to the default account; their conversations are kept."
              : "This signs the account out on this machine and deletes its saved login. New agents use the default account. Existing ChatGPT conversations on it can't move, so start new agents for them."}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" onPress={() => setConfirmRemove(false)} />
            <Button
              theme={theme}
              tone="danger"
              icon="Trash2"
              label="Remove"
              busy={busy === "remove"}
              onPress={() => void remove()}
            />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

/** The last week of usage as small bars, with what the recent pace means for that limit. */
function Trend({ theme, account, zone }: { theme: Theme; account: AccountView; zone: string }) {
  const text = useText(theme);
  const colors = theme.colors;
  const forecast = account.forecast;
  const line = !forecast
    ? null
    : forecast.runsOutAt
      ? `At this pace, ${forecast.windowLabel.toLowerCase()} runs out ${forecast.runsOutText ?? formatWhen(forecast.runsOutAt)}${
          forecast.resetsAt ? `, before it resets ${forecast.resetsText ?? formatWhen(forecast.resetsAt)}` : ""
        }${zone}.`
      : `At this pace, ${forecast.windowLabel.toLowerCase()} lasts until it resets${forecast.resetsAt ? ` ${forecast.resetsText ?? formatWhen(forecast.resetsAt)}` : ""}${zone}.`;
  return (
    <View style={{ gap: 6 }}>
      <SectionLabel theme={theme} label={account.trend.some((point) => point !== null) ? "Last 7 days" : "Forecast"} />
      {account.trend.some((point) => point !== null) ? (
        <View
          accessibilityLabel="Usage over the last week"
          style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: 36 }}
        >
          {account.trend.map((point, index) => (
            <View
              key={index}
              style={{
                flex: 1,
                height: point === null ? 2 : Math.max(2, (Math.min(100, point) / 100) * 36),
                borderRadius: 1.5,
                backgroundColor:
                  point === null
                    ? colors.surface2
                    : point >= 95
                      ? colors.statusDanger
                      : point > 70
                        ? colors.statusWarning
                        : colors.foregroundMuted,
                opacity: point === null ? 1 : 0.85,
              }}
            />
          ))}
        </View>
      ) : null}
      {line ? <Text style={[text.small, forecast?.runsOutAt ? { color: colors.statusWarning } : null]}>{line}</Text> : null}
    </View>
  );
}

export function SectionLabel({ theme, label }: { theme: Theme; label: string }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {label}
    </Text>
  );
}

/** The account's initial, ringed in its room colour so the list scans by status. */
function Initial({ theme, label, ring, dim }: { theme: Theme; label: string; ring: string; dim: boolean }) {
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <View
      style={{
        width: 30,
        height: 30,
        borderRadius: 15,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surface2,
        borderWidth: 1.5,
        borderColor: ring,
        opacity: dim ? 0.5 : 1,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>{initial}</Text>
    </View>
  );
}

export function RenameModal({
  theme,
  account,
  store,
  onClose,
}: {
  theme: Theme;
  account: AccountView;
  store: AccountsStore;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [label, setLabel] = useState(account.label);
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    const next = label.trim();
    if (!next) return;
    setSaving(true);
    try {
      await store.rpc(renameAccount, { accountId: account.id, label: next });
      await store.refresh();
      onClose();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setSaving(false);
    }
  }, [label, account.id, store, onClose, toast]);
  const inputStyle = useMemo(
    () => ({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
    }),
    [theme],
  );
  return (
    <Modal title="Rename account" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>A short name you'll recognise in the composer, like "Work" or "Personal".</Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          autoFocus
          maxLength={40}
          placeholder="Account name"
          placeholderTextColor={theme.colors.foregroundMuted}
          onSubmitEditing={() => void save()}
          style={inputStyle}
          accessibilityLabel="Account name"
        />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current name" tooltipAlign="end" onPress={onClose} />
          <Button
            theme={theme}
            tone="primary"
            label="Save"
            tooltip="Save the new name"
            tooltipAlign="end"
            busy={saving}
            disabled={!label.trim()}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

export function FoldersModal({
  theme,
  account,
  store,
  onClose,
}: {
  theme: Theme;
  account: AccountView;
  store: AccountsStore;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [value, setValue] = useState(account.folders.join("\n"));
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    const paths = value
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    setSaving(true);
    try {
      const result = await store.rpc(setAccountFolders, { accountId: account.id, paths });
      toast.show(
        describeReopen(
          paths.length ? `${account.label} now serves ${paths.length} folder(s)` : `${account.label} serves every folder`,
          result,
        ),
        {
          variant: "success",
        },
      );
      await store.refresh();
      onClose();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setSaving(false);
    }
  }, [value, account, store, onClose, toast]);
  const inputStyle = useMemo(
    () => ({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      minHeight: 96,
      textAlignVertical: "top" as const,
    }),
    [theme],
  );
  return (
    <Modal title={`Project folders for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>
          One folder per line, like ~/code/web-app. Agents working in these folders (or below) use this account, and other
          agents never move onto it. Leave empty to share it with every folder.
        </Text>
        <TextInput
          value={value}
          onChangeText={setValue}
          autoFocus
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="~/projects/my-project"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={inputStyle}
          accessibilityLabel="Project folders"
        />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current folders" tooltipAlign="end" onPress={onClose} />
          <Button
            theme={theme}
            tone="primary"
            label="Save"
            tooltip="Save the folders; agents in them move to this account"
            tooltipAlign="end"
            busy={saving}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
