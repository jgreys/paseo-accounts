import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  FAMILIES,
  FAMILY_LABEL,
  fallbackFamilies,
  familyLabel,
  type AccountView,
  type AgentRoute,
  type Family,
  type LoginMethod,
  type LoginView,
  type StateView,
  type Usage,
} from "../shared/model";
import { formatResetIn, peakUsage } from "../shared/format";
import { DEFAULT_CONTINUE_PROMPT, type Preferences } from "../shared/preferences";
import type { RedeemResult, ReopenSummary } from "../shared/rpc";
import { SWITCH_ROW_KIND, SWITCH_ROW_VERSION, type SwitchRow } from "../shared/timeline";
import {
  applyEnv,
  type AgentTimelineItem,
  type FamilyAdapter,
  type Identity,
  type LimitHit,
  type LimitKind,
  type LoginHandle,
  type RedeemReply,
  type UsageRead,
} from "./adapter";
import { ActivityLog } from "./activity";
import { sendAlert } from "./alerts";
import { accountForecast, hostTimeZone, hostWhen, loadHistory, record, saveHistory, trend, type History } from "./history";
import { FamilyResolver } from "./families";
import { CONTINUED_FROM_LABEL, continueInNewAgent, type Continuation } from "./handoff";
import { removeHome } from "./homes";
import { Mutex } from "./json-file";
import { canSignInWithBrowser } from "./machine";
import { equivalentMode } from "./modes";
import { homesDir } from "./paths";
import { Reopener } from "./reopen";
import { SwitchGuard } from "./switch-guard";
import { loadReadings, mergeUsage, saveReadings, showLimit } from "./usage";
import { chooseAccount, dedicatedElsewhere, folderAccount, isLimited, isUsable, mostAvailable, type PickOptions } from "./routing";
import {
  MAIN_ACCOUNT_ID,
  StateStore,
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type FolderRule,
  type StoredAccount,
  type StoredState,
} from "./state";

