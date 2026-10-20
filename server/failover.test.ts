import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter, LimitHit, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { detectClaudeLimit } from "./limits";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredAccount, type StoredState } from "./state";
import { preferences } from "../shared/preferences";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paseo-accounts-failover-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function account(id: string, label: string, kind: "main" | "managed") {
  return { id, family: "claude" as const, label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z" };
}

/** A Claude adapter whose every failed turn is a session limit resetting at `resetsAt`. */
function claudeAdapter(hit: () => LimitHit): FamilyAdapter {
  const reading = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null });
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async () => reading(),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: (event: { outcome: { kind: string } }) => (event.outcome.kind === "failed" ? hit() : null),
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

function fakePaseo() {
  const sent: string[] = [];
  const notes: Array<{ from: string | null; to: string; outcome: string; detail: string | null }> = [];
  const agent = { id: AGENT, provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: "2026-09-23T07:00:00.000Z" };
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async (text: string) => void sent.push(text),
        timeline: {
          append: async (item: { data: { from: string | null; to: string; outcome: string; detail: string | null } }) =>
            void notes.push(item.data),
          refetch: async () => ({ entries: [] }),
        },
      }),
    },
  };
  return { paseo, sent, notes };
}

interface SetUpOptions {
  /** How `paseo agent reload` ends. */
  reload?: "works" | "fails" | "times out";
  /** Reads turns with a real detector instead of taking every failed turn for a limit. */
  detectLimit?: FamilyAdapter["detectLimit"];
}

async function setUp(state: Partial<StoredState>, hit: () => LimitHit, options: SetUpOptions = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const reopened: string[] = [];
  const fake = fakePaseo();
  const context = { paseo: fake.paseo } as never;
  // Paseo asks for the new session's environment before it closes the old session, so the hook has
  // run by the time `paseo agent reload` returns, even when the reload then failed.
  const reopenedSession = () =>
    service.onSessionOpen({ agentId: AGENT, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never, context);
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      reopened.push(id);
      await reopenedSession();
      if (options.reload === "fails") {
        return { ok: false as const, error: "Timed out closing previous session during refresh", timedOut: false };
      }
      if (options.reload === "times out") return { ok: false as const, error: "Command failed: paseo agent reload", timedOut: true };
      return { ok: true as const };
    },
  };
  const families = { resolve: async () => ({ claude: "claude" as const }) };
  const claude = { ...claudeAdapter(hit), ...(options.detectLimit ? { detectLimit: options.detectLimit } : {}) };
  const service = new Service(
    { claude, codex: claudeAdapter(hit), kimi: claudeAdapter(hit), opencode: claudeAdapter(hit), pi: claudeAdapter(hit), copilot: claudeAdapter(hit), omp: claudeAdapter(hit) },
    store,
    families as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  const limitTurn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
  return { service, store, reopened, limitTurn, ...fake };
}

const inFuture = () => new Date(Date.now() + 30 * 60_000).toISOString();
const inPast = () => new Date(Date.now() - 60_000).toISOString();

