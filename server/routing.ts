import { peakUsage } from "../shared/format";
import type { Family, Usage, UsageWindow } from "../shared/model";
import {
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type Binding,
  type StoredAccount,
  type StoredState,
} from "./state";

export function isLimited(account: StoredAccount, now: number): boolean {
  if (!account.limitedUntil) return false;
  const until = Date.parse(account.limitedUntil);
  return Number.isFinite(until) && until > now;
}

export function isUsable(account: StoredAccount, now: number): boolean {
  return account.signedIn && !account.disabled && !isLimited(account, now);
}

/** Lower is better. Unknown usage ranks in the middle so a known-quiet account wins over a mystery. */
export function headroomScore(usage: Usage | null | undefined): number {
  const peak = usage ? peakUsage(usage.windows) : null;
  return peak ? peak.usedPercent : 50;
}

const DAY_MS = 24 * 60 * 60_000;

/** Weekly, monthly and other long windows: the allowances that go to waste if left unused. */
function isLongWindow(window: UsageWindow, now: number): boolean {
  const resets = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return /week|seven|month|7d/i.test(`${window.id} ${window.label}`) || (Number.isFinite(resets) && resets - now > DAY_MS);
}

/**
 * Lower is better. How much of its long-window allowance an account can spend per hour before that
 * window resets: an account with 40% left that resets tonight should be used before one with 60%
 * left that resets next week, or its 40% is simply lost. Accounts without a long window, or with
 * unknown usage, fall back to plain headroom (ranked after every paced account).
 */
export function paceScore(usage: Usage | null | undefined, now: number): number {
  const long = (usage?.windows ?? []).filter((window) => window.resetsAt && isLongWindow(window, now));
  if (long.length === 0) return 1_000 + headroomScore(usage);
  // The tightest long window is the one that limits how fast this account can be spent.
  const rate = Math.min(
    ...long.map((window) => {
      const hours = Math.max(1, (Date.parse(window.resetsAt ?? "") - now) / 3_600_000);
      return Math.max(0, 100 - window.usedPercent) / hours;
    }),
  );
  return -rate;
}

export interface PickOptions {
  /** Percent used at which an account counts as nearly full; those rank after every other one. */
  fullAt?: number;
  /** Rank by pace (use what resets soonest first) instead of plain headroom. */
  pace?: boolean;
}

const PRIORITY_RANK = { first: 0, normal: 1, last: 2 } as const;

/**
 * The usable account to pick: one that isn't nearly full, then by the user's priority, then by
 * pace or headroom, preferring the default, then the CLI login, on ties.
 */
export function mostAvailable(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  options: PickOptions = {},
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const candidates = accountsOf(state, family).filter(
    (account) => !exclude.has(account.id) && isUsable(account, now),
  );
  const fullAt = options.fullAt ?? 100;
  const rank = (account: StoredAccount) => {
    const usage = usageOf(account.id);
    const used = usage ? (peakUsage(usage.windows)?.usedPercent ?? 0) : 0;
    return [
      used >= fullAt ? 1 : 0,
      PRIORITY_RANK[account.priority],
      options.pace ? paceScore(usage, now) : headroomScore(usage),
      account.id === preferred ? 0 : 1,
      account.kind === "main" ? 0 : 1,
      Date.parse(account.createdAt) || 0,
    ];
  };
  candidates.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return candidates[0];
}

/** `cwd` is `folder` or somewhere inside it. */
export function inFolder(cwd: string, folder: string): boolean {
  const base = folder.replace(/\/+$/, "");
  return cwd === base || cwd.startsWith(`${base}/`);
}

/** The account dedicated to the deepest folder holding `cwd`, if any. */
export function folderAccount(state: StoredState, family: Family, cwd: string | undefined): StoredAccount | undefined {
  if (!cwd) return undefined;
  let best: { length: number; account: StoredAccount } | undefined;
  for (const rule of state.folders) {
    const account = findAccount(state, rule.accountId);
    if (!account || account.family !== family || !inFolder(cwd, rule.path)) continue;
    if (!best || rule.path.length > best.length) best = { length: rule.path.length, account };
  }
  return best?.account;
}

