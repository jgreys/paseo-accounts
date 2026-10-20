import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { folderName, roomTone } from "../shared/format";
import { FAMILY_LABEL, type AccountView, type StateView } from "../shared/model";
import { setAccountFolders } from "../shared/rpc";
import { describeReopen } from "./reopen-text";
import { describe, type AccountsStore } from "./store";
import { Button, Dot, IconButton, toneColor, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/** Folder rules in one place: agents working in a folder use its account, and no other agent does. */
export function ProjectsTab({ theme, state, store }: { theme: Theme; state: StateView; store: AccountsStore }) {
  const text = useText(theme);
  const toast = useToast();
  const colors = theme.colors;
  const [adding, setAdding] = useState(false);
  const rules = state.accounts.flatMap((account) => account.folders.map((path) => ({ path, account })));

  const removeRule = async (account: AccountView, path: string) => {
    try {
      const result = await store.rpc(setAccountFolders, { accountId: account.id, paths: account.folders.filter((folder) => folder !== path) });
      toast.show(describeReopen(`${folderName(path)} is shared again`, result), { variant: "success" });
    } catch (error) {
      toast.error(describe(error));
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <Text style={[text.muted, { flex: 1 }]}>Agents working in a project folder use its account, and no other agent moves onto that account.</Text>
        <Button theme={theme} size="small" tone="primary" icon="FolderPlus" label="Add folder" onPress={() => setAdding(true)} />
      </View>
      {rules.length === 0 ? (
        <View style={{ borderRadius: 12, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, padding: 20, alignItems: "center", gap: 4 }}>
          <Text style={text.strong}>No project folders yet</Text>
          <Text style={[text.small, { textAlign: "center" }]}>Give a client project its own subscription, so its work never eats into the others.</Text>
        </View>
      ) : (
        <View style={{ borderRadius: 12, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface1 }}>
          {rules.map(({ path, account }, index) => (
            <View
              key={`${account.id}:${path}`}
              style={{ flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: index > 0 ? 1 : 0, borderTopColor: colors.border }}
            >
              <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                <Text style={[text.strong, { fontSize: 13 }]} numberOfLines={1}>
                  {folderName(path)}
                </Text>
                <Text style={[text.small, { fontSize: 11 }]} numberOfLines={1}>
                  {path}
                </Text>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 180 }}>
                <Dot color={toneColor(theme, roomTone(account))} size={6} />
                <Text style={[text.small, { color: colors.foreground, fontWeight: "600" }]} numberOfLines={1}>
                  {account.label}
                </Text>
                <Text style={[text.small, { fontSize: 11 }]}>{FAMILY_LABEL[account.family]}</Text>
              </View>
              <IconButton theme={theme} icon="X" label={`Stop dedicating ${account.label} to ${folderName(path)}`} onPress={() => void removeRule(account, path)} />
            </View>
          ))}
        </View>
      )}
      {adding ? <AddFolderModal theme={theme} state={state} store={store} onClose={() => setAdding(false)} /> : null}
    </View>
  );
}

function AddFolderModal({ theme, state, store, onClose }: { theme: Theme; state: StateView; store: AccountsStore; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const colors = theme.colors;
  const [path, setPath] = useState("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const accounts = state.accounts.filter((account) => account.status !== "signed_out");
  const chosen = accounts.find((account) => account.id === accountId);
  const inputStyle = useMemo(
    () => ({
      color: colors.foreground,
      backgroundColor: colors.surface0,
      borderColor: colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    }),
    [colors],
  );
  const save = async () => {
    if (!chosen || !path.trim()) return;
    setSaving(true);
    try {
      const result = await store.rpc(setAccountFolders, { accountId: chosen.id, paths: [...chosen.folders, path.trim()] });
      toast.show(describeReopen(`${folderName(path.trim())} now uses ${chosen.label}`, result), { variant: "success" });
      onClose();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Dedicate an account to a folder" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <TextInput
          value={path}
          onChangeText={setPath}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="~/code/web-app"
          placeholderTextColor={colors.foregroundMuted}
          style={inputStyle}
          accessibilityLabel="Project folder"
        />
        <Text style={text.small}>Account</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {accounts.map((account) => {
            const selected = account.id === accountId;
            return (
              <Pressable
                key={account.id}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                onPress={() => setAccountId(account.id)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 6,
                  paddingHorizontal: 10,
                  minHeight: 32,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: selected ? colors.accent : colors.border,
                  backgroundColor: colors.surface2,
                }}
              >
                <Dot color={toneColor(theme, roomTone(account))} size={6} />
                <Text style={{ color: colors.foreground, fontSize: 12, fontWeight: "600" }}>{account.label}</Text>
                <Text style={{ color: colors.foregroundMuted, fontSize: 11 }}>{FAMILY_LABEL[account.family]}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" onPress={onClose} />
          <Button theme={theme} tone="primary" label="Save" busy={saving} disabled={!chosen || !path.trim()} onPress={() => void save()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