describe("failover", () => {
  it("blames the CLI login for a session the plugin never routed, even when the agent is bound elsewhere", async () => {
    // Today's incident: the agent's session predates the plugin, and a switch to "hello" was waiting.
    const { store, reopened, sent, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" }),
    );
    await limitTurn();
    const state = await store.read();
    expect(state.accounts.find((a) => a.id === MAIN)?.limitedUntil).not.toBeNull();
    expect(state.accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
    expect(sent).toHaveLength(1);
  });

  it("moves on again when the next account runs out too", async () => {
    let resetsAt = inPast(); // marketing's window has already reset when hello runs out
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt, message: "You've hit your session limit" }),
    );
    await limitTurn(); // marketing → hello
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    resetsAt = inFuture();
    await limitTurn(); // hello runs out → back to marketing
    expect(reopened).toHaveLength(2);
    expect(notes.at(-1)).toMatchObject({ from: "hello", to: "marketing", outcome: "switched" });
  });

  it("explains in the timeline when it stops switching an agent that keeps bouncing", async () => {
    const { reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inPast(), message: "You've hit your session limit" }),
    );
    for (let turn = 0; turn < 5; turn += 1) await limitTurn();
    expect(reopened).toHaveLength(4);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/stopped switching it for now/);
  });

  it("doesn't blame the new account for the old one's limit when a message fails before its turn starts", async () => {
    // A real incident: marketing's weekly limit moved the agent to hello, then a message hit a closed
    // session. Paseo never started that turn, so the timeline still ended with marketing's notice.
    const notice = "You've hit your weekly limit · resets Sep 25 at 3:30pm (Asia/Calcutta)";
    const { service, store, reopened, notes, paseo } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => {
        throw new Error("unused: the real detector reads the turns");
      },
      { detectLimit: detectClaudeLimit },
    );
    const context = { paseo } as never;
    const agent = { id: AGENT, provider: "claude" };
    const earlier: AgentTimelineItem[] = [
      { type: "user_message", text: "fix the bug" },
      { type: "assistant_message", text: notice },
    ];
    await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: earlier } as never, context);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);

    const closed = "Claude session is closed";
    await service.onTurnEnded(
      {
        agent,
        turnId: null,
        outcome: { kind: "failed", error: { message: closed } },
        timeline: [...earlier, { type: "assistant_message", text: `[System Error] ${closed}` }],
      } as never,
      context,
    );
    expect((await store.read()).accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(reopened).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it("keeps an agent's session where it was when Paseo can't reload it", async () => {
    const openedAt = "2026-09-23T07:00:00.000Z";
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "fails" },
    );
    await limitTurn();
    const state = await store.read();
    expect(reopened).toEqual([AGENT]);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // where it goes when its session next opens
    expect(state.sessions[AGENT]).toEqual({ accountId: MAIN, family: "claude", openedAt });
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "pending" });
  });

  it("keeps the new session when the reload only ran out of time", async () => {
    // The daemon may still finish a reload that the command-line tool stopped waiting for.
    const { store, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "times out" },
    );
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });
});

describe("forking to the other provider", () => {
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const MODES: Record<string, Array<{ id: string; label: string; colorTier: string }>> = {
    claude: [
      { id: "plan", label: "Plan Mode", colorTier: "planning" },
      { id: "default", label: "Always Ask", colorTier: "safe" },
      { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    codex: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
  };

  async function setUpFork(modeId: string) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: [account(MAIN, "marketing", "main"), { ...account(CODEX_MAIN, "hello", "main"), family: "codex" }],
        defaults: { claude: MAIN, codex: CODEX_MAIN },
      }),
    );
    const source = {
      id: AGENT,
      provider: "claude",
      status: "idle",
      title: "Fix the build",
      model: "claude-opus-5-5",
      currentModeId: modeId,
      workspaceId: "ws-1",
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      labels: {},
    };
    const agents: Array<Record<string, unknown>> = [source];
    const created: Array<{ agentId: string; config: { provider: string; modeId?: string }; title: string; prompt: string; labels: Record<string, string> }> = [];
    const notes: Array<{ to: string; outcome: string; toFamily: string | null; detail: string | null; continuedIn: { agentId: string } | null }> = [];
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: {
        listAvailable: async () => ({ providers: [{ provider: "claude", available: true }, { provider: "codex", available: true }] }),
        listModes: async (provider: string) => ({ modes: MODES[provider] }),
        listModels: async (provider: string) => ({ models: [{ id: provider === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", isDefault: true }] }),
      },
      workspaces: {
        ref: () => ({
          agents: {
            create: async (request: (typeof created)[number]) => {
              created.push(request);
              agents.push({ id: request.agentId, provider: "codex", status: "running", title: request.title, archivedAt: null, labels: request.labels });
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: () => ({
          refresh: async () => ({ agent: source }),
          send: async () => undefined,
          timeline: { append: async (item: { data: (typeof notes)[number] }) => void notes.push(item.data), refetch: async () => ({ entries: [] }) },
        }),
      },
    };
    const service = new Service(
      {
        claude: claudeAdapter(() => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" })),
        codex: { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), family: "codex", portable: false } as FamilyAdapter,
        kimi: claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })),
        opencode: claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })),
        pi: claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })),
        copilot: claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })),
        omp: claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })),
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    service.setPreferences(preferences.schema.parse({ forkOtherProvider: true }));
    const context = { paseo } as never;
    const limitTurn = () =>
      service.onTurnEnded(
        { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
        context,
      );
    return { store, created, notes, limitTurn };
  }

  it("carries the work on with the other provider, at the same permission level", async () => {
    const { store, created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    expect(created).toHaveLength(1);
    const fork = created[0];
    expect(fork?.config).toEqual({ provider: "codex/gpt-5.6-sol", modeId: "full-access" });
    expect(fork?.title).toBe("Fix the build (continued on ChatGPT)");
    expect(fork?.labels).toEqual({ "paseo-accounts.continued-from": AGENT });
    expect(fork?.prompt).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
    expect((await store.read()).bindings[fork?.agentId ?? ""]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", toFamily: "codex", to: "hello", continuedIn: { agentId: fork?.agentId } });
  });

  it("points at the earlier fork instead of starting another", async () => {
    const { created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: created[0]?.agentId } });
  });

  it("won't fork into a mode more permissive than the original's", async () => {
    const { created, notes, limitTurn } = await setUpFork("default");
    await limitTurn();
    expect(created).toHaveLength(0);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Always Ask”\)/);
  });
});