/** Accounts dedicated to folders `cwd` is not in: balancing and failover never pick them. */
export function dedicatedElsewhere(state: StoredState, cwd: string | undefined): Set<string> {
  const here = new Set(state.folders.filter((rule) => cwd && inFolder(cwd, rule.path)).map((rule) => rule.accountId));
  return new Set(state.folders.map((rule) => rule.accountId).filter((id) => !here.has(id)));
}

export interface RouteInput {
  agentId: string;
  family: Family;
  /** The agent's working folder; falls back to the one recorded when its session last opened. */
  cwd?: string;
  reason: "create" | "resume" | "refresh" | "import";
  now: number;
  autoSwitch: boolean;
  balanceNewAgents: boolean;
  /**
   * Whether an existing conversation can open on a different account. When it can't (Codex), a
   * thread stays on the account it started on, and only brand-new agents are balanced or rerouted.
   */
  portable: boolean;
  usageOf(accountId: string): Usage | null | undefined;
  /** How automatic picks rank accounts. */
  pick?: PickOptions;
}

export interface RouteDecision {
  account: StoredAccount;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: StoredAccount; why: "limited" | "signed_out" | "disabled" } | null;
}

/**
 * Which account a session opens on: the agent's own binding, else (for balanced new agents) the
 * roomiest account, else the default. An exhausted or signed-out choice is swapped for the roomiest
 * usable account when automatic switching is on — for new agents always, and for existing ones
 * only when their conversation can move between accounts. A disabled choice is always swapped,
 * and the agent keeps its own binding so it returns once the account is enabled again.
 */
export function chooseAccount(state: StoredState, input: RouteInput): RouteDecision | null {
  const accounts = accountsOf(state, input.family);
  if (accounts.length === 0) return null;
  const at = new Date(input.now).toISOString();
  const fresh = input.reason === "create";

  const binding = state.bindings[input.agentId];
  const bound = findAccount(state, binding?.accountId);
  let account = bound && bound.family === input.family ? bound : undefined;
  let bind: Binding | null = null;
  const cwd = input.cwd ?? state.sessions[input.agentId]?.cwd;
  const reserved = dedicatedElsewhere(state, cwd);

  // A folder's account beats automatic picks, but not a choice made for this agent. After a limit
  // moved the agent off it, the agent stays put until the folder's account is usable again.
  const dedicated = folderAccount(state, input.family, cwd);
  const automatic =
    dedicated !== undefined && (binding?.source === "balance" || (binding?.source === "auto" && isUsable(dedicated, input.now)));
  if (dedicated && (!account || automatic)) {
    account = dedicated;
    if (!input.portable && bound?.id !== dedicated.id) bind = { accountId: dedicated.id, source: "thread", at };
  }

  if (!account && fresh && input.balanceNewAgents && accounts.length > 1) {
    account = mostAvailable(state, input.family, input.usageOf, input.now, reserved, input.pick);
    if (account) bind = { accountId: account.id, source: "balance", at };
  }
  if (!account) {
    // An imported Codex thread most likely came from the user's own CLI, so it belongs to that login.
    const imported = !input.portable && input.reason === "import" ? mainAccount(state, input.family) : undefined;
    account = imported ?? defaultAccount(state, input.family);
    // A thread that can't move is pinned to the account it first opened on.
    if (account && !input.portable) bind = { accountId: account.id, source: "thread", at };
  }
  if (!account) return null;

  let skipped: RouteDecision["skipped"] = null;
  const why = !account.signedIn ? "signed_out" : account.disabled ? "disabled" : isLimited(account, input.now) ? "limited" : null;
  const mayMove = fresh || input.portable;
  if (why && mayMove && (input.autoSwitch || why !== "limited")) {
    const alternative = mostAvailable(state, input.family, input.usageOf, input.now, new Set([...reserved, account.id]), input.pick);
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A thread that can't move lives where it starts. Otherwise a disabled account keeps its
      // agents' bindings, so they return when it's enabled again; a limit re-pins them.
      bind =
        !input.portable
          ? { accountId: alternative.id, source: "thread", at }
          : why === "disabled"
            ? null
            : { accountId: alternative.id, source: "auto", at };
    }
  }
  return { account, bind, skipped };
}

/** The account an agent is routed to right now, without side effects (for display). */
export function effectiveAccountId(state: StoredState, agentId: string, family: Family): string | undefined {
  const bound = findAccount(state, state.bindings[agentId]?.accountId);
  if (bound && bound.family === family) return bound.id;
  return defaultAccount(state, family)?.id;
}