type PaseoApi = PluginHookContext["paseo"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

const PROVIDER_NAME: Record<Family, string> = { claude: "Claude Code", codex: "Codex", copilot: "Copilot CLI", kimi: "Kimi Code", opencode: "OpenCode", pi: "Pi", omp: "Oh My Pi" };
/** How often to read usage: accounts in use, the defaults, and the rest. Adapters space reads further. */
const USAGE_BUSY_MS = 60_000;
const USAGE_DEFAULT_MS = 5 * 60_000;
const USAGE_IDLE_MS = 20 * 60_000;
/** An account counts as in use for this long after one of its agents starts or ends a turn. */
const ACTIVE_WINDOW_MS = 15 * 60_000;
const UPKEEP_MS = 30_000;
const IDENTITY_MS = 30 * 60_000;
const AVAILABILITY_MS = 10 * 60_000;
/** Assumed length of a window limit whose reset time couldn't be read. */
const WINDOW_LIMIT_MS = 60 * 60_000;
/** Budget limits (spend caps, credits) don't show in usage; retry after this long. */
const BUDGET_LIMIT_MS = 3 * 60 * 60_000;
/** A fresh limit isn't second-guessed by usage readings for this long. */
const LIMIT_TRUST_MS = 15 * 60_000;
const LOGIN_TTL_MS = 15 * 60_000;
const LOGIN_GRACE_MS = 3_000;
const PRUNE_MS = 10 * 60_000;
/** After a reset, limit notices from turns that were already running are stale. */
const RESET_GRACE_MS = 5 * 60_000;
const AGENT_LIST_MS = 3_000;
/** How long a default change waits for sessions already being routed to record their account. */
const ROUTING_WAIT_MS = 5_000;

const DEFAULT_PREFERENCES: Preferences = {
  autoSwitch: true,
  autoContinue: true,
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
  moveAgentsOnDefaultChange: true,
  balanceNewAgents: false,
  showComposerPill: true,
  autoRedeem: false,
  forkOtherProvider: false,
  switchAt: 92,
  pacing: true,
  alertUrl: "",
};
/** How long after a switch to check the agent really came back. */
const CHECK_BACK_MS = 8_000;
/** The same alert (one provider out, one account signed out, one agent stuck) at most this often. */
const ALERT_REPEAT_MS = 30 * 60_000;

interface LoginSession {
  id: string;
  family: Family;
  /** Existing account being signed back in. */
  accountId: string | null;
  /** Where the CLI writes credentials; null for the CLI's own login. */
  home: string | null;
  handle: LoginHandle | null;
  view: LoginView;
  finishedAt: number | null;
}

interface AgentInfo {
  id: string;
  provider: string;
  status: string;
  archived: boolean;
  /** The conversation has started (so a Codex thread already holds account-bound reasoning). */
  hasHistory: boolean;
  title: string | null;
  cwd: string | null;
  /** The agent this one carries on from, when the plugin started it as a continuation. */
  continuedFrom: string | null;
}

type ReopenOutcome = "reopened" | "deferred" | "closed" | "failed";
type Problem = { kind: "limit"; hit: LimitHit } | { kind: "signed_out" };

/** The agent has a running CLI session (idle between turns counts). */
function isLive(status: string): boolean {
  return status === "idle" || status === "running" || status === "initializing";
}

function emptySummary(): ReopenSummary {
  return { reopened: [], deferred: [], failed: [], continuedIn: null };
}

export class Service {
  private paseo: PaseoApi | null = null;
  private prefs: Preferences = DEFAULT_PREFERENCES;
  private readonly usage = new Map<string, Usage>();
  private readonly usageAttemptAt = new Map<string, number>();
  private readonly usageInFlight = new Map<string, Promise<void>>();
  private readonly identityCheckedAt = new Map<string, number>();
  private readonly availability = new Map<Family, { ok: boolean; detail: string | null; at: number }>();
  private readonly logins = new Map<string, LoginSession>();
  private readonly loginLocks = Object.fromEntries(FAMILIES.map((family) => [family, new Mutex()])) as Record<Family, Mutex>;
  /** Agents whose account changed mid-turn; reopened when the turn ends. */
  private readonly deferred = new Map<string, SwitchRow | null>();
  /** Agents in the middle of a failover, so nothing else moves them at the same time. */
  private readonly switching = new Set<string>();
  /** Interactive sessions being routed right now, and their agents. Where each opens isn't recorded yet. */
  private readonly routing = new Map<Promise<unknown>, string>();
  /** One failover at a time per exhausted account. */
  private readonly failoverLocks = new Map<string, Mutex>();
  private readonly switchGuard = new SwitchGuard();
  /** When the guard last told an agent's timeline it stopped switching, so it says so once. */
  private readonly guardNoticeAt = new Map<string, number>();
  private readonly alertedAt = new Map<string, number>();
  private history: History = {};
  private readonly activity = new ActivityLog();
  /** When each account's agents last started or ended a turn, to read busy accounts often. */
  private readonly activeAt = new Map<string, number>();
  /** The provider asked us not to read this account's usage again before then. */
  private readonly usageRetryAt = new Map<string, number>();
  private usageSave: ReturnType<typeof setTimeout> | null = null;
  private readonly lastRedeemAt = new Map<string, number>();
  private readonly redeemLocks = new Map<string, Mutex>();
  private readonly browserSignIn = canSignInWithBrowser();
  private agentCache: { at: number; agents: Promise<AgentInfo[]> } | null = null;
  private lastPrune = 0;
  private collecting = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(
    private readonly adapters: Record<Family, FamilyAdapter>,
    private readonly store = new StateStore(),
    private readonly families = new FamilyResolver(),
    private readonly reopener = new Reopener(),
  ) {}

  setPreferences(prefs: Preferences): void {
    this.prefs = prefs;
  }

  /** Remember the plugin's SDK connection for background work (cleanup, failover). */
  attach(paseo: PaseoApi): void {
    this.paseo ??= paseo;
  }

  async start(): Promise<void> {
    // The last readings show right away; fresh ones replace them as they arrive.
    for (const [accountId, reading] of await loadReadings()) if (!this.usage.has(accountId)) this.usage.set(accountId, reading);
    this.history = await loadHistory().catch(() => ({}));
    await Promise.all(FAMILIES.map((family) => this.ensureFamily(family)));
    this.timer = setInterval(() => void this.tick().catch((error: unknown) => log("upkeep failed", error)), UPKEEP_MS);
    this.timer.unref?.();
    void this.tick().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.usageSave) {
      clearTimeout(this.usageSave);
      await saveReadings(this.usage).catch(() => undefined);
    }
    for (const login of this.logins.values()) login.handle?.cancel();
  }

  // ------------------------------------------------------------------ upkeep

  /** Checks the CLI is installed and registers its own login as an account. */
  private async ensureFamily(family: Family): Promise<void> {
    const adapter = this.adapters[family];
    const availability = await adapter.available().catch((error: unknown) => ({ ok: false, detail: describe(error) }));
    this.availability.set(family, { ...availability, at: Date.now() });
    if (!availability.ok) return;
    const identity = await adapter.identity(null).catch(() => null);
    this.identityCheckedAt.set(MAIN_ACCOUNT_ID[family], Date.now());
    await this.store.update((draft) => {
      let main = findAccount(draft, MAIN_ACCOUNT_ID[family]);
      if (!main) {
        main = newAccount({ id: MAIN_ACCOUNT_ID[family], family, kind: "main", home: null });
        main.signedIn = false;
        draft.accounts.unshift(main);
      }
      if (identity) applyIdentity(main, identity, draft);
      if (!main.label) main.label = `${FAMILY_LABEL[family]} (CLI login)`;
    });
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const now = Date.now();
    for (const family of FAMILIES) {
      const availability = this.availability.get(family);
      if (availability && !availability.ok && now - availability.at > AVAILABILITY_MS) {
        void this.ensureFamily(family).catch(() => undefined);
      }
    }
    const state = await this.store.read();
    for (const account of state.accounts) {
      const attempted = this.usageAttemptAt.get(account.id) ?? 0;
      const busy = now - (this.activeAt.get(account.id) ?? 0) < ACTIVE_WINDOW_MS;
      const isDefault = defaultAccount(state, account.family)?.id === account.id;
      const every = account.disabled ? USAGE_IDLE_MS : busy ? USAGE_BUSY_MS : isDefault ? USAGE_DEFAULT_MS : USAGE_IDLE_MS;
      if (account.signedIn && now - attempted > every) {
        void this.refreshUsage(account.id).catch((error: unknown) => log(`usage refresh for ${account.label} failed`, error));
      }
      if (now - (this.identityCheckedAt.get(account.id) ?? 0) > IDENTITY_MS) {
        void this.refreshIdentity(account.id).catch(() => undefined);
      }
    }
    for (const [id, login] of this.logins) {
      if (login.finishedAt && now - login.finishedAt > LOGIN_TTL_MS) this.logins.delete(id);
      else if (!login.finishedAt && now - Date.parse(login.view.startedAt) > LOGIN_TTL_MS) void this.cancelLogin(id);
    }
    if (this.paseo) await this.collectOrphanHomes(this.paseo);
  }

  private async refreshIdentity(accountId: string): Promise<void> {
    this.identityCheckedAt.set(accountId, Date.now());
    const account = findAccount(await this.store.read(), accountId);
    if (!account) return;
    const identity = await this.adapters[account.family].identity(account.home).catch(() => null);
    if (!identity) return;
    await this.store.update((draft) => {
      const target = findAccount(draft, accountId);
      if (target) applyIdentity(target, identity, draft);
    });
  }

  /** Forget bindings and sessions of agents that no longer exist (including Paseo's internal helpers). */
  private async prune(paseo: PaseoApi): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_MS) return;
    this.lastPrune = now;
    const { agents, complete } = await listAgents(paseo, true);
    if (!complete) return; // Can't tell "gone" from "not listed".
    const known = new Set(agents.map((agent) => agent.id));
    const state = await this.store.read();
    const old = (at: string) => now - (Date.parse(at) || 0) > PRUNE_MS;
    const staleSessions = Object.entries(state.sessions).filter(([id, session]) => !known.has(id) && old(session.openedAt));
    const staleBindings = Object.entries(state.bindings).filter(([id, binding]) => !known.has(id) && old(binding.at));
    if (staleSessions.length === 0 && staleBindings.length === 0) return;
    await this.store.update((draft) => {
      for (const [id] of staleSessions) delete draft.sessions[id];
      for (const [id] of staleBindings) delete draft.bindings[id];
    });
  }

  /**
   * Signs out and deletes managed homes no account owns any more — removed accounts, and abandoned
   * or failed sign-ins — once no live agent session still runs on them.
   */
  private async collectOrphanHomes(paseo: PaseoApi): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;
    try {
      const root = homesDir();
      const names = await readdir(root).catch(() => [] as string[]);
      if (names.length === 0) return;
      const state = await this.store.read();
      const owned = new Set(state.accounts.map((account) => account.home).filter((home): home is string => Boolean(home)));
      for (const login of this.logins.values()) {
        const active = !login.finishedAt || Date.now() - login.finishedAt < LOGIN_GRACE_MS;
        if (active && login.home) owned.add(login.home);
      }
      for (const name of names) {
        const home = join(root, name);
        const family = FAMILIES.find((candidate) => name.startsWith(`${candidate}-`)) ?? null;
        if (!family || owned.has(home)) continue;
        // A managed account's ID is its home's folder name, so sessions still name it after removal.
        const users = Object.entries(state.sessions)
          .filter(([, session]) => session.accountId === name)
          .map(([agentId]) => agentId);
        let live = false;
        for (const agentId of users) {
          const info = await agentInfo(paseo, agentId);
          if (info && !info.archived && info.status !== "closed") {
            live = true;
            break;
          }
        }
        if (live) continue;
        await this.adapters[family].logout(home).catch((error: unknown) => log(`signing out ${name} failed`, error));
        await removeHome(home);
        if (users.length > 0) {
          await this.store.update((draft) => {
            for (const agentId of users) if (draft.sessions[agentId]?.accountId === name) delete draft.sessions[agentId];
          });
        }
        console.log(`[paseo-accounts] removed the unused account home ${name}`);
      }
    } finally {
      this.collecting = false;
    }
  }

  private scheduleCleanup(): void {
    const paseo = this.paseo;
    if (!paseo) return;
    setTimeout(
      () => void this.collectOrphanHomes(paseo).catch((error: unknown) => log("cleanup failed", error)),
      LOGIN_GRACE_MS + 500,
    ).unref?.();
  }

  // ------------------------------------------------------------------ hooks

  /** Routes every provider session (create, resume, refresh, import) to the agent's account. */
  async onSessionOpen(
    request: PluginSessionOpenRequest,
    context: PluginHookContext,
  ): Promise<PluginSessionOpenRequest | undefined> {
    const routed = this.route(request, context);
    if (request.purpose !== "interactive") return routed;
    this.routing.set(routed, request.agentId);
    try {
      return await routed;
    } finally {
      this.routing.delete(routed);
    }
  }

  private async route(
    request: PluginSessionOpenRequest,
    context: PluginHookContext,
  ): Promise<PluginSessionOpenRequest | undefined> {
    this.attach(context.paseo);
    const family = (await this.families.resolve(context.paseo))[request.provider];
    if (!family) return undefined;
    const adapter = this.adapters[family];
    const now = Date.now();
    const state = await this.store.read();
    const decision = chooseAccount(state, {
      agentId: request.agentId,
      family,
      cwd: request.cwd,
      reason: request.reason,
      now,
      autoSwitch: this.prefs.autoSwitch,
      balanceNewAgents: this.prefs.balanceNewAgents,
      portable: adapter.portable,
      usageOf: (id) => this.usage.get(id),
      pick: this.pickOptions,
    });
    if (!decision) return undefined;
    const { account } = decision;

    if (account.kind === "managed" && account.home) {
      await adapter.prepareHome(account.home).catch((error: unknown) => log(`could not refresh the home of ${account.label}`, error));
    }
    const interactive = request.purpose === "interactive";
    const seenBinding = state.bindings[request.agentId]?.accountId;
    const bindingChanged = decision.bind !== null && seenBinding !== decision.bind.accountId;
    const recorded = state.sessions[request.agentId];
    const sessionChanged = interactive && (recorded?.accountId !== account.id || recorded?.cwd !== request.cwd);
    if (bindingChanged || sessionChanged) {
      await this.store.update((draft) => {
        // Don't overwrite a choice the user made while this decision was being taken.
        if (decision.bind && bindingChanged && draft.bindings[request.agentId]?.accountId === seenBinding) {
          draft.bindings[request.agentId] = decision.bind;
        }
        if (interactive) {
          draft.sessions[request.agentId] = { accountId: account.id, family, openedAt: new Date(now).toISOString(), cwd: request.cwd };
        }
      });
    }
    // A fresh session already runs on the routed account, so any pending switch is done.
    if (interactive) this.deferred.delete(request.agentId);
    this.activeAt.set(account.id, now);
    console.log(
      `[paseo-accounts] ${request.provider} agent ${request.agentId} → ${account.label} (${request.reason}${
        decision.skipped ? `; skipped ${decision.skipped.account.label}: ${decision.skipped.why}` : ""
      })`,
    );
    return { ...request, env: applyEnv(await adapter.env(account.home), request.env) };
  }

  /** A turn uses the account from its first token, so a long one keeps its usage fresh too. */
  async onTurnStarted(agent: { id: string; provider: string }, context: PluginHookContext): Promise<void> {
    this.attach(context.paseo);
    const family = (await this.families.resolve(context.paseo))[agent.provider];
    if (!family) return;
    const accountId = this.runningOn(await this.store.read(), agent.id, family);
    if (accountId) this.activeAt.set(accountId, Date.now());
  }

  async onTurnEnded(event: TurnEnded, context: PluginHookContext): Promise<void> {
    this.attach(context.paseo);
    const family = (await this.families.resolve(context.paseo))[event.agent.provider];
    if (!family) return;
    const adapter = this.adapters[family];
    const agentId = event.agent.id;
    const accountId = this.runningOn(await this.store.read(), agentId, family);
    if (accountId) this.activeAt.set(accountId, Date.now());
    if (event.outcome.kind !== "canceled") {
      const hit = adapter.detectLimit(event);
      if (hit) return this.handleUnavailable(context.paseo, agentId, family, event.timeline, { kind: "limit", hit });
      if (adapter.detectSignOut(event) && (await this.confirmSignedOut(agentId, family))) {
        return this.handleUnavailable(context.paseo, agentId, family, event.timeline, { kind: "signed_out" });
      }
    }
    if (this.deferred.has(agentId)) await this.finishDeferred(context.paseo, agentId, family);
    else if (accountId && event.outcome.kind === "completed") await this.switchEarly(context.paseo, agentId, family, accountId);
    // The turn just used the account: read its usage again as soon as the provider allows.
    if (accountId) void this.refreshUsage(accountId).catch(() => undefined);
  }

  async onAgentArchived(agentId: string): Promise<void> {
    this.deferred.delete(agentId);
    this.switchGuard.forget(agentId);
    this.guardNoticeAt.delete(agentId);
    if (!(await this.store.read()).sessions[agentId]) return;
    await this.store.update((draft) => {
      delete draft.sessions[agentId];
    });
  }

  /** Re-checks the account an agent was using; true when it really is signed out now. */
  private async confirmSignedOut(agentId: string, family: Family): Promise<boolean> {
    const state = await this.store.read();
    const accountId = this.runningOn(state, agentId, family);
    if (!accountId) return false;
    await this.refreshIdentity(accountId);
    return findAccount(await this.store.read(), accountId)?.signedIn === false;
  }

  /** Carries out a switch that waited for the agent's turn to end, unless it's no longer wanted. */
  private async finishDeferred(paseo: PaseoApi, agentId: string, family: Family): Promise<void> {
    const row = this.deferred.get(agentId) ?? null;
    this.deferred.delete(agentId);
    const state = await this.store.read();
    const current = this.runningOn(state, agentId, family);
    if (!current || this.targetFor(state, agentId, family) === current) return; // Switched back meanwhile.
    const outcome = await this.reopenAgent(paseo, agentId, row, true);
    if (outcome === "reopened" && row) await this.appendRow(paseo, agentId, await this.landed(row, agentId));
  }

  // ------------------------------------------------------------------ limits and failover

  private lockFor(accountId: string): Mutex {
    let lock = this.failoverLocks.get(accountId);
    if (!lock) this.failoverLocks.set(accountId, (lock = new Mutex()));
    return lock;
  }

  private async handleUnavailable(
    paseo: PaseoApi,
    agentId: string,
    family: Family,
    timeline: readonly AgentTimelineItem[],
    problem: Problem,
  ): Promise<void> {
    if (this.switching.has(agentId)) return;
    this.switching.add(agentId);
    let exhausted: string | null = null;
    try {
      const state = await this.store.read();
      const account = findAccount(state, this.runningOn(state, agentId, family));
      if (!account) return;
      exhausted = account.id;
      await this.lockFor(account.id).run(() => this.failover(paseo, agentId, family, account, timeline, problem));
    } finally {
      this.switching.delete(agentId);
    }
    if (exhausted && this.prefs.autoSwitch && this.adapters[family].portable) {
      void this.moveIdleAgentsOff(paseo, exhausted, family, agentId, problem.kind).catch((error: unknown) =>
        log("moving idle agents failed", error),
      );
    }
  }

  private async failover(
    paseo: PaseoApi,
    agentId: string,
    family: Family,
    account: StoredAccount,
    timeline: readonly AgentTimelineItem[],
    problem: Problem,
  ): Promise<void> {
    const adapter = this.adapters[family];
    const now = Date.now();
    if (problem.kind === "limit" && problem.hit.kind === "window" && this.recentlyRedeemed(account.id)) {
      // This turn hit the limit just before a reset refilled it (another agent's failover or the
      // user spent one moments ago). The account has room again: carry on instead of switching.
      console.log(`[paseo-accounts] ${account.label} was just reset; ${agentId} carries on where it is`);
      if (this.prefs.autoContinue && this.switchGuard.allows(agentId, now)) {
        this.switchGuard.note(agentId, now);
        await paseo.agents
          .ref(agentId)
          .send(this.prefs.continuePrompt)
          .catch((error: unknown) => log(`could not continue ${agentId}`, error));
      }
      return;
    }
    let resetsAt: string | null = null;
    if (problem.kind === "limit") {
      const { hit } = problem;
      resetsAt = hit.resetsAt ?? new Date(now + (hit.kind === "budget" ? BUDGET_LIMIT_MS : WINDOW_LIMIT_MS)).toISOString();
      await this.markLimited(account.id, resetsAt, hit.kind);
      if (hit.kind === "window") {
        // The notice is the freshest word on usage: show that window full until a new reading lands.
        const shown = this.usage.get(account.id);
        if (shown) this.setUsage(account.id, showLimit(shown, hit.resetsAt));
        // The account was just used, so its token is fresh: ask for the exact reset time.
        await withTimeout(this.refreshUsage(account.id, true), 12_000);
        const exact = this.resetFromUsage(account.id);
        if (exact && Date.parse(exact) > now) {
          resetsAt = exact;
          await this.markLimited(account.id, exact, "window");
        }
      }
      console.log(`[paseo-accounts] ${account.label} hit a ${hit.kind} limit (agent ${agentId}): ${hit.message}`);
    } else {
      console.log(`[paseo-accounts] ${account.label} is signed out (agent ${agentId})`);
      this.alert(`signed_out:${account.id}`, `${account.label} is signed out`, `Sign it in again from Accounts. Its agents move to your other ${FAMILY_LABEL[family]} accounts meanwhile.`);
    }

    if (!this.prefs.autoSwitch) return;
    const latest = await this.store.read();
    if (this.runningOn(latest, agentId, family) !== account.id) return; // Already moved.
    const base = {
      family,
      from: account.label,
      resetsAt,
      continued: false,
      continuedIn: null,
      toFamily: null,
      detail: null,
      at: new Date(now).toISOString(),
    };
    const reason = problem.kind;
    if (!this.switchGuard.allows(agentId, now)) {
      console.warn(`[paseo-accounts] not switching ${agentId} again: it changed accounts ${this.switchGuard.limit} times in 10 minutes`);
      // Say so once, so the user knows to pick an account rather than wait.
      if (now - (this.guardNoticeAt.get(agentId) ?? 0) > this.switchGuard.windowMs) {
        this.guardNoticeAt.set(agentId, now);
        await this.appendRow(paseo, agentId, {
          ...base,
          to: account.label,
          reason,
          outcome: "stayed",
          detail: `It changed accounts ${this.switchGuard.limit} times in 10 minutes, so it stopped switching it for now. Pick an account from the account button to carry on.`,
        });
      }
      return;
    }
    const reserved = dedicatedElsewhere(latest, latest.sessions[agentId]?.cwd);
    const next = this.pick(latest, family, now, new Set([...reserved, account.id]));
    if (!next) {
      if (problem.kind === "limit" && problem.hit.kind === "window" && this.prefs.autoRedeem && !account.disabled) {
        // Opt-in: every account is out, so spend a banked reset rather than stop.
        const reply = await this.redeemOn(account, true);
        if (reply.outcome === "reset") {
          this.switchGuard.note(agentId, now);
          const continued = this.prefs.autoContinue;
          await this.appendRow(paseo, agentId, {
            ...base,
            to: account.label,
            reason: "limit",
            continued,
            outcome: "reset",
            detail: reply.message,
          });
          if (continued) {
            await paseo.agents
              .ref(agentId)
              .send(this.prefs.continuePrompt)
              .catch((error: unknown) => log(`could not continue ${agentId}`, error));
          }
          return;
        }
        if (reply.outcome === "not_limited") {
          // Refilled since this turn stopped (another host sharing the account, or the user, spent
          // a reset), so carry on here without spending a second one.
          console.log(`[paseo-accounts] ${account.label} has room again; ${agentId} carries on where it is`);
          this.switchGuard.note(agentId, now);
          await this.afterReset(account.id, reply.left);
          if (this.prefs.autoContinue) {
            await paseo.agents
              .ref(agentId)
              .send(this.prefs.continuePrompt)
              .catch((error: unknown) => log(`could not continue ${agentId}`, error));
          }
          return;
        }
        console.log(`[paseo-accounts] no automatic reset for ${account.label}: ${reply.message}`);
      }
      if (reason !== "limit") return;
      let detail: string | null = null;
      if (this.prefs.forkOtherProvider) {
        // Opt-in: every account of this provider is out, so carry on with another provider.
        const result = await this.forkToAnotherProvider(paseo, agentId, family, timeline, "auto").catch((error: unknown) => ({
          skipped: `Couldn't continue on another provider: ${describe(error)}`,
        }));
        if ("fork" in result) {
          this.switchGuard.note(agentId, now);
          await this.appendRow(paseo, agentId, {
            ...base,
            to: result.to,
            toFamily: result.toFamily,
            reason: "exhausted",
            continued: true,
            continuedIn: result.fork,
            outcome: "continued",
          });
          return;
        }
        console.log(`[paseo-accounts] not continuing ${agentId} on another provider: ${result.skipped}`);
        detail = result.skipped;
      } else {
        const options = fallbackFamilies(family).filter((candidate) => this.pick(latest, candidate, now));
        if (options.length > 0) {
          const names = options.map((candidate) => FAMILY_LABEL[candidate]).join(" or ");
          detail = `Or continue on ${names} in a new agent from the account button.`;
        }
      }
      await this.appendRow(paseo, agentId, { ...base, to: account.label, reason: "exhausted", outcome: "stayed", detail });
      const back = resetsAt ? ` The first one frees up ${formatResetIn(resetsAt) ?? "later"}.` : "";
      this.alert(`exhausted:${family}`, `Every ${FAMILY_LABEL[family]} account is out`, `An agent stopped because no ${FAMILY_LABEL[family]} account has room left.${back}`);
      return;
    }

    if (adapter.portable) {
      await this.store.update((draft) => {
        draft.bindings[agentId] = { accountId: next.id, source: "auto", at: new Date(now).toISOString() };
      });
      this.switchGuard.note(agentId, now);
      const outcome = await this.reopenAgent(paseo, agentId, null, true);
      if (outcome === "reopened") void this.checkBack(paseo, agentId, next.label);
      else if (outcome === "failed") this.alert(`failed:${agentId}`, "An agent couldn't change accounts", `It stays stopped on ${account.label}. Open it and reload it, or pick an account from its account button.`);
      const continued = outcome === "reopened" && this.prefs.autoContinue;
      const row = await this.landed(
        { ...base, to: next.label, reason, continued, outcome: outcome === "reopened" ? "switched" : "pending" },
        agentId,
      );
      await this.appendRow(paseo, agentId, row);
      if (continued) {
        await paseo.agents
          .ref(agentId)
          .send(this.prefs.continuePrompt)
          .catch((error: unknown) => log(`could not continue ${agentId}`, error));
      }
      return;
    }

    // A ChatGPT thread can't move to another account; carry the work on in a new agent there.
    if (!this.prefs.autoContinue) {
      await this.appendRow(paseo, agentId, {
        ...base,
        to: next.label,
        reason,
        outcome: "stayed",
        detail: `New ChatGPT agents will use ${next.label}.`,
      });
      return;
    }
    const why =
      reason === "limit"
        ? `its ChatGPT account (${account.label}) reached its usage limit`
        : `its ChatGPT account (${account.label}) was signed out`;
    try {
      const continuation = await this.continueElsewhere(paseo, agentId, next, why, timeline, "auto");
      this.switchGuard.note(agentId, now);
      await this.appendRow(paseo, agentId, {
        ...base,
        to: next.label,
        reason,
        continued: true,
        continuedIn: continuation,
        outcome: "continued",
      });
    } catch (error) {
      log(`could not continue ${agentId} on ${next.label}`, error);
      await this.appendRow(paseo, agentId, {
        ...base,
        to: next.label,
        reason,
        outcome: "stayed",
        detail: `Couldn't start a new agent on ${next.label}: ${describe(error)}`,
      });
    }
  }

  /**
   * Moves an agent whose turn just ended off an account that's nearly full, so its next turn starts
   * somewhere with room instead of hitting the limit halfway. Only conversations that can move in
   * place are moved, only to an account that is itself below the line, and never back and forth.
   */
  private async switchEarly(paseo: PaseoApi, agentId: string, family: Family, accountId: string): Promise<void> {
    const line = this.prefs.switchAt;
    if (!this.prefs.autoSwitch || line >= 100 || !this.adapters[family].portable || this.switching.has(agentId)) return;
    const fullness = (id: string) => peakUsage(this.usage.get(id)?.windows ?? [])?.usedPercent ?? null;
    const used = fullness(accountId);
    if (used === null || used < line) return;
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    const now = Date.now();
    if (!account || !this.switchGuard.allows(agentId, now)) return;
    const binding = state.bindings[agentId];
    if (binding?.source === "user") return; // Chosen on purpose: leave it until it actually runs out.
    const reserved = dedicatedElsewhere(state, state.sessions[agentId]?.cwd);
    const next = this.pick(state, family, now, new Set([...reserved, accountId]));
    const nextUsed = next ? fullness(next.id) : null;
    if (!next || (nextUsed !== null && nextUsed >= line)) return;
    this.switching.add(agentId);
    try {
      console.log(`[paseo-accounts] ${account.label} is ${Math.round(used)}% used; moving ${agentId} to ${next.label} before it runs out`);
      await this.store.update((draft) => {
        draft.bindings[agentId] = { accountId: next.id, source: "auto", at: new Date(now).toISOString() };
      });
      this.switchGuard.note(agentId, now);
      const outcome = await this.reopenAgent(paseo, agentId, null, true);
      if (outcome === "reopened") void this.checkBack(paseo, agentId, next.label);
      const row = await this.landed(
        {
          family,
          from: account.label,
          to: next.label,
          reason: "early",
          resetsAt: null,
          continued: false,
          continuedIn: null,
          toFamily: null,
          outcome: outcome === "reopened" ? "switched" : "pending",
          detail: null,
          at: new Date(now).toISOString(),
        },
        agentId,
      );
      await this.appendRow(paseo, agentId, row);
    } finally {
      this.switching.delete(agentId);
    }
  }

  /**
   * A reload can report success while the session still fails to start (the agent sits stopped
   * with an error). Look again shortly after a switch; retry once, then say so.
   */
  private async checkBack(paseo: PaseoApi, agentId: string, label: string): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await delay(CHECK_BACK_MS);
      const info = await agentInfo(paseo, agentId);
      if (!info || info.archived || info.status !== "error") return;
      if (attempt === 0) {
        console.warn(`[paseo-accounts] ${agentId} is stopped with an error after moving to ${label}; reloading it again`);
        await this.reopener.reopen(agentId);
      }
    }
    console.warn(`[paseo-accounts] ${agentId} is still stopped after moving to ${label}`);
    this.alert(`failed:${agentId}`, "An agent didn't restart after switching", `It moved to ${label} but is stopped with an error. Open it and reload it.`);
  }

  /** Sends an alert to the configured URL, at most once per `key` every while. Never throws. */
  private alert(key: string, title: string, message: string): void {
    const url = this.prefs.alertUrl;
    const now = Date.now();
    if (!url || now - (this.alertedAt.get(key) ?? 0) < ALERT_REPEAT_MS) return;
    this.alertedAt.set(key, now);
    void sendAlert(url, title, message).catch((error: unknown) => log("could not send an alert", error));
  }

  /** The forecast and week's trend shown for an account. */
  private forecastOf(accountId: string): Pick<AccountView, "forecast" | "trend"> {
    const usage = this.usage.get(accountId);
    const windows = this.history[accountId];
    const forecast = accountForecast(usage, windows);
    const shown = forecast?.windowId ?? (usage ? peakUsage(usage.windows)?.id : undefined);
    return {
      forecast: forecast
        ? {
            windowLabel: forecast.windowLabel,
            runsOutAt: forecast.runsOutAt,
            resetsAt: forecast.resetsAt,
            runsOutText: hostWhen(forecast.runsOutAt),
            resetsText: hostWhen(forecast.resetsAt),
          }
        : null,
      trend: shown ? trend(windows?.[shown]) : [],
    };
  }

  /** How automatic picks rank accounts: nearly full ones last, then priority, then pace or room. */
  private get pickOptions(): PickOptions {
    return { fullAt: this.prefs.autoSwitch ? this.prefs.switchAt : 100, pace: this.prefs.pacing };
  }

  /** The account an automatic pick lands on, skipping `exclude`. */
  private pick(state: StoredState, family: Family, now: number, exclude: ReadonlySet<string> = new Set()): StoredAccount | undefined {
    return mostAvailable(state, family, (id) => this.usage.get(id), now, exclude, this.pickOptions);
  }

  async setPriority(accountId: string, priority: StoredAccount["priority"]): Promise<void> {
    const state = await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (account) account.priority = priority;
    });
    if (!findAccount(state, accountId)) throw new Error("That account no longer exists.");
  }

  private async markLimited(accountId: string, until: string, kind: LimitKind): Promise<void> {
    await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      account.limitedUntil = until;
      account.limitKind = kind;
      account.limitedAt = new Date().toISOString();
    });
  }

  // ------------------------------------------------------------------ banked resets

  private recentlyRedeemed(accountId: string): boolean {
    return Date.now() - (this.lastRedeemAt.get(accountId) ?? 0) < RESET_GRACE_MS;
  }

  /**
   * Spends one banked reset on `account`, one attempt at a time per account. `automatic` use shares
   * a reset this host just spent across concurrent failovers, and spends one only while the provider
   * still sees the limit, so hosts sharing the account can't spend two on the same limit.
   */
  private redeemOn(account: StoredAccount, automatic: boolean): Promise<RedeemReply> {
    let lock = this.redeemLocks.get(account.id);
    if (!lock) this.redeemLocks.set(account.id, (lock = new Mutex()));
    return lock.run(async () => {
      if (automatic && this.recentlyRedeemed(account.id)) {
        return { outcome: "reset", message: "A reset was just used on this account.", left: null };
      }
      const reply = await this.adapters[account.family]
        .redeemReset(account.home, { onlyAtLimit: automatic })
        .catch((error: unknown): RedeemReply => ({ outcome: "error", message: describe(error), left: null }));
      console.log(`[paseo-accounts] banked reset on ${account.label}: ${reply.outcome}`);
      if (reply.outcome === "reset") {
        this.lastRedeemAt.set(account.id, Date.now());
        await this.afterReset(account.id, reply.left);
      } else if (reply.left !== null) {
        this.updateResetCount(account.id, reply.left);
      }
      return reply;
    });
  }

  private async afterReset(accountId: string, left: number | null): Promise<void> {
    await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      account.limitedUntil = null;
      account.limitKind = null;
    });
    if (left !== null) this.updateResetCount(accountId, left);
    // Give the provider a moment to settle before reading the refilled usage.
    setTimeout(() => {
      this.usageAttemptAt.delete(accountId);
      void this.refreshUsage(accountId, true).catch(() => undefined);
    }, 5_000).unref?.();
  }

  private updateResetCount(accountId: string, left: number): void {
    const usage = this.usage.get(accountId);
    if (!usage?.resets) return;
    this.setUsage(accountId, { ...usage, resets: left > 0 ? { ...usage.resets, available: left } : null });
  }

  /** A user-requested reset, optionally resuming the agent that was stopped by the limit. */
  async redeem(paseo: PaseoApi, accountId: string, agentId?: string): Promise<RedeemResult> {
    this.attach(paseo);
    const account = findAccount(await this.store.read(), accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (!account.signedIn) throw new Error(`${account.label} is signed out. Sign it in first.`);
    const reply = await this.redeemOn(account, false);
    let continued = false;
    if (reply.outcome === "reset" && agentId) {
      continued = await this.continueAfterReset(paseo, agentId, account, reply.message).catch(() => false);
    }
    return { ...reply, continued };
  }

  private async continueAfterReset(paseo: PaseoApi, agentId: string, account: StoredAccount, detail: string): Promise<boolean> {
    if (!this.prefs.autoContinue) return false;
    const info = await agentInfo(paseo, agentId);
    if (!info || info.archived || info.status !== "idle") return false;
    if (this.runningOn(await this.store.read(), agentId, account.family) !== account.id) return false;
    // Only resume an agent that this limit actually stopped.
    if (!(await this.lastTurnHitLimit(paseo, agentId, account.family))) return false;
    const at = new Date().toISOString();
    await this.appendRow(paseo, agentId, {
      family: account.family,
      from: account.label,
      to: account.label,
      reason: "limit",
      resetsAt: null,
      continued: true,
      continuedIn: null,
      toFamily: null,
      outcome: "reset",
      detail,
      at,
    });
    await paseo.agents.ref(agentId).send(this.prefs.continuePrompt);
    return true;
  }

  /**
   * The account an agent's live session really runs on. the plugin records every session it routes; one
   * it never routed (opened before the plugin was installed, or while it was stopped) has no account
   * override, so it runs on the CLI login.
   */
  private runningOn(state: StoredState, agentId: string, family: Family): string | undefined {
    return state.sessions[agentId]?.accountId ?? mainAccount(state, family)?.id;
  }

  /** The reset time of the window that is full, from the freshest live usage reading. */
  private resetFromUsage(accountId: string): string | null {
    const usage = this.usage.get(accountId);
    if (!usage || usage.cached) return null;
    const full = usage.windows.filter((window) => window.usedPercent >= 99 && window.resetsAt);
    full.sort((a, b) => Date.parse(b.resetsAt ?? "") - Date.parse(a.resetsAt ?? ""));
    return full[0]?.resetsAt ?? null;
  }

  /** Did this agent's own last turn end on a limit? Then its own failover (with a follow-up) handles it. */
  private async lastTurnHitLimit(paseo: PaseoApi, agentId: string, family: Family): Promise<boolean> {
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 40 });
      const timeline = page.entries.map((entry) => entry.item);
      return this.adapters[family].detectLimit({ outcome: { kind: "completed" }, timeline }) !== null;
    } catch {
      return true; // When unsure, leave it alone.
    }
  }

  /** Idle agents still on an exhausted account would fail on their next turn; move them now. */
  private async moveIdleAgentsOff(
    paseo: PaseoApi,
    accountId: string,
    family: Family,
    except: string,
    reason: "limit" | "signed_out",
  ): Promise<void> {
    const state = await this.store.read();
    const from = findAccount(state, accountId);
    const families = await this.families.resolve(paseo);
    const candidates = (await this.cachedAgents(paseo))
      .filter(
        (agent) =>
          agent.id !== except &&
          !agent.archived &&
          families[agent.provider] === family &&
          this.runningOn(state, agent.id, family) === accountId,
      )
      .map((agent) => agent.id);
    for (const agentId of candidates) {
      if (this.switching.has(agentId) || !this.switchGuard.allows(agentId, Date.now())) continue;
      const info = await agentInfo(paseo, agentId);
      if (!info || info.archived || info.status !== "idle") continue;
      if (await this.lastTurnHitLimit(paseo, agentId, family)) continue;
      this.switching.add(agentId);
      try {
        const now = Date.now();
        const latest = await this.store.read();
        if (this.runningOn(latest, agentId, family) !== accountId) continue;
        const reserved = dedicatedElsewhere(latest, latest.sessions[agentId]?.cwd);
        const next = this.pick(latest, family, now, new Set([...reserved, accountId]));
        if (!next) return;
        await this.store.update((draft) => {
          draft.bindings[agentId] = { accountId: next.id, source: "auto", at: new Date(now).toISOString() };
        });
        this.switchGuard.note(agentId, now);
        if ((await this.reopenAgent(paseo, agentId)) !== "reopened") continue;
        const row: SwitchRow = {
          family,
          from: from?.label ?? null,
          to: next.label,
          reason,
          resetsAt: findAccount(latest, accountId)?.limitedUntil ?? null,
          continued: false,
          continuedIn: null,
          toFamily: null,
          outcome: "switched",
          detail: null,
          at: new Date(now).toISOString(),
        };
        await this.appendRow(paseo, agentId, await this.landed(row, agentId));
      } finally {
        this.switching.delete(agentId);
      }
    }
  }

  /**
   * Carries an agent's work on in a new agent on another provider, for when every account of its
   * own provider is out. Candidates are the plugin's families in FALLBACK_ORDER, then every other
   * provider Paseo has available (or just `target` — a family or provider id — when the user picked
   * one); the first installed provider with a usable account, or any usable accountless provider,
   * takes it. The new agent gets the conversation so far and, where the provider has modes, one no
   * more permissive than the original's; the original stays as it was.
   */
  private async forkToAnotherProvider(
    paseo: PaseoApi,
    agentId: string,
    family: Family,
    timeline: readonly AgentTimelineItem[] | undefined,
    source: "auto" | "user",
    target?: string,
  ): Promise<{ fork: Continuation; to: string; toFamily: string } | { skipped: string }> {
    const families = await this.families.resolve(paseo);
    const state = await this.store.read();

    type Candidate = { kind: "family"; family: Family } | { kind: "provider"; provider: string; label: string };
    const candidates: Candidate[] = [];
    if (target !== undefined) {
      const asFamily = (FAMILIES as readonly string[]).includes(target) ? (target as Family) : undefined;
      if (asFamily !== undefined && asFamily !== family) candidates.push({ kind: "family", family: asFamily });
      else if (asFamily === undefined) {
        const labels = await this.providerLabels(paseo);
        candidates.push({ kind: "provider", provider: target, label: labels.get(target) ?? target });
      }
    } else {
      for (const candidate of fallbackFamilies(family)) candidates.push({ kind: "family", family: candidate });
      candidates.push(...(await this.extraProviders(paseo, families)));
    }
    if (candidates.length === 0) return { skipped: `${FAMILY_LABEL[family]} chats can't continue on another provider.` };

    // Prompting the original again while it's still out mustn't start a second copy of the work.
    const earlier = (await listAgents(paseo, false)).agents.find(
      (agent) =>
        agent.continuedFrom === agentId &&
        candidates.some((candidate) =>
          candidate.kind === "family" ? families[agent.provider] === candidate.family : agent.provider === candidate.provider,
        ),
    );
    if (earlier) {
      const earlierFamily = families[earlier.provider];
      const earlierAccount = earlierFamily
        ? (findAccount(state, state.bindings[earlier.id]?.accountId) ?? mainAccount(state, earlierFamily))
        : undefined;
      if (!earlierFamily || earlierAccount) {
        const label = earlierFamily ? FAMILY_LABEL[earlierFamily] : earlier.provider;
        return {
          fork: { agentId: earlier.id, title: earlier.title ?? `${label} agent` },
          to: earlierAccount?.label ?? label,
          toFamily: earlierFamily ?? earlier.provider,
        };
      }
    }

    const original = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!original) throw new Error("That agent is no longer available.");
    const sourceModes = await paseo.providers.listModes(original.provider).then((result) => result.modes ?? []);

    const skipped: string[] = [];
    for (const candidate of candidates) {
      const name = candidate.kind === "family" ? FAMILY_LABEL[candidate.family] : candidate.label;
      let provider: string | undefined;
      let account: StoredAccount | undefined;
      if (candidate.kind === "family") {
        if (this.availability.get(candidate.family)?.ok === false) {
          skipped.push(`${PROVIDER_NAME[candidate.family]} isn't installed where the daemon runs.`);
          continue;
        }
        provider =
          families[candidate.family] === candidate.family
            ? candidate.family
            : Object.keys(families).find((id) => families[id] === candidate.family);
        const reserved = dedicatedElsewhere(state, state.sessions[agentId]?.cwd);
        const dedicated = folderAccount(state, candidate.family, state.sessions[agentId]?.cwd);
        account =
          (dedicated && isUsable(dedicated, Date.now()) ? dedicated : undefined) ??
          (provider ? this.pick(state, candidate.family, Date.now(), reserved) : undefined);
        if (!account) {
          skipped.push(`Every ${name} account is at its limit too.`);
          continue;
        }
      } else {
        provider = candidate.provider;
      }
      if (!provider) {
        skipped.push(`${name} isn't available in Paseo on this host.`);
        continue;
      }
      const available = (await paseo.providers.listAvailable()).providers?.some(
        (entry) => entry.provider === provider && entry.available,
      );
      if (!available) {
        skipped.push(`${name} isn't available in Paseo on this host.`);
        continue;
      }

      // A provider without modes runs with its own default permissions; one whose modes can't be
      // listed is skipped rather than given a permission level nobody checked.
      const targetModes = await paseo.providers
        .listModes(provider)
        .then((result) => result.modes ?? [])
        .catch(() => null);
      if (targetModes === null) {
        skipped.push(`Couldn't list ${name}'s permission modes.`);
        continue;
      }
      let modeId: string | undefined;
      if (targetModes.length > 0) {
        const equivalent = equivalentMode(sourceModes, original.currentModeId, targetModes);
        if (!equivalent) {
          const current = sourceModes.find((mode) => mode.id === original.currentModeId)?.label;
          skipped.push(`${name} has no mode as careful as this agent's${current ? ` (“${current}”)` : ""}.`);
          continue;
        }
        modeId = equivalent;
      }

      const picked = account;
      const fork = await continueInNewAgent({
        paseo,
        sourceAgentId: agentId,
        timeline,
        why: source === "auto" ? `every ${FAMILY_LABEL[family]} account reached its usage limit` : `the work was moved to ${name}`,
        previous: PROVIDER_NAME[family],
        target: { provider, label: name, ...(modeId ? { modeId } : {}) },
        bind: async (newAgentId) => {
          if (candidate.kind !== "family" || !picked) return;
          await this.store.update((draft) => {
            draft.bindings[newAgentId] = {
              accountId: picked.id,
              source: source === "user" ? "user" : this.adapters[candidate.family].portable ? "auto" : "thread",
              at: new Date().toISOString(),
            };
          });
        },
      });
      console.log(`[paseo-accounts] ${agentId} continues on ${name} (${account?.label ?? "plugin-free"}) in ${fork.agentId}`);
      return { fork, to: account?.label ?? name, toFamily: candidate.kind === "family" ? candidate.family : candidate.provider };
    }
    return { skipped: skipped.join(" ") || "No other provider could take over." };
  }

  /** Available Paseo providers the plugin has no accounts for, with their display labels. */
  private async extraProviders(
    paseo: PaseoApi,
    families: Record<string, Family>,
  ): Promise<Array<{ kind: "provider"; provider: string; label: string }>> {
    const available = await paseo.providers
      .listAvailable()
      .then((result) => result.providers ?? [])
      .catch(() => []);
    const labels = await this.providerLabels(paseo);
    return available
      .filter((entry) => entry.available && families[entry.provider] === undefined)
      .map((entry) => ({ kind: "provider" as const, provider: entry.provider, label: labels.get(entry.provider) ?? entry.provider }));
  }

  /** Display labels for every provider Paseo knows, keyed by id; empty when it can't be read. */
  private async providerLabels(paseo: PaseoApi): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    try {
      const snapshot = await paseo.providers.snapshot();
      for (const entry of snapshot?.entries ?? []) {
        if (entry.label) labels.set(entry.provider, entry.label);
      }
    } catch {
      // Labels are cosmetic; the provider id is a fine stand-in.
    }
    return labels;
  }

  /** "Continue on …" from an agent's account button: the same fork, asked for by the user. */
  async forkAgent(paseo: PaseoApi, agentId: string, to?: string): Promise<Continuation> {
    this.attach(paseo);
    const info = await agentInfo(paseo, agentId);
    if (!info || info.archived) throw new Error("That agent is no longer available.");
    const family = (await this.families.resolve(paseo))[info.provider];
    if (!family) throw new Error(`${info.provider} agents don't use subscription accounts.`);
    if (to !== undefined && (to === family || to === info.provider)) {
      throw new Error(`This agent already runs on ${familyLabel(to)}.`);
    }
    if (info.status === "running" || info.status === "initializing") {
      throw new Error("This agent is working right now. Wait for its turn to finish, then continue it elsewhere.");
    }
    const result = await this.forkToAnotherProvider(paseo, agentId, family, undefined, "user", to);
    if ("skipped" in result) throw new Error(result.skipped);
    const state = await this.store.read();
    await this.appendRow(paseo, agentId, {
      family,
      from: findAccount(state, this.runningOn(state, agentId, family))?.label ?? null,
      to: result.to,
      reason: "manual",
      resetsAt: null,
      continued: true,
      continuedIn: result.fork,
      toFamily: result.toFamily,
      outcome: "continued",
      detail: null,
      at: new Date().toISOString(),
    });
    return result.fork;
  }

  private async continueElsewhere(
    paseo: PaseoApi,
    agentId: string,
    target: StoredAccount,
    why: string,
    timeline: readonly AgentTimelineItem[] | undefined,
    source: "auto" | "user",
  ): Promise<Continuation> {
    return continueInNewAgent({
      paseo,
      sourceAgentId: agentId,
      timeline,
      why,
      bind: async (newAgentId) => {
        await this.store.update((draft) => {
          draft.bindings[newAgentId] = {
            accountId: target.id,
            source: source === "user" ? "user" : "thread",
            at: new Date().toISOString(),
          };
        });
      },
    });
  }

  // ------------------------------------------------------------------ reopening sessions

  /** Where routing would put this agent's next session, including skipping exhausted accounts. */
  private targetFor(state: StoredState, agentId: string, family: Family): string | undefined {
    return chooseAccount(state, {
      agentId,
      family,
      reason: "refresh",
      now: Date.now(),
      autoSwitch: this.prefs.autoSwitch,
      balanceNewAgents: false,
      portable: this.adapters[family].portable,
      usageOf: (id) => this.usage.get(id),
      pick: this.pickOptions,
    })?.account.id;
  }

  /** Names the account the agent actually reopened on in its timeline note. */
  private async landed(row: SwitchRow, agentId: string): Promise<SwitchRow> {
    const state = await this.store.read();
    const label = findAccount(state, state.sessions[agentId]?.accountId)?.label;
    return label && row.outcome === "switched" ? { ...row, to: label } : row;
  }

  /**
   * Reopens an idle agent now, or defers a busy one until its turn ends. `settle` waits a moment for
   * an agent whose turn just ended to report idle, since nothing else would reopen it later.
   */
  private async reopenAgent(
    paseo: PaseoApi,
    agentId: string,
    row: SwitchRow | null = null,
    settle = false,
  ): Promise<ReopenOutcome> {
    let info = await agentInfo(paseo, agentId);
    for (let attempt = 0; settle && info && attempt < 20 && (info.status === "running" || info.status === "initializing"); attempt += 1) {
      await delay(300);
      info = await agentInfo(paseo, agentId);
    }
    if (!info) return "closed";
    if (info.status === "running" || info.status === "initializing") {
      this.deferred.set(agentId, row);
      return "deferred";
    }
    // Reloading an archived agent would unarchive it; a closed one routes itself when it next opens.
    if (info.archived || info.status === "closed") return "closed";
    const family = (await this.families.resolve(paseo))[info.provider];
    if (family && !this.adapters[family].portable && info.hasHistory) {
      // The thread gained history while waiting, so it can no longer change accounts: keep it put.
      const state = await this.store.read();
      const current = this.runningOn(state, agentId, family);
      if (current && findAccount(state, current)) {
        await this.store.update((draft) => {
          draft.bindings[agentId] = { accountId: current, source: "thread", at: new Date().toISOString() };
        });
      }
      return "closed";
    }
    const before = (await this.store.read()).sessions[agentId];
    const result = await this.reopener.reopen(agentId);
    if (!result.ok) {
      console.warn(`[paseo-accounts] could not reopen ${agentId}: ${result.error}`);
      // Paseo asks for the new session's environment before it closes the old one, so a failed reload
      // has still recorded a session that never opened. One that ran out of time may yet open.
      if (!result.timedOut) {
        await this.store.update((draft) => {
          const recorded = draft.sessions[agentId];
          if (!recorded || recorded.openedAt === before?.openedAt) return;
          if (before) draft.sessions[agentId] = before;
          else delete draft.sessions[agentId];
        });
      }
      return "failed";
    }
    return "reopened";
  }

  /**
   * Reopens every live agent whose session runs on a different account than it is routed to now,
   * and notes the switch in its timeline. Busy agents switch (and get their note) after their turn.
   */
  private async reconcile(
    paseo: PaseoApi,
    reason: SwitchRow["reason"],
    agentIds?: readonly string[],
    fromLabels: ReadonlyMap<string, string> = new Map(),
  ): Promise<ReopenSummary> {
    const summary = emptySummary();
    const state = await this.store.read();
    const families = await this.families.resolve(paseo);
    for (const agent of await this.liveAgents(paseo, agentIds)) {
      const agentId = agent.id;
      const family = families[agent.provider];
      if (!family || this.switching.has(agentId)) continue;
      const current = this.runningOn(state, agentId, family);
      const target = this.targetFor(state, agentId, family);
      if (!current || !target || target === current) continue;
      const row: SwitchRow = {
        family,
        from: findAccount(state, current)?.label ?? fromLabels.get(current) ?? null,
        to: findAccount(state, target)?.label ?? target,
        reason,
        resetsAt: null,
        continued: false,
        continuedIn: null,
        toFamily: null,
        outcome: "switched",
        detail: null,
        at: new Date().toISOString(),
      };
      const outcome = await this.reopenAgent(paseo, agentId, row);
      if (outcome === "reopened") {
        summary.reopened.push(agentId);
        await this.appendRow(paseo, agentId, await this.landed(row, agentId));
      } else if (outcome === "deferred") summary.deferred.push(agentId);
      else if (outcome === "failed") summary.failed.push({ agentId, error: "Reload failed" });
    }
    return summary;
  }

  private async appendRow(paseo: PaseoApi, agentId: string, row: SwitchRow): Promise<void> {
    const title = (await agentInfo(paseo, agentId))?.title ?? null;
    await this.activity.add(agentId, title, row).catch((error: unknown) => log("could not log a switch", error));
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `switch-${Date.parse(row.at) || Date.now()}`,
        kind: SWITCH_ROW_KIND,
        version: SWITCH_ROW_VERSION,
        data: row,
      });
    } catch (error) {
      log(`could not add a timeline note to ${agentId}`, error);
    }
  }

  // ------------------------------------------------------------------ usage

  /** `renewLogin` lets the CLI refresh an expired sign-in first (explicit refreshes only: it's slow). */
  refreshUsage(accountId: string, force = false, renewLogin = false): Promise<void> {
    const pending = this.usageInFlight.get(accountId);
    if (pending) return pending;
    const now = Date.now();
    // The provider asked us to wait; asking sooner would only be refused again.
    if (now < (this.usageRetryAt.get(accountId) ?? 0)) return Promise.resolve();
    const since = now - (this.usageAttemptAt.get(accountId) ?? 0);
    const task = (async () => {
      const account = findAccount(await this.store.read(), accountId);
      if (!account) return;
      const spacing = this.adapters[account.family].usageSpacingMs;
      if (since < (force ? spacing : Math.max(spacing, 60_000))) return;
      this.usageAttemptAt.set(accountId, Date.now());
      const { retryAt, ...usage } = await this.adapters[account.family]
        .usage(account.home, { renewLogin })
        .catch(
          (error: unknown): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: describe(error), cached: false, resets: null }),
        );
      if (retryAt) this.usageRetryAt.set(accountId, retryAt);
      else this.usageRetryAt.delete(accountId);
      this.setUsage(accountId, mergeUsage(this.usage.get(accountId), usage));
      // Only a live reading may change an account's limit state.
      if (usage.windows.length === 0 || usage.error || usage.cached) return;
      const now = Date.now();
      const full = usage.windows.find((window) => window.usedPercent >= 100 && window.resetsAt);
      if (full && !isLimited(account, now)) {
        await this.markLimited(accountId, full.resetsAt ?? new Date(now + WINDOW_LIMIT_MS).toISOString(), "window");
        return;
      }
      // A window limit clears once usage shows room again. Budget limits never appear in usage
      // windows, and a fresh limit is trusted for a while (it may be on a window we can't see).
      const settled = account.limitedAt ? now - Date.parse(account.limitedAt) > LIMIT_TRUST_MS : true;
      const roomy = Math.max(...usage.windows.map((window) => window.usedPercent)) < 90;
      if (!full && account.limitedUntil && account.limitKind === "window" && settled && roomy) {
        await this.store.update((draft) => {
          const target = findAccount(draft, accountId);
          if (!target) return;
          target.limitedUntil = null;
          target.limitKind = null;
        });
      }
    })().finally(() => this.usageInFlight.delete(accountId));
    this.usageInFlight.set(accountId, task);
    return task;
  }

  /** Records a reading and saves the readings shortly after, so a restart shows them straight away. */
  private setUsage(accountId: string, usage: Usage | null): void {
    if (usage) this.usage.set(accountId, usage);
    else this.usage.delete(accountId);
    // Fresh readings only: a cached copy would plot an old value at today's time.
    if (usage && !usage.cached && !usage.error) record(this.history, accountId, usage);
    if (this.usageSave) return;
    this.usageSave = setTimeout(() => {
      this.usageSave = null;
      void saveReadings(this.usage).catch((error: unknown) => log("could not save usage", error));
      void saveHistory(this.history).catch((error: unknown) => log("could not save usage history", error));
    }, 3_000);
    this.usageSave.unref?.();
  }

  // ------------------------------------------------------------------ RPC: state

  async view(paseo: PaseoApi, refreshUsage = false): Promise<StateView> {
    this.attach(paseo);
    if (refreshUsage) {
      const state = await this.store.read();
      await Promise.allSettled(state.accounts.map((account) => this.refreshUsage(account.id, true, true)));
    }
    void this.prune(paseo).catch(() => undefined);
    const state = await this.store.read();
    const families = await this.families.resolve(paseo);
    const agents = await this.cachedAgents(paseo);
    const now = Date.now();

    const routes: AgentRoute[] = [];
    const counts = new Map<string, number>();
    for (const agent of agents) {
      const family = families[agent.provider];
      if (!family || agent.archived) continue;
      const accountId = this.targetFor(state, agent.id, family);
      if (!accountId) continue;
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
      const current = isLive(agent.status) ? this.runningOn(state, agent.id, family) : undefined;
      const binding = state.bindings[agent.id];
      routes.push({
        agentId: agent.id,
        family,
        accountId,
        pinned: Boolean(binding && binding.source !== "thread"),
        pendingAccountId: current && current !== accountId ? current : null,
        movable: this.adapters[family].portable || !agent.hasHistory,
        provider: agent.provider,
        title: agent.title,
        cwd: agent.cwd ?? state.sessions[agent.id]?.cwd ?? null,
        status: agent.status,
      });
    }
    // Where each provider's next new agent goes: the default, or the roomiest when spreading.
    const nextUp: Record<string, string> = {};
    for (const family of FAMILIES) {
      const next = chooseAccount(state, {
        agentId: "",
        family,
        reason: "create",
        now,
        autoSwitch: this.prefs.autoSwitch,
        balanceNewAgents: this.prefs.balanceNewAgents,
        portable: this.adapters[family].portable,
        usageOf: (id) => this.usage.get(id),
        pick: this.pickOptions,
      });
      if (next) nextUp[family] = next.account.id;
    }

    const accounts: AccountView[] = state.accounts.map((account) => {
      const limited = isLimited(account, now);
      return {
        id: account.id,
        family: account.family,
        label: account.label,
        kind: account.kind,
        email: account.email,
        plan: account.plan,
        organization: account.organization,
        status: !account.signedIn ? "signed_out" : account.disabled ? "disabled" : limited ? "limited" : "ready",
        isDefault: defaultAccount(state, account.family)?.id === account.id,
        limitedUntil: limited ? account.limitedUntil : null,
        usage: this.usage.get(account.id) ?? null,
        agentCount: counts.get(account.id) ?? 0,
        home: account.home,
        priority: account.priority,
        ...this.forecastOf(account.id),
        folders: state.folders.filter((rule) => rule.accountId === account.id).map((rule) => rule.path),
      };
    });

    return {
      accounts,
      agents: routes,
      logins: [...this.logins.values()].map((login) => login.view),
      activity: await this.activity.list(),
      nextUp,
      providers: families,
      canReopen: (await this.reopener.locate()) !== null,
      installed: FAMILIES.filter((family) => this.availability.get(family)?.ok),
      fallbacks: (await this.extraProviders(paseo, families)).map(({ provider, label }) => ({ id: provider, label })),
      hostTimeZone: hostTimeZone(),
      browserSignIn: this.browserSignIn,
      showComposerPill: this.prefs.showComposerPill,
      warnings: await this.warnings(),
    };
  }

  /** Agents with a live session: the given ones (looked up fresh), or every one. */
  private async liveAgents(paseo: PaseoApi, agentIds?: readonly string[]): Promise<AgentInfo[]> {
    const agents = agentIds
      ? (await Promise.all(agentIds.map((agentId) => agentInfo(paseo, agentId)))).filter((agent): agent is AgentInfo => agent !== null)
      : await this.cachedAgents(paseo);
    return agents.filter((agent) => !agent.archived && isLive(agent.status));
  }

  private cachedAgents(paseo: PaseoApi): Promise<AgentInfo[]> {
    if (this.agentCache && Date.now() - this.agentCache.at < AGENT_LIST_MS) return this.agentCache.agents;
    const agents = listAgents(paseo, false).then((result) => result.agents);
    this.agentCache = { at: Date.now(), agents };
    agents.catch(() => {
      this.agentCache = null;
    });
    return agents;
  }

  private async warnings(): Promise<string[]> {
    const warnings: string[] = [];
    // Kimi Code and OpenCode are optional extras; only Claude Code and Codex are worth a nudge.
    for (const family of ["claude", "codex"] as const) {
      const availability = this.availability.get(family);
      if (availability && !availability.ok) {
        warnings.push(
          `${PROVIDER_NAME[family]} isn't installed where the daemon can run it${availability.detail ? ` (${availability.detail})` : ""}. Install it to add ${FAMILY_LABEL[family]} accounts.`,
        );
      }
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
      warnings.push(
        "The daemon's environment sets a Claude API key or token. Agents on your CLI login use it; agents on added accounts use their own sign-in.",
      );
    }
    if (process.env.CODEX_ACCESS_TOKEN) {
      warnings.push("The daemon's environment sets CODEX_ACCESS_TOKEN. Codex agents on your CLI login use it instead of a ChatGPT sign-in.");
    }
    if ((await this.reopener.locate()) === null) {
      warnings.push(
        "Paseo's command-line tool wasn't found, so running agents change accounts the next time their session starts instead of right away.",
      );
    }
    return warnings;
  }

  // ------------------------------------------------------------------ RPC: accounts

  async setDefault(paseo: PaseoApi, accountId: string): Promise<ReopenSummary> {
    this.attach(paseo);
    const account = findAccount(await this.store.read(), accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (!account.signedIn) throw new Error(`${account.label} is signed out. Sign it in first.`);
    if (account.disabled) throw new Error(`${account.label} is disabled. Enable it before making it the default.`);
    const portable = this.adapters[account.family].portable;
    if (!portable) await this.pinThreads(paseo, account.family);
    await this.store.update((draft) => {
      draft.defaults[account.family] = account.id;
    });
    if (portable && !this.prefs.moveAgentsOnDefaultChange) {
      // The new default is for what comes next: open agents stay on the account they run on.
      const { kept, moving } = await this.keepOpenAgents(paseo, account.family, account.id);
      console.log(`[paseo-accounts] ${account.label} is the default now; ${kept} open agent(s) stay on their account`);
      // Agents that can't stay where they are move as they would with the switch on; nothing else does.
      return moving.length > 0 ? this.reconcile(paseo, "default", moving) : emptySummary();
    }
    // Conversations that can't move (Codex threads) are pinned, so this only moves portable ones.
    return this.reconcile(paseo, "default");
  }

  /**
   * Replaces the folders dedicated to an account. A folder belongs to one account per provider, so
   * claiming it here takes it from any other. Agents in the affected folders move now (busy ones
   * after their turn); ChatGPT conversations that already started stay where they are.
   */
  async setFolders(paseo: PaseoApi, accountId: string, paths: readonly string[]): Promise<ReopenSummary> {
    this.attach(paseo);
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    if (!account) throw new Error("That account no longer exists.");
    const wanted = [...new Set(paths.map(normalizeFolder))];
    await this.store.update((draft) => {
      const sameFamily = (rule: FolderRule) => findAccount(draft, rule.accountId)?.family === account.family;
      draft.folders = draft.folders.filter(
        (rule) => rule.accountId !== accountId && !(sameFamily(rule) && wanted.includes(rule.path)),
      );
      for (const path of wanted) draft.folders.push({ path, accountId });
    });
    return this.reconcile(paseo, "folder");
  }

  /**
   * Sets an account aside for a while, or brings it back. A disabled account stays signed in, but
   * nothing is routed to it: its agents move to the next account now (busy ones after their turn)
   * and return when it's enabled again. ChatGPT conversations can't change accounts, so the ones
   * already on it stay there; `stayed` counts them.
   */
  async setAccountEnabled(paseo: PaseoApi, accountId: string, enabled: boolean): Promise<ReopenSummary & { stayed: number }> {
    this.attach(paseo);
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (account.disabled === !enabled) return { ...emptySummary(), stayed: 0 };
    if (!enabled && !accountsOf(state, account.family).some((other) => other.id !== account.id && other.signedIn && !other.disabled)) {
      // With nothing else to route to, sessions would quietly fall back to the CLI login.
      throw new Error(`${account.label} is the only ${FAMILY_LABEL[account.family]} account in use. Add or enable another one first.`);
    }
    await this.store.update((draft) => {
      const target = findAccount(draft, accountId);
      if (target) target.disabled = !enabled;
    });
    console.log(`[paseo-accounts] ${account.label} is ${enabled ? "enabled" : "disabled"}`);
    const summary = await this.reconcile(paseo, enabled ? "enabled" : "disabled");
    let stayed = 0;
    if (!enabled && !this.adapters[account.family].portable) {
      const families = await this.families.resolve(paseo);
      const latest = await this.store.read();
      stayed = (await listAgents(paseo, false)).agents.filter(
        (agent) =>
          families[agent.provider] === account.family && agent.hasHistory && this.targetFor(latest, agent.id, account.family) === accountId,
      ).length;
    }
    return { ...summary, stayed };
  }

  /**
   * Pins every existing agent of a non-portable provider to the account it runs on now, before the
   * default changes. Agents that haven't opened a session since the plugin was installed have no pin yet.
   */
  private async pinThreads(paseo: PaseoApi, family: Family): Promise<void> {
    const families = await this.families.resolve(paseo);
    const { agents } = await listAgents(paseo, true);
    const state = await this.store.read();
    const current = defaultAccount(state, family);
    const unpinned = agents.filter((agent) => families[agent.provider] === family && !state.bindings[agent.id]);
    if (!current || unpinned.length === 0) return;
    const at = new Date().toISOString();
    await this.store.update((draft) => {
      for (const agent of unpinned) {
        if (draft.bindings[agent.id]) continue;
        // A thread lives where its session ran: the CLI login when the plugin never routed it.
        draft.bindings[agent.id] = { accountId: this.runningOn(draft, agent.id, family) ?? current.id, source: "thread", at };
      }
    });
  }

  /**
   * Pins each open agent that follows the default to the account it runs on, so the new default
   * doesn't move it, now or when it next opens. Runs once the new default is in place, so an agent
   * that opened under the old one just before is kept too, even if its session was still being
   * routed. Agents already on the new default keep following it. An account that's gone, signed
   * out, disabled or at its limit is no place to keep work, so those agents come back in `moving`.
   */
  private async keepOpenAgents(
    paseo: PaseoApi,
    family: Family,
    newDefault: string,
  ): Promise<{ kept: number; moving: string[] }> {
    // A session being routed may have gone by the old default: let it record where it opens first.
    if (this.routing.size > 0) await withTimeout(Promise.allSettled(this.routing.keys()), ROUTING_WAIT_MS);
    const families = await this.families.resolve(paseo);
    const open = (await listAgents(paseo, false)).agents.filter(
      (agent) => families[agent.provider] === family && !agent.archived && isLive(agent.status),
    );
    let kept = 0;
    const moving: string[] = [];
    if (open.length === 0) return { kept, moving };
    const now = Date.now();
    const at = new Date(now).toISOString();
    await this.store.update((draft) => {
      // Where these open isn't recorded yet, and a session routed now goes by the new default.
      const routing = new Set(this.routing.values());
      for (const agent of open) {
        if (routing.has(agent.id)) continue;
        // An agent with an account of its own never followed the default.
        if (findAccount(draft, draft.bindings[agent.id]?.accountId)?.family === family) continue;
        // Still starting, and not routed yet: it will be, by the new default.
        if (agent.status === "initializing" && !draft.sessions[agent.id]) continue;
        const current = findAccount(draft, this.runningOn(draft, agent.id, family));
        if (!current || current.family !== family || !isUsable(current, now)) moving.push(agent.id);
        else if (current.id !== newDefault) {
          // "auto", like a limit switch, so the account button still offers "Follow default".
          draft.bindings[agent.id] = { accountId: current.id, source: "auto", at };
          kept += 1;
        }
      }
    });
    return { kept, moving };
  }

  async clearLimit(accountId: string): Promise<void> {
    const state = await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      account.limitedUntil = null;
      account.limitKind = null;
    });
    if (!findAccount(state, accountId)) throw new Error("That account no longer exists.");
    void this.refreshUsage(accountId, true).catch(() => undefined);
  }

  async setAgentAccount(paseo: PaseoApi, agentId: string, accountId: string | null): Promise<ReopenSummary> {
    this.attach(paseo);
    const info = await agentInfo(paseo, agentId);
    if (!info) throw new Error("That agent is no longer available.");
    const family = (await this.families.resolve(paseo))[info.provider];
    if (!family) throw new Error(`${info.provider} agents don't use Claude or ChatGPT subscription accounts.`);
    const adapter = this.adapters[family];
    const state = await this.store.read();
    const target = accountId ? findAccount(state, accountId) : defaultAccount(state, family);
    if (!target || target.family !== family) throw new Error("That account can't be used with this agent.");
    if (!target.signedIn) throw new Error(`${target.label} is signed out. Sign it in first.`);
    if (accountId && target.disabled) throw new Error(`${target.label} is disabled. Enable it in Accounts first.`);

    if (!adapter.portable) {
      if (info.status === "running" || info.status === "initializing") {
        throw new Error("This agent is working right now. Wait for its turn to finish, then switch.");
      }
      if (info.hasHistory) {
        const binding = state.bindings[agentId];
        const current = binding?.source === "thread" ? binding.accountId : this.runningOn(state, agentId, family);
        if (current === target.id) return emptySummary();
        const continuation = await this.continueElsewhere(
          paseo,
          agentId,
          target,
          `you moved the work to your ChatGPT account "${target.label}"`,
          undefined,
          "user",
        );
        await this.appendRow(paseo, agentId, {
          family,
          from: findAccount(state, current)?.label ?? null,
          to: target.label,
          reason: "manual",
          resetsAt: null,
          continued: true,
          continuedIn: continuation,
          toFamily: null,
          outcome: "continued",
          detail: null,
          at: new Date().toISOString(),
        });
        return { ...emptySummary(), continuedIn: continuation };
      }
    }

    await this.store.update((draft) => {
      if (accountId) draft.bindings[agentId] = { accountId, source: adapter.portable ? "user" : "thread", at: new Date().toISOString() };
      else delete draft.bindings[agentId];
    });
    return this.reconcile(paseo, "manual", [agentId]);
  }

  async rename(accountId: string, label: string): Promise<void> {
    const state = await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      account.label = label;
      account.autoLabel = false;
    });
    if (!findAccount(state, accountId)) throw new Error("That account no longer exists.");
  }

  async remove(paseo: PaseoApi, accountId: string): Promise<number> {
    this.attach(paseo);
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (account.kind === "main") {
      throw new Error("Your CLI login can't be removed here. Sign out with `claude auth logout` or `codex logout` instead.");
    }
    if (!this.adapters[account.family].portable) {
      // These conversations can't move to another ChatGPT account, so removing theirs would strand them.
      const families = await this.families.resolve(paseo);
      const stranded = (await listAgents(paseo, false)).agents.filter(
        (agent) =>
          families[agent.provider] === account.family &&
          agent.hasHistory &&
          (state.bindings[agent.id]?.accountId ?? state.sessions[agent.id]?.accountId) === accountId,
      );
      if (stranded.length > 0) {
        const one = stranded.length === 1;
        throw new Error(
          `${stranded.length} ChatGPT conversation${one ? "" : "s"} still ${one ? "runs" : "run"} on ${account.label} and can't move to another account. Archive ${
            one ? "it" : "them"
          } (the work stays in your files) or continue ${one ? "it" : "them"} on another account from the account button, then remove ${account.label}.`,
        );
      }
    }
    const affected = Object.entries(state.sessions)
      .filter(([, session]) => session.accountId === accountId)
      .map(([agentId]) => agentId);
    await this.store.update((draft) => {
      draft.accounts = draft.accounts.filter((entry) => entry.id !== accountId);
      draft.folders = draft.folders.filter((rule) => rule.accountId !== accountId);
      for (const [agentId, binding] of Object.entries(draft.bindings)) {
        if (binding.accountId === accountId) delete draft.bindings[agentId];
      }
      if (draft.defaults[account.family] === accountId) draft.defaults[account.family] = null;
    });
    this.setUsage(accountId, null);
    // Idle agents move now and busy ones after their turn. The home is signed out and deleted by the
    // cleanup pass only once nothing runs on it any more.
    await this.reconcile(paseo, "removed", affected, new Map([[account.id, account.label]]));
    void this.collectOrphanHomes(paseo).catch((error: unknown) => log("cleanup failed", error));
    return affected.length;
  }

  // ------------------------------------------------------------------ RPC: sign-in

  startLogin(family: Family, method: LoginMethod, accountId?: string): Promise<LoginView> {
    return this.loginLocks[family].run(() => this.beginLogin(family, method, accountId));
  }

  private async beginLogin(family: Family, method: LoginMethod, accountId?: string): Promise<LoginView> {
    let availability = this.availability.get(family);
    if (!availability?.ok) {
      await this.ensureFamily(family);
      availability = this.availability.get(family);
    }
    if (!availability?.ok) throw new Error(`${PROVIDER_NAME[family]} isn't installed on the daemon machine.`);
    // One flow per provider at a time (Codex's browser sign-in uses a fixed local port).
    for (const login of this.logins.values()) {
      if (login.family === family && !login.finishedAt) await this.cancelLogin(login.id);
    }
    const state = await this.store.read();
    // Oh My Pi pools its accounts itself: a new one joins its CLI login rather than getting a home.
    if (family === "omp") accountId ??= MAIN_ACCOUNT_ID.omp;
    const existing = accountId ? findAccount(state, accountId) : undefined;
    if (accountId && (!existing || existing.family !== family)) throw new Error("That account no longer exists.");

    const id = randomBytes(6).toString("hex");
    const home = existing ? existing.home : join(homesDir(), `${family}-${id}`);
    const session: LoginSession = {
      id,
      family,
      accountId: existing?.id ?? null,
      home,
      handle: null,
      finishedAt: null,
      view: {
        id,
        family,
        method,
        accountId: existing?.id ?? null,
        step: "starting",
        url: null,
        codeUrl: null,
        userCode: null,
        message: null,
        startedAt: new Date().toISOString(),
      },
    };
    this.logins.set(id, session);
    try {
      if (home) await this.adapters[family].prepareHome(home);
      const handle = await this.adapters[family].login(home, method);
      if (session.finishedAt) {
        handle.cancel();
        return session.view;
      }
      session.handle = handle;
      const sync = () => {
        if (!session.finishedAt) session.view = { ...session.view, ...handle.progress };
      };
      handle.onProgress(sync);
      sync();
      void handle.finished
        .then((result) => this.finishLogin(session, result))
        .catch((error: unknown) => this.failLogin(session, describe(error)));
    } catch (error) {
      this.failLogin(session, describe(error));
    }
    return session.view;
  }

  async submitCode(loginId: string, code: string): Promise<LoginView> {
    const session = this.logins.get(loginId);
    if (!session?.handle) throw new Error("This sign-in has expired. Start again.");
    if (!session.finishedAt) await session.handle.submitCode(code);
    return session.view;
  }

  async cancelLogin(loginId: string): Promise<LoginView | null> {
    const session = this.logins.get(loginId);
    if (!session) return null;
    if (!session.finishedAt) {
      session.finishedAt = Date.now();
      session.handle?.cancel();
      session.view = { ...session.view, step: "canceled", message: "Sign-in was canceled." };
      this.scheduleCleanup();
    }
    return session.view;
  }

  private async finishLogin(session: LoginSession, result: { ok: boolean; message: string | null }): Promise<void> {
    if (session.finishedAt) return;
    if (!result.ok) return this.failLogin(session, result.message ?? "Sign-in did not finish.");
    session.view = { ...session.view, step: "verifying", message: null };
    const adapter = this.adapters[session.family];
    const identity = await adapter.identity(session.home).catch(() => null);
    if (session.finishedAt) return; // Canceled while verifying.
    if (!identity?.signedIn) return this.failLogin(session, "Sign-in finished, but the account isn't signed in. Try again.");

    const state = await this.store.read();
    const existing = findAccount(state, session.accountId);
    if (existing?.kind === "managed" && existing.identity && identity.identity && existing.identity !== identity.identity) {
      // Signing an account back in must not quietly turn it into a different login.
      if (session.home) await adapter.logout(session.home).catch(() => undefined);
      const expected = existing.email ?? existing.label;
      return this.failLogin(
        session,
        `You signed in as ${identity.email ?? "a different account"}, but this is ${expected}. Sign in as ${expected}, or use Add account for the other one.`,
      );
    }
    // The CLI's own login is whatever the user signs it into; only added accounts must be distinct.
    const duplicate =
      identity.identity && existing?.kind !== "main"
        ? accountsOf(state, session.family).find(
            (account) => account.id !== session.accountId && account.identity === identity.identity,
          )
        : undefined;
    if (duplicate) {
      if (!existing && session.home) await adapter.logout(session.home).catch(() => undefined);
      return this.failLogin(
        session,
        `${identity.email ?? "That account"} is already added as "${duplicate.label}". Sign in with a different account.`,
      );
    }
    if (session.finishedAt) return;
    session.finishedAt = Date.now(); // Claim completion before writing, so a late cancel can't race it.

    let accountId = session.accountId;
    await this.store.update((draft) => {
      let account = findAccount(draft, accountId);
      if (!account) {
        // A managed account's ID matches its home's folder name (collectOrphanHomes relies on it).
        accountId = `${session.family}-${session.id}`;
        account = newAccount({ id: accountId, family: session.family, kind: "managed", home: session.home });
        draft.accounts.push(account);
      }
      applyIdentity(account, identity, draft);
      account.limitedUntil = null;
      account.limitKind = null;
    });
    if (accountId) this.identityCheckedAt.set(accountId, Date.now());
    session.accountId = accountId;
    session.view = { ...session.view, step: "done", accountId, message: null };
    if (accountId) void this.refreshUsage(accountId, true).catch(() => undefined);
  }

  private failLogin(session: LoginSession, message: string): void {
    if (session.finishedAt) return;
    session.finishedAt = Date.now();
    session.handle?.cancel();
    session.view = { ...session.view, step: "failed", message };
    this.scheduleCleanup();
  }
}