describe("disabling an account", () => {
  it("moves its agents off and back, and won't disable the last usable account", async () => {
    const { service, store, reopened } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: new Date().toISOString() } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
    );
    const paseo = fakePaseo().paseo as never;

    const off = await service.setAccountEnabled(paseo, HELLO, false);
    expect(off.reopened).toEqual([AGENT]);
    let state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // kept for when it's enabled again

    await expect(service.setAccountEnabled(paseo, MAIN, false)).rejects.toThrow(/only Claude account in use/);

    const on = await service.setAccountEnabled(paseo, HELLO, true);
    expect(on.reopened).toEqual([AGENT]);
    state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toHaveLength(2);
  });
});

describe("switching early", () => {
  const usage = (percent: number) => ({
    fetchedAt: new Date().toISOString(),
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }],
    error: null,
    cached: false,
    resets: null,
  });
  const completedTurn = (service: Service, paseo: unknown) =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "completed" }, timeline: [] } as never,
      { paseo } as never,
    );
  const state = {
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt: new Date().toISOString() } },
  };

  it("moves an agent off a nearly full account after its turn, without a continue message", async () => {
    const { service, store, reopened, sent, notes, paseo } = await setUp(state, () => ({ kind: "window", resetsAt: null, message: "" }));
    const internal = service as unknown as { usage: Map<string, unknown> };
    internal.usage.set(MAIN, usage(94));
    internal.usage.set(HELLO, usage(20));
    await completedTurn(service, paseo);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: HELLO, source: "auto" });
    expect(reopened).toEqual([AGENT]);
    expect(sent).toHaveLength(0);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
  });

  it("stays put below the line, or when every other account is nearly full too", async () => {
    const { service, reopened, paseo } = await setUp(state, () => ({ kind: "window", resetsAt: null, message: "" }));
    const internal = service as unknown as { usage: Map<string, unknown> };
    internal.usage.set(MAIN, usage(80));
    internal.usage.set(HELLO, usage(10));
    await completedTurn(service, paseo);
    internal.usage.set(MAIN, usage(96));
    internal.usage.set(HELLO, usage(93));
    await completedTurn(service, paseo);
    expect(reopened).toHaveLength(0);
  });

  it("leaves an agent the user put on that account", async () => {
    const pinned = { ...state, bindings: { [AGENT]: { accountId: MAIN, source: "user" as const, at: new Date().toISOString() } } };
    const { service, reopened, paseo } = await setUp(pinned, () => ({ kind: "window", resetsAt: null, message: "" }));
    const internal = service as unknown as { usage: Map<string, unknown> };
    internal.usage.set(MAIN, usage(99));
    internal.usage.set(HELLO, usage(5));
    await completedTurn(service, paseo);
    expect(reopened).toHaveLength(0);
  });
});

