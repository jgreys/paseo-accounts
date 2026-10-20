import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { applyEnv } from "./adapter";
import { chooseAccount, mostAvailable } from "./routing";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function account(partial: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount {
  return {
    family: "claude",
    label: partial.id,
    autoLabel: false,
    kind: "managed",
    home: `/homes/${partial.id}`,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    priority: "normal",
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function stateWith(accounts: StoredAccount[], patch: Partial<StoredState> = {}): StoredState {
  return { ...emptyState(), accounts, ...patch };
}

function usage(percent: number): Usage {
  return {
    fetchedAt: "2026-09-23T11:59:00Z",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }],
    error: null,
    cached: false,
    resets: null,
  };
}

const base = {
  agentId: "agent-1",
  family: "claude" as const,
  now: NOW,
  autoSwitch: true,
  balanceNewAgents: false,
  portable: true,
};

describe("chooseAccount", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const personal = account({ id: "claude-personal" });

  it("uses the CLI login when nothing else is configured", () => {
    const decision = chooseAccount(stateWith([main, work]), { ...base, reason: "create", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.bind).toBeNull();
  });

  it("follows the chosen default", () => {
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("prefers the agent's own binding over the default", () => {
    const state = stateWith([main, work, personal], {
      defaults: { claude: "claude-work", codex: null },
      bindings: { "agent-1": { accountId: "claude-personal", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-personal");
  });

  it("ignores a binding to a removed account", () => {
    const state = stateWith([main, work], {
      bindings: { "agent-1": { accountId: "claude-gone", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-main");
  });

  it("skips an exhausted account for the roomiest usable one", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited, personal], { defaults: { claude: "claude-work", codex: null } });
    const decision = chooseAccount(state, {
      ...base,
      reason: "resume",
      usageOf: (id) => (id === "claude-main" ? usage(80) : usage(10)),
    });
    expect(decision?.account.id).toBe("claude-personal");
    expect(decision?.bind?.source).toBe("auto");
    expect(decision?.skipped?.why).toBe("limited");
  });

  it("keeps an exhausted account when automatic switching is off", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited], { defaults: { claude: "claude-work", codex: null } });
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
  });

  it("treats an expired limit as usable again", () => {
    const recovered = account({ id: "claude-work", limitedUntil: "2026-09-23T11:00:00Z" });
    const state = stateWith([main, recovered], { defaults: { claude: "claude-work", codex: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("spreads new agents by headroom when balancing", () => {
    const state = stateWith([main, work, personal]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "create",
      usageOf: (id) => ({ "claude-main": usage(60), "claude-work": usage(5), "claude-personal": usage(30) })[id],
    });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind?.source).toBe("balance");
  });

  it("does not rebalance agents that already exist", () => {
    const state = stateWith([main, work]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "resume",
      usageOf: (id) => (id === "claude-work" ? usage(0) : usage(90)),
    });
    expect(decision?.account.id).toBe("claude-main");
  });

  it("returns null when the family has no accounts", () => {
    expect(chooseAccount(emptyState(), { ...base, reason: "create", usageOf: () => null })).toBeNull();
  });
});

describe("mostAvailable", () => {
  it("breaks ties toward the default account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null });
    const work = account({ id: "claude-work" });
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null } });
    expect(mostAvailable(state, "claude", () => usage(20), NOW)?.id).toBe("claude-work");
  });

  it("never picks a signed-out account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null, signedIn: false });
    const state = stateWith([main]);
    expect(mostAvailable(state, "claude", () => usage(0), NOW)).toBeUndefined();
  });
});

describe("non-portable conversations (Codex)", () => {
  const main = account({ id: "codex-main", family: "codex", kind: "main", home: null });
  const work = account({ id: "codex-work", family: "codex" });
  const codex = { ...base, family: "codex" as const, portable: false };

  it("pins a thread to the account it first opens on", () => {
    const decision = chooseAccount(stateWith([main, work]), { ...codex, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-main");
    expect(decision?.bind).toMatchObject({ accountId: "codex-main", source: "thread" });
  });

  it("keeps an existing thread on its exhausted account instead of breaking it", () => {
    const limited = account({ id: "codex-main", family: "codex", kind: "main", home: null, limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([limited, work], {
      bindings: { "agent-1": { accountId: "codex-main", source: "thread", at: "x" } },
    });
    expect(chooseAccount(state, { ...codex, reason: "resume", usageOf: () => null })?.account.id).toBe("codex-main");
  });

  it("starts new agents on a usable account", () => {
    const limited = account({ id: "codex-main", family: "codex", kind: "main", home: null, limitedUntil: "2026-09-23T14:00:00Z" });
    const decision = chooseAccount(stateWith([limited, work]), { ...codex, reason: "create", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-work");
    expect(decision?.bind).toMatchObject({ accountId: "codex-work", source: "thread" });
  });
});

describe("applyEnv", () => {
  it("sets values and drops inherited overrides", () => {
    expect(applyEnv({ CODEX_HOME: "/homes/work", CODEX_SQLITE_HOME: null }, { KEEP: "1", CODEX_SQLITE_HOME: "/x" })).toEqual({
      KEEP: "1",
      CODEX_HOME: "/homes/work",
    });
  });
});

describe("disabled accounts", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const off = { disabled: true };

  it("routes around a disabled account but keeps the agent's own binding", () => {
    const pinned = stateWith([main, account({ id: "claude-work", ...off })], {
      bindings: { "agent-1": { accountId: "claude-work", source: "user", at: "2026-09-23T00:00:00Z" } },
    });
    const decision = chooseAccount(pinned, { ...base, reason: "refresh", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.skipped?.why).toBe("disabled");
    expect(decision?.bind).toBeNull(); // so the agent returns once the account is enabled again
  });

  it("skips a disabled default even with automatic switching off", () => {
    const state = stateWith([account({ id: "claude-main", kind: "main", home: null, ...off }), work]);
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind).toBeNull();
  });

  it("pins a new ChatGPT thread where it actually starts", () => {
    const codexMain = account({ id: "codex-main", family: "codex", kind: "main", home: null, ...off });
    const codexWork = account({ id: "codex-work", family: "codex" });
    const decision = chooseAccount(stateWith([codexMain, codexWork]), {
      ...base,
      family: "codex",
      portable: false,
      reason: "create",
      usageOf: () => null,
    });
    expect(decision?.account.id).toBe("codex-work");
    expect(decision?.bind).toMatchObject({ accountId: "codex-work", source: "thread" });
  });

  it("leaves an existing ChatGPT thread on its disabled account, since it can't move", () => {
    const codexMain = account({ id: "codex-main", family: "codex", kind: "main", home: null });
    const codexWork = account({ id: "codex-work", family: "codex", ...off });
    const state = stateWith([codexMain, codexWork], {
      bindings: { "agent-1": { accountId: "codex-work", source: "thread", at: "2026-09-23T00:00:00Z" } },
    });
    const decision = chooseAccount(state, { ...base, family: "codex", portable: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-work");
  });

  it("is never the most available account", () => {
    const state = stateWith([main, account({ id: "claude-work", ...off })]);
    const usageOf = (id: string) => usage(id === "claude-main" ? 90 : 5);
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-main");
  });
});

describe("folder rules", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const hub = account({ id: "claude-hub" });
  const folders = [{ path: "/p/hub", accountId: "claude-hub" }];
  const route = (state: StoredState, cwd: string, extra: Partial<Parameters<typeof chooseAccount>[1]> = {}) =>
    chooseAccount(state, { ...base, reason: "create", cwd, usageOf: () => null, ...extra })?.account.id;

  it("routes agents inside the folder to its account", () => {
    const state = stateWith([main, work, hub], { folders });
    expect(route(state, "/p/hub")).toBe("claude-hub");
    expect(route(state, "/p/hub/sub")).toBe("claude-hub");
    expect(route(state, "/p/web-app")).toBe("claude-main");
  });

  it("picks the deepest matching folder", () => {
    const state = stateWith([main, work, hub], { folders: [...folders, { path: "/p/hub/api/", accountId: "claude-work" }] });
    expect(route(state, "/p/hub/api/x")).toBe("claude-work");
  });

  it("keeps a user's choice for the agent over the folder", () => {
    const state = stateWith([main, work, hub], {
      folders,
      bindings: { "agent-1": { accountId: "claude-work", source: "user", at: "x" } },
    });
    expect(route(state, "/p/hub")).toBe("claude-work");
  });

  it("never balances or fails other agents over onto a dedicated account", () => {
    const state = stateWith([main, hub], { folders });
    const quiet = (id: string) => usage(id === "claude-hub" ? 0 : 90);
    expect(route(state, "/elsewhere", { balanceNewAgents: true, usageOf: quiet })).toBe("claude-main");
    const limited = stateWith([account({ id: "claude-main", kind: "main", home: null, limitedUntil: "2099-01-01T00:00:00Z" }), hub], { folders });
    expect(route(limited, "/elsewhere")).toBe("claude-main");
  });

  it("fails over off a limited folder account, and returns once it is usable", () => {
    const limitedHub = account({ id: "claude-hub", limitedUntil: "2099-01-01T00:00:00Z" });
    const moved = stateWith([main, limitedHub], { folders });
    const decision = chooseAccount(moved, { ...base, reason: "refresh", cwd: "/p/hub", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    const back = stateWith([main, hub], { folders, bindings: { "agent-1": decision!.bind! } });
    expect(route(back, "/p/hub", { reason: "refresh" })).toBe("claude-hub");
  });

  it("uses the folder recorded with the agent's last session", () => {
    const state = stateWith([main, hub], {
      folders,
      sessions: { "agent-1": { accountId: "claude-main", family: "claude", openedAt: "x", cwd: "/p/hub" } },
    });
    expect(chooseAccount(state, { ...base, reason: "refresh", usageOf: () => null })?.account.id).toBe("claude-hub");
  });
});

describe("priority and pacing", () => {
  const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
  const weekly = (percent: number, resetsInHours: number): Usage => ({
    fetchedAt: at(0),
    windows: [
      { id: "five_hour", label: "5-hour", usedPercent: 10, resetsAt: at(2) },
      { id: "seven_day", label: "Weekly", usedPercent: percent, resetsAt: at(resetsInHours) },
    ],
    error: null,
    cached: false,
    resets: null,
  });

  it("uses a first-priority account before roomier normal ones, and last ones only when needed", () => {
    const personal = account({ id: "claude-personal", priority: "first" });
    const work = account({ id: "claude-work" });
    const spare = account({ id: "claude-spare", priority: "last" });
    const state = stateWith([work, personal, spare]);
    const usageOf = (id: string) => usage(id === "claude-personal" ? 60 : id === "claude-work" ? 10 : 0);
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-personal");
    expect(mostAvailable(state, "claude", usageOf, NOW, new Set(["claude-personal"]))?.id).toBe("claude-work");
    expect(mostAvailable(state, "claude", usageOf, NOW, new Set(["claude-personal", "claude-work"]))?.id).toBe("claude-spare");
  });

  it("ranks nearly full accounts last, whatever their priority", () => {
    const personal = account({ id: "claude-personal", priority: "first" });
    const work = account({ id: "claude-work" });
    const usageOf = (id: string) => usage(id === "claude-personal" ? 95 : 40);
    expect(mostAvailable(stateWith([personal, work]), "claude", usageOf, NOW, new Set(), { fullAt: 92 })?.id).toBe("claude-work");
  });

  it("with pacing, spends the allowance that resets soonest first", () => {
    const soon = account({ id: "claude-soon" });
    const later = account({ id: "claude-later" });
    // 40% left resetting in 8 hours beats 70% left resetting in 5 days: the 40% would be lost.
    const usageOf = (id: string) => (id === "claude-soon" ? weekly(60, 8) : weekly(30, 120));
    const state = stateWith([later, soon]);
    expect(mostAvailable(state, "claude", usageOf, NOW, new Set(), { pace: true })?.id).toBe("claude-soon");
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-later");
  });
});
