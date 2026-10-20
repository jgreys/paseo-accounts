import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import { sendAlert } from "./server/alerts";
import { ClaudeAdapter } from "./server/claude";
import { CodexAdapter } from "./server/codex";
import { CopilotAdapter } from "./server/copilot";
import { KimiAdapter } from "./server/kimi";
import { OmpAdapter } from "./server/omp";
import { OpenCodeAdapter } from "./server/opencode";
import { PiAdapter } from "./server/pi";
import { Service, describe } from "./server/service";
import { preferences } from "./shared/preferences";
import {
  cancelLogin,
  clearAccountLimit,
  getState,
  redeemReset,
  removeAccount,
  renameAccount,
  setAgentAccount,
  setDefaultAccount,
  setAccountEnabled,
  setAccountFolders,
  testAlert,
  setAccountPriority,
  forkAgent,
  startLogin,
  submitLoginCode,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const service = new Service({
    claude: new ClaudeAdapter(),
    codex: new CodexAdapter(),
    copilot: new CopilotAdapter(),
    kimi: new KimiAdapter(),
    opencode: new OpenCodeAdapter(),
    pi: new PiAdapter(),
    omp: new OmpAdapter(),
  });

  const settings = server.registerSettings(preferences);
  const applySettings = (state: PluginSettingsState<typeof preferences.schema>) => {
    if (state.status === "ready") service.setPreferences(state.values);
  };
  void settings.read().then(applySettings, (error: unknown) => console.error("[paseo-accounts] could not read preferences", describe(error)));
  const stopSettings = settings.subscribe(applySettings);

  void service.start().catch((error: unknown) => console.error("[paseo-accounts] startup failed", describe(error)));

  // Never let routing break or stall an agent: on any error, or if it takes too long (Paseo fails
  // a hook after 30s), the session simply opens on its usual login.
  server.before("agent.session_open", async ({ request }, context) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[paseo-accounts] routing ${request.agentId} took too long; using the default login`);
        resolve(undefined);
      }, 15_000);
    });
    try {
      return await Promise.race([service.onSessionOpen(request, context), deadline]);
    } catch (error) {
      console.error(`[paseo-accounts] could not route ${request.agentId}; using the default login`, describe(error));
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  });

  server.on("agent.turn_started", (event, context) => {
    void service.onTurnStarted(event.agent, context).catch(() => undefined);
  });

  // Failover can take longer than a hook invocation is allowed to, so it runs in the background.
  server.on("agent.turn_ended", (event, context) => {
    void service.onTurnEnded(event, context).catch((error: unknown) => {
      console.error(`[paseo-accounts] failover for ${event.agent.id} failed`, describe(error));
    });
  });
  server.on("agent.archived", (event) => {
    void service.onAgentArchived(event.agent.id).catch(() => undefined);
  });

  server.handle(getState, ({ refreshUsage }, { paseo }) => service.view(paseo, refreshUsage));
  server.handle(startLogin, ({ family, method, accountId }) => service.startLogin(family, method, accountId));
  server.handle(submitLoginCode, ({ loginId, code }) => service.submitCode(loginId, code));
  server.handle(cancelLogin, ({ loginId }) => service.cancelLogin(loginId));
  server.handle(renameAccount, async ({ accountId, label }) => {
    await service.rename(accountId, label);
    return { ok: true as const };
  });
  server.handle(removeAccount, async ({ accountId }, { paseo }) => ({
    ok: true as const,
    movedAgents: await service.remove(paseo, accountId),
  }));
  server.handle(setDefaultAccount, ({ accountId }, { paseo }) => service.setDefault(paseo, accountId));
  server.handle(clearAccountLimit, async ({ accountId }) => {
    await service.clearLimit(accountId);
    return { ok: true as const };
  });
  server.handle(redeemReset, ({ accountId, agentId }, { paseo }) => service.redeem(paseo, accountId, agentId));
  server.handle(setAgentAccount, ({ agentId, accountId }, { paseo }) => service.setAgentAccount(paseo, agentId, accountId));
  server.handle(forkAgent, ({ agentId, to }, { paseo }) => service.forkAgent(paseo, agentId, to));
  server.handle(setAccountPriority, async ({ accountId, priority }) => {
    await service.setPriority(accountId, priority);
    return { ok: true as const };
  });
  server.handle(testAlert, async ({ url }) => {
    await sendAlert(url, "Test alert", "Alerts from paseo-accounts arrive here.");
    return { ok: true as const };
  });
  server.handle(setAccountFolders, ({ accountId, paths }, { paseo }) => service.setFolders(paseo, accountId, paths));
  server.handle(setAccountEnabled, ({ accountId, enabled }, { paseo }) => service.setAccountEnabled(paseo, accountId, enabled));

  return async () => {
    stopSettings();
    await service.stop();
  };
}