describe("forking further down the provider order", () => {
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const KIMI_MAIN = MAIN_ACCOUNT_ID.kimi;
  const PI_MAIN = MAIN_ACCOUNT_ID.pi;
  const MODES: Record<string, Array<{ id: string; label: string; colorTier: string }>> = {
    claude: [
      { id: "plan", label: "Plan Mode", colorTier: "planning" },
      { id: "default", label: "Always Ask", colorTier: "safe" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    codex: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
    kimi: [
      { id: "plan", label: "Plan", colorTier: "planning" },
      { id: "yolo", label: "YOLO", colorTier: "dangerous" },
    ],
    pi: [],
    glm: [{ id: "glm-danger", label: "Danger", colorTier: "dangerous" }],
  };
  const MODELS: Record<string, string> = {
    claude: "claude-opus-5-5",
    codex: "gpt-5.6-sol",
    kimi: "kimi-k2-thinking",
    pi: "pi-default",
    glm: "glm-4.6",
  };

  async function setUpFallback(limited: { codex?: boolean; kimi?: boolean; pi?: boolean }, extras = true) {
    const out = { limitedUntil: new Date(Date.now() + 3_600_000).toISOString(), limitKind: "window" };
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: [
          account(MAIN, "marketing", "main"),
          { ...account(CODEX_MAIN, "chatgpt", "main"), family: "codex", ...(limited.codex ? out : {}) },
          { ...account(KIMI_MAIN, "kimi", "main"), family: "kimi", ...(limited.kimi ? out : {}) },
          { ...account(PI_MAIN, "pi", "main"), family: "pi", ...(limited.pi ? out : {}) },
        ],
        defaults: { claude: MAIN, codex: CODEX_MAIN, kimi: KIMI_MAIN, pi: PI_MAIN },
      }),
    );
    const source = {
      id: AGENT,
      provider: "claude",
      status: "idle",
      title: "Fix the build",
      model: "claude-opus-5-5",
      currentModeId: "bypassPermissions",
      workspaceId: "ws-1",
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      labels: {},
    };
    const agents: Array<Record<string, unknown>> = [source];
    const created: Array<{ agentId: string; config: { provider: string; modeId?: string }; title: string; prompt: string; labels: Record<string, string> }> = [];
    const notes: Array<{ to: string; outcome: string; toFamily: string | null; detail: string | null; continuedIn: { agentId: string } | null }> = [];
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: {
        listAvailable: async () => ({
          providers: (extras ? ["claude", "codex", "kimi", "pi", "glm"] : ["claude", "codex", "kimi", "pi"]).map((provider) => ({
            provider,
            available: true,
          })),
        }),
        snapshot: async () => ({ entries: [{ provider: "glm", label: "GLM" }] }),
        listModes: async (provider: string) => ({ modes: MODES[provider] }),
        listModels: async (provider: string) => ({ models: [{ id: MODELS[provider], isDefault: true }] }),
      },
      workspaces: {
        ref: () => ({
          agents: {
            create: async (request: (typeof created)[number]) => {
              created.push(request);
              agents.push({ id: request.agentId, provider: request.config.provider.split("/")[0], status: "running", title: request.title, archivedAt: null, labels: request.labels });
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: () => ({
          refresh: async () => ({ agent: source }),
          send: async () => undefined,
          timeline: { append: async (item: { data: (typeof notes)[number] }) => void notes.push(item.data), refetch: async () => ({ entries: [] }) },
        }),
      },
    };
    const adapter = (family: string, hit: () => LimitHit) => ({ ...claudeAdapter(hit), family }) as unknown as FamilyAdapter;
    const room = () => ({ kind: "window", resetsAt: null, message: "" }) as LimitHit;
    const service = new Service(
      {
        claude: claudeAdapter(() => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" })),
        codex: adapter("codex", room),
        kimi: adapter("kimi", room),
        opencode: adapter("opencode", room),
        pi: adapter("pi", room),
        copilot: adapter("copilot", room),
        omp: adapter("omp", room),
      },
      store,
      { resolve: async () => ({ claude: "claude", codex: "codex", kimi: "kimi", pi: "pi" }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    service.setPreferences(preferences.schema.parse({ forkOtherProvider: true }));
    const limitTurn = () =>
      service.onTurnEnded(
        { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
        { paseo } as never,
      );
    return { store, service, paseo, created, notes, limitTurn };
  }

  it("carries on with Kimi Code when ChatGPT is out too", async () => {
    const { store, created, notes, limitTurn } = await setUpFallback({ codex: true });
    await limitTurn();
    expect(created).toHaveLength(1);
    const fork = created[0];
    expect(fork?.config).toEqual({ provider: "kimi/kimi-k2-thinking", modeId: "yolo" });
    expect(fork?.title).toBe("Fix the build (continued on Kimi)");
    expect((await store.read()).bindings[fork?.agentId ?? ""]).toMatchObject({ accountId: KIMI_MAIN });
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", toFamily: "kimi", continuedIn: { agentId: fork?.agentId } });
  });

  it("forks to a provider without modes with its own default permissions", async () => {
    const { created, notes, limitTurn } = await setUpFallback({ codex: true, kimi: true });
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(created[0]?.config).toEqual({ provider: "pi/pi-default" });
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", toFamily: "pi" });
  });

  it("keeps the agent when no provider has room, saying why for each", async () => {
    const { created, notes, limitTurn } = await setUpFallback({ codex: true, kimi: true, pi: true }, false);
    await limitTurn();
    expect(created).toHaveLength(0);
    expect(notes.at(-1)?.outcome).toBe("stayed");
    expect(notes.at(-1)?.detail).toMatch(/Every ChatGPT account is at its limit too\./);
    expect(notes.at(-1)?.detail).toMatch(/Every Kimi account is at its limit too\./);
  });

  it("carries on with any other provider Paseo has, without an account", async () => {
    const { store, created, notes, limitTurn } = await setUpFallback({ codex: true, kimi: true, pi: true });
    await limitTurn();
    expect(created).toHaveLength(1);
    const fork = created[0];
    expect(fork?.config).toEqual({ provider: "glm/glm-4.6", modeId: "glm-danger" });
    expect(fork?.title).toBe("Fix the build (continued on GLM)");
    expect((await store.read()).bindings[fork?.agentId ?? ""]).toBeUndefined();
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", toFamily: "glm", to: "GLM" });
  });

  it("uses the provider the user picked, even when an earlier one has room", async () => {
    const { service, paseo, created } = await setUpFallback({});
    await service.forkAgent(paseo as never, AGENT, "kimi");
    expect(created).toHaveLength(1);
    expect(created[0]?.config.provider).toBe("kimi/kimi-k2-thinking");
  });
});

describe("changing the default account", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const stateWithLiveAgent = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null },
    bindings: {},
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });

  it("moves agents that follow the default", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "",
    }));
    const paseo = fakePaseo().paseo as never;

    const summary = await service.setDefault(paseo, HELLO);
    expect(summary.reopened).toEqual([AGENT]);
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).defaults.claude).toBe(HELLO);
  });

  it("leaves running agents where they are when that preference is off", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "",
    }));
    service.setPreferences(preferences.schema.parse({ moveAgentsOnDefaultChange: false }));
    const paseo = fakePaseo().paseo as never;

    const summary = await service.setDefault(paseo, HELLO);
    expect(summary.reopened).toEqual([]);
    expect(reopened).toEqual([]);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO); // the default still changed, for new agents
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    // Pinned where it runs, so resuming it later doesn't drift to the new default either.
    expect(state.bindings[AGENT]).toMatchObject({ accountId: MAIN });
  });

  const WORK = "claude-work";
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const KEEP = preferences.schema.parse({ moveAgentsOnDefaultChange: false });
  const NOTHING_MOVED = { reopened: [], deferred: [], failed: [], continuedIn: null };
  const session = (accountId: string) => ({ accountId, family: "claude" as const, openedAt });

  /** Several agents, each answering for itself. `reopened` lists the ones Paseo was asked to reload. */
  async function setUpAgents(
    state: Partial<StoredState>,
    listed: Array<{ id: string; status: string; provider?: string; archived?: boolean }>,
    options: { claude?: Partial<FamilyAdapter>; onList?: (service: Service, context: never) => void } = {},
  ) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) => Object.assign(draft, state));
    const agents = listed.map(({ id, status, provider, archived }) => ({
      id,
      provider: provider ?? "claude",
      status,
      archivedAt: archived ? "2026-09-23T08:00:00.000Z" : null,
      lastUserMessageAt: openedAt,
    }));
    const paseo = {
      providers: { listAvailable: async () => ({ providers: [] }) },
      config: { get: async () => ({ config: { providers: {} } }) },
      agents: {
        list: async () => {
          options.onList?.(service, context);
          return { entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
        },
        ref: (id: string) => ({
          refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }),
          send: async () => undefined,
          timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
        }),
      },
    };
    const context = { paseo } as never;
    const reopened: string[] = [];
    const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" });
    const service: Service = new Service(
      {
        claude: { ...claudeAdapter(hit), ...options.claude },
        codex: { ...claudeAdapter(hit), family: "codex", portable: false } as FamilyAdapter,
        kimi: claudeAdapter(hit),
        opencode: claudeAdapter(hit),
        pi: claudeAdapter(hit),
        copilot: claudeAdapter(hit),
        omp: claudeAdapter(hit),
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      {
        locate: async () => "/usr/local/bin/paseo",
        reopen: async (id: string) => {
          reopened.push(id);
          const provider = agents.find((agent) => agent.id === id)?.provider;
          await service.onSessionOpen({ agentId: id, provider, reason: "refresh", purpose: "interactive", env: {} } as never, context);
          return { ok: true as const };
        },
      } as unknown as Reopener,
    );
    service.setPreferences(KEEP);
    return { service, store, paseo: paseo as never, context, reopened };
  }

  it("keeps each open agent that follows the default on the account it runs on, and nothing else", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
        bindings: { chosen: { accountId: MAIN, source: "user", at: openedAt } },
        sessions: {
          idle: session(WORK),
          busy: session(WORK),
          chosen: session(MAIN),
          closed: session(WORK),
          there: session(HELLO),
        },
      },
      [
        { id: "idle", status: "idle" },
        { id: "busy", status: "running" },
        { id: "unrouted", status: "idle" }, // opened before the plugin routed anything, so on the CLI login
        { id: "chosen", status: "idle" },
        { id: "closed", status: "closed" },
        { id: "there", status: "idle" }, // already on the new default
        { id: "chatgpt", status: "idle", provider: "codex" }, // a Claude default isn't its concern
      ],
    );

    expect(await service.setDefault(paseo, HELLO)).toEqual(NOTHING_MOVED);
    expect(reopened).toEqual([]);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO);
    const { bindings } = state;
    expect(bindings.idle).toMatchObject({ accountId: WORK, source: "auto" });
    expect(bindings.busy).toMatchObject({ accountId: WORK, source: "auto" });
    expect(bindings.unrouted).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(bindings.chosen).toMatchObject({ accountId: MAIN, source: "user" });
    expect(bindings.closed).toBeUndefined();
    expect(bindings.there).toBeUndefined();
    expect(bindings.chatgpt).toBeUndefined();

    // Kept agents read as pinned, so their account button offers "Follow default"; the rest follow it.
    const routes = new Map((await service.view(paseo)).agents.map((route) => [route.agentId, route]));
    expect(routes.get("idle")).toMatchObject({ accountId: WORK, pinned: true, pendingAccountId: null });
    expect(routes.get("closed")).toMatchObject({ accountId: HELLO, pinned: false });
    expect(routes.get("there")).toMatchObject({ accountId: HELLO, pinned: false });
  });

  it("moves an agent whose account it can't stay on, as it would with the switch on", async () => {
    const cases: Array<[string, Partial<StoredAccount> | null]> = [
      ["at its limit", { limitedUntil: inFuture(), limitKind: "window" }],
      ["signed out", { signedIn: false }],
      ["disabled", { disabled: true }],
      ["removed", null],
    ];
    for (const [why, work] of cases) {
      const { service, store, paseo, reopened } = await setUpAgents(
        {
          accounts: [
            account(MAIN, "marketing", "main"),
            ...(work ? [{ ...account(WORK, "work", "managed"), ...work }] : []),
            account(HELLO, "hello", "managed"),
          ] as never,
          defaults: { claude: MAIN, codex: null },
          bindings: {},
          sessions: { stuck: session(WORK), fine: session(MAIN) },
        },
        [
          { id: "stuck", status: "idle" },
          { id: "fine", status: "idle" },
        ],
      );
      // Without automatic switching, changing the default is how a stuck agent gets out.
      service.setPreferences({ ...KEEP, autoSwitch: false });
      expect(await service.setDefault(paseo, HELLO), why).toEqual({ ...NOTHING_MOVED, reopened: ["stuck"] });
      expect(reopened, why).toEqual(["stuck"]);
      const state = await store.read();
      expect(state.sessions.stuck?.accountId, why).toBe(HELLO);
      expect(state.bindings.stuck, why).toBeUndefined();
      expect(state.bindings.fine, why).toMatchObject({ accountId: MAIN, source: "auto" });
    }
  });

  it("changes nothing when the account is already the default", async () => {
    const accounts = [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never;
    const agents = [
      { id: "idle", status: "idle" },
      { id: "busy", status: "running" },
    ];
    for (const prefs of [KEEP, preferences.schema.parse({})]) {
      const { service, store, paseo, reopened } = await setUpAgents(
        { accounts, defaults: { claude: WORK, codex: null }, bindings: {}, sessions: { idle: session(WORK), busy: session(WORK) } },
        agents,
      );
      service.setPreferences(prefs);
      expect(await service.setDefault(paseo, WORK)).toEqual(NOTHING_MOVED);
      expect((await store.read()).bindings).toEqual({});
      expect(reopened).toEqual([]);
    }

    // Until another account is chosen, the CLI login is the default.
    const { service, store, paseo, reopened } = await setUpAgents(
      { accounts, defaults: { claude: null, codex: null }, bindings: {}, sessions: { idle: session(MAIN), busy: session(MAIN) } },
      agents,
    );
    expect(await service.setDefault(paseo, MAIN)).toEqual(NOTHING_MOVED);
    const state = await store.read();
    expect(state.defaults.claude).toBe(MAIN);
    expect(state.bindings).toEqual({});
    expect(reopened).toEqual([]);
  });

  it("keeps an agent whose session is still being routed on the account it opens on", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let preparing = false;
    const { service, store, paseo, context, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
      },
      [{ id: "starting", status: "initializing" }],
      {
        claude: {
          prepareHome: async () => {
            if (preparing) return;
            preparing = true;
            await gate;
          },
        },
      },
    );
    // Routed by the old default, but it hasn't recorded where it opens yet.
    const opening = service.onSessionOpen(
      { agentId: "starting", provider: "claude", reason: "create", purpose: "interactive", env: {} } as never,
      context,
    );
    await vi.waitFor(() => expect(preparing).toBe(true));
    // A history session opened for the same agent meanwhile mustn't hide the one still being routed.
    await service.onSessionOpen({ agentId: "starting", provider: "claude", reason: "resume", purpose: "history", env: {} } as never, context);
    const changing = service.setDefault(paseo, HELLO);
    await vi.waitFor(async () => expect((await store.read()).defaults.claude).toBe(HELLO));
    release();
    const [summary, opened] = await Promise.all([changing, opening]);

    expect(opened?.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(tmpdir(), WORK) });
    const state = await store.read();
    expect(state.sessions.starting?.accountId).toBe(WORK);
    expect(state.bindings.starting).toMatchObject({ accountId: WORK, source: "auto" });
    expect(summary.reopened).toEqual([]);
    expect(reopened).toEqual([]);
  });

  it("leaves agents that are only starting now to the new default", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reloading: Promise<unknown> | undefined;
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
        bindings: {},
        sessions: { reloading: session(WORK) },
      },
      [
        { id: "fresh", status: "initializing" }, // listed before Paseo asked the plugin where to open it
        { id: "reloading", status: "idle" },
      ],
      {
        claude: { prepareHome: () => gate },
        // Paseo reloads this one after the default changed, while the open agents are being listed.
        onList: (service, context) => {
          reloading ??= service.onSessionOpen(
            { agentId: "reloading", provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never,
            context,
          );
        },
      },
    );
    expect(await service.setDefault(paseo, HELLO)).toEqual(NOTHING_MOVED);
    release();
    await reloading;
    const state = await store.read();
    expect(state.sessions.reloading?.accountId).toBe(HELLO);
    expect(state.bindings.reloading).toBeUndefined();
    expect(state.bindings.fresh).toBeUndefined();
    expect(reopened).toEqual([]);
  });

  it("keeps open agents on the CLI login when the first default is chosen", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: null, codex: null },
        sessions: { routed: session(MAIN) },
      },
      [
        { id: "routed", status: "idle" },
        { id: "unrouted", status: "running" },
      ],
    );
    await service.setDefault(paseo, HELLO);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO);
    expect(state.bindings.routed).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(state.bindings.unrouted).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(reopened).toEqual([]);
  });

  it("still moves a kept agent when its account hits a limit", async () => {
    const { service, store, reopened, notes, limitTurn } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "You've hit your session limit",
    }));
    service.setPreferences(KEEP);
    await service.setDefault(fakePaseo().paseo as never, HELLO);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: MAIN, source: "auto" });

    await limitTurn();
    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: HELLO, source: "auto" });
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
  });

  it("moves a kept agent to the new default when asked to follow it", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({ kind: "window", resetsAt: inFuture(), message: "" }));
    service.setPreferences(KEEP);
    const paseo = fakePaseo().paseo as never;
    await service.setDefault(paseo, HELLO);
    expect(reopened).toEqual([]);

    await service.setAgentAccount(paseo, AGENT, null); // "Follow default" and `/account default`
    const state = await store.read();
    expect(state.bindings[AGENT]).toBeUndefined();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
  });

  it("pins ChatGPT threads as before, since they can't move either way", async () => {
    const codex = (id: string, label: string, kind: "main" | "managed") => ({ ...account(id, label, kind), family: "codex" });
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [codex(CODEX_MAIN, "chatgpt", "main"), codex("codex-work", "work", "managed")] as never,
        defaults: { claude: null, codex: CODEX_MAIN },
        sessions: { thread: { accountId: CODEX_MAIN, family: "codex", openedAt } },
      },
      [
        { id: "thread", status: "idle", provider: "codex" },
        { id: "archived", status: "closed", provider: "codex", archived: true },
      ],
    );
    await service.setDefault(paseo, "codex-work");
    const { bindings } = await store.read();
    expect(bindings.thread).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(bindings.archived).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(reopened).toEqual([]);
  });
});