// -------------------------------------------------------------------- helpers

function newAccount(fields: Pick<StoredAccount, "id" | "family" | "kind" | "home">): StoredAccount {
  return {
    ...fields,
    label: "",
    autoLabel: true,
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
    createdAt: new Date().toISOString(),
  };
}

function applyIdentity(account: StoredAccount, identity: Identity, state: StoredState): void {
  account.signedIn = identity.signedIn;
  if (!identity.signedIn) return;
  account.email = identity.email ?? account.email;
  account.plan = identity.plan ?? account.plan;
  account.organization = identity.organization ?? account.organization;
  account.identity = identity.identity ?? account.identity;
  if (account.autoLabel || !account.label) {
    account.label = suggestLabel(account, state);
    account.autoLabel = true;
  }
}

/** "work" for work@acme.com, or the full address when another account would read the same. */
export function suggestLabel(account: StoredAccount, state: StoredState): string {
  const others = accountsOf(state, account.family).filter((entry) => entry.id !== account.id);
  if (account.email) {
    const local = account.email.split("@")[0] ?? account.email;
    const clash = others.some(
      (entry) => entry.label.toLowerCase() === local.toLowerCase() || entry.email?.split("@")[0]?.toLowerCase() === local.toLowerCase(),
    );
    return clash ? account.email : local;
  }
  const base = FAMILY_LABEL[account.family];
  let index = others.length + 1;
  while (others.some((entry) => entry.label === `${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

type AgentSnapshot = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

function toAgentInfo(agent: AgentSnapshot): AgentInfo {
  return {
    id: agent.id,
    provider: agent.provider,
    status: agent.status,
    archived: Boolean(agent.archivedAt),
    hasHistory: Boolean(agent.lastUserMessageAt),
    title: agent.title ?? null,
    cwd: agent.cwd ?? null,
    continuedFrom: agent.labels?.[CONTINUED_FROM_LABEL] ?? null,
  };
}

/** Absolute, with `~` expanded and no trailing slash, so folder rules compare as plain prefixes. */
export function normalizeFolder(path: string): string {
  const expanded = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  if (!isAbsolute(expanded)) throw new Error(`"${path}" isn't a full folder path. Start it with / or ~/.`);
  return resolve(expanded).replace(/(.)\/+$/, "$1");
}

async function agentInfo(paseo: PaseoApi, agentId: string): Promise<AgentInfo | null> {
  try {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
    return agent ? toAgentInfo(agent) : null;
  } catch {
    return null;
  }
}

const MAX_PAGES = 100;

async function listAgents(paseo: PaseoApi, includeArchived: boolean): Promise<{ agents: AgentInfo[]; complete: boolean }> {
  const agents: AgentInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      ...(includeArchived ? { filter: { includeArchived: true } } : {}),
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of result.entries) agents.push(toAgentInfo(agent));
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return { agents, complete: true };
    cursor = result.pageInfo.nextCursor;
  }
  return { agents, complete: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(task: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([task.catch(() => undefined), delay(ms)]);
}

function log(message: string, error: unknown): void {
  console.error(`[paseo-accounts] ${message}`, describe(error));
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
