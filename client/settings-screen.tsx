import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { DEFAULT_CONTINUE_PROMPT, preferences, type Preferences } from "../shared/preferences";
import { testAlert } from "../shared/rpc";
import type { AccountsStore } from "./store";

/** Settings → Plugins → paseo-accounts. Accounts themselves live in the sidebar surface. */
export function PreferencesScreen({
  theme,
  host,
  store,
  onOpenAccounts,
}: PluginSurfaceProps & { store: AccountsStore; onOpenAccounts(): void }) {
  const settings = useSettings(preferences);
  const multiHost = useHosts().length > 1;
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Preferences">
        <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
        ) : null}
      </SettingsSection>
    );
  }
  return (
    <>
      {multiHost ? (
        <Text style={muted}>These apply to agents on {host.label}. Each host keeps its own accounts and preferences.</Text>
      ) : null}
      <SettingsSection title="Accounts">
        <SettingsCard>
          <SettingsAction
            label="Add, remove, and choose default accounts"
            actionLabel="Open accounts"
            onPress={onOpenAccounts}
          />
        </SettingsCard>
      </SettingsSection>
      <PreferenceSections theme={theme} store={store} />
    </>
  );
}

/** Every preference, shared by Settings → Plugins and the Accounts screen's Settings tab. */
// Calls go through the plugin's own store rather than useRpc/useToast, which some app builds lack on
// the Settings → Plugins page.
export function PreferenceSections({ theme, store }: { theme: PluginSurfaceProps["theme"]; store: AccountsStore }) {
  const settings = useSettings(preferences);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [alertUrl, setAlertUrl] = useState<string | null>(null);
  const [switchAt, setSwitchAt] = useState<string | null>(null);
  const validSwitchAt = switchAt !== null && /^\d+$/.test(switchAt.trim()) && Number(switchAt) >= 50 && Number(switchAt) <= 100;
  if (settings.status !== "ready") {
    return settings.status === "loading" ? null : <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  }
  const save = (patch: Partial<Preferences>) =>
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  const url = (alertUrl ?? settings.values.alertUrl).trim();
  return (
    <>
      <SettingsSection title="Automatic switching">
        <SettingsCard>
          <SettingsSwitch
            label="Switch accounts when one hits its limit"
            hint="The agent moves to the account with the most room left."
            value={settings.values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label="Keep going after a switch"
            hint="Sends the follow-up below so the interrupted task continues."
            value={settings.values.autoContinue}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          <SettingsInput
            label="Follow-up message"
            initialValue={settings.values.continuePrompt}
            onChangeText={setPrompt}
            disabled={settings.saving || !settings.values.autoContinue}
            error={settings.saveError}
          />
          <SettingsAction
            label="Save the follow-up message"
            actionLabel="Save"
            disabled={settings.saving || prompt === null || !prompt.trim()}
            onPress={() => {
              if (prompt?.trim()) save({ continuePrompt: prompt.trim() });
            }}
          />
          <SettingsAction
            label="Restore the default follow-up"
            actionLabel="Restore"
            disabled={settings.saving || settings.values.continuePrompt === DEFAULT_CONTINUE_PROMPT}
            onPress={() => save({ continuePrompt: DEFAULT_CONTINUE_PROMPT })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Before the limit">
        <SettingsCard>
          <SettingsInput
            label="Switch early at (% used)"
            hint="When an agent's turn ends on an account at least this full, it moves to one with room before its next turn, instead of stopping halfway through a task. 50 to 99; 100 turns it off."
            initialValue={String(settings.values.switchAt)}
            placeholder="92"
            onChangeText={setSwitchAt}
            disabled={settings.saving || !settings.values.autoSwitch}
            error={switchAt !== null && !validSwitchAt ? "Enter a whole number from 50 to 100." : undefined}
          />
          <SettingsAction
            label="Save the early-switch level"
            actionLabel="Save"
            disabled={settings.saving || !validSwitchAt || Number(switchAt) === settings.values.switchAt}
            onPress={() => save({ switchAt: Number(switchAt) })}
          />
          <SettingsSwitch
            label="Use what's about to reset first"
            hint="When picking an account, prefer the one whose weekly or monthly allowance resets soonest, so none of it goes unused. Your priorities still come first."
            value={settings.values.pacing}
            disabled={settings.saving}
            onValueChange={(pacing) => save({ pacing })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Alerts">
        <SettingsCard>
          <SettingsInput
            label="Alert URL"
            hint="An ntfy topic (https://ntfy.sh/your-topic) or any webhook. Alerts: every account of a provider is out, an account is signed out, an agent didn't restart after switching."
            initialValue={settings.values.alertUrl}
            placeholder="https://ntfy.sh/your-topic"
            onChangeText={setAlertUrl}
            disabled={settings.saving}
          />
          <SettingsAction
            label="Save the alert URL"
            actionLabel="Save"
            disabled={settings.saving || alertUrl === null || alertUrl.trim() === settings.values.alertUrl}
            onPress={() => save({ alertUrl: url })}
          />
          <SettingsAction
            label="Send a test alert"
            actionLabel="Test"
            disabled={!/^https?:\/\/\S+$/.test(url)}
            onPress={() =>
              void store.rpc(testAlert, { url }).then(
                () => setTestResult({ ok: true, text: "Test alert sent. Check that it arrived." }),
                (error: unknown) => setTestResult({ ok: false, text: error instanceof Error ? error.message : String(error) }),
              )
            }
          />
          {testResult ? (
            <Text style={{ color: testResult.ok ? theme.colors.statusSuccess : theme.colors.statusDanger, fontSize: 13, padding: 12 }}>
              {testResult.text}
            </Text>
          ) : null}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New agents and composer">
        <SettingsCard>
          <SettingsSwitch
            label="Spread new agents across accounts"
            hint="New agents start on the account with the most room instead of the default."
            value={settings.values.balanceNewAgents}
            disabled={settings.saving}
            onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
          />
          <SettingsSwitch
            label="Move open agents when the default changes"
            hint="Off: open agents stay on the account they're using, even after they reopen. New agents, and agents that aren't open at the time, use the new default."
            value={settings.values.moveAgentsOnDefaultChange}
            disabled={settings.saving}
            onValueChange={(moveAgentsOnDefaultChange) => save({ moveAgentsOnDefaultChange })}
          />
          <SettingsSwitch
            label="Use banked resets when every account is out"
            hint="Spends one of the account's banked resets instead of stopping. Off unless you turn it on: resets are scarce."
            value={settings.values.autoRedeem}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoRedeem) => save({ autoRedeem })}
          />
          <SettingsSwitch
            label="When every account is out, fork the chat to another provider"
            hint="A stopped chat carries on in a new agent on the next provider with a free account (ChatGPT, then Kimi Code, then the rest), then any other provider Paseo has available. It keeps the conversation so far and, where the provider has permission modes, no more than the original. The original stays as it was."
            value={settings.values.forkOtherProvider}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
          />
          <SettingsSwitch
            label="Show the account pill in the composer"
            hint="Appears on Claude and Codex agents once a provider has two or more accounts."
            value={settings.values.showComposerPill}
            disabled={settings.saving}
            onValueChange={(showComposerPill) => save({ showComposerPill })}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
