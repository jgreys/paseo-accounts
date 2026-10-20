import type { StateView } from "../shared/model";

const iso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const usage = (windows: Array<[string, string, number, number | null]>) => ({
  fetchedAt: iso(-1),
  windows: windows.map(([id, label, usedPercent, resetMin]) => ({ id, label, usedPercent, resetsAt: resetMin === null ? null : iso(resetMin) })),
  error: null,
  cached: false,
  resets: null,
});

const climb = Array.from({ length: 42 }, (_, i) => (i < 6 ? null : Math.min(100, 8 + i * 1.6)));
const flat = Array.from({ length: 42 }, (_, i) => (i % 3 === 0 ? null : 20 + (i % 7)));
const base = { priority: "normal" as const, forecast: null, trend: [] as Array<number | null>, email: null, plan: null, organization: null, limitedUntil: null, home: null, folders: [] as string[], kind: "managed" as const, isDefault: false, agentCount: 0 };

export const sample: StateView = {
  accounts: [
    { ...base, id: "claude-main", family: "claude", label: "Work", kind: "main", email: "alex@example.com", plan: "max", status: "ready", isDefault: true, agentCount: 3, usage: usage([["five_hour", "5-hour", 62, 95], ["seven_day", "Weekly", 41, 3 * 1440]]), priority: "first", trend: climb, forecast: { windowLabel: "Weekly", runsOutAt: iso(1.6 * 1440), resetsAt: iso(3 * 1440) } },
    { ...base, id: "claude-j", family: "claude", label: "Personal", email: "alex.personal@example.com", plan: "max", status: "ready", agentCount: 2, usage: usage([["five_hour", "5-hour", 18, 210], ["seven_day", "Weekly", 33, 4 * 1440]]), folders: ["~/code/web-app"], trend: flat, forecast: { windowLabel: "Weekly", runsOutAt: null, resetsAt: iso(4 * 1440) } },
    { ...base, id: "claude-c", family: "claude", label: "Side project", email: "sam@example.com", plan: "max", status: "ready", agentCount: 0, usage: usage([["five_hour", "5-hour", 4, 280], ["seven_day", "Weekly", 12, 6 * 1440]]) },
    { ...base, id: "claude-k", family: "claude", label: "Team", email: "team@example.com", plan: "max", status: "limited", limitedUntil: iso(48), agentCount: 0, priority: "last", usage: usage([["five_hour", "5-hour", 100, 48], ["seven_day", "Weekly", 87, 2 * 1440]]) },
    { ...base, id: "codex-main", family: "codex", label: "ChatGPT (CLI login)", kind: "main", status: "signed_out", isDefault: true, usage: null },
    { ...base, id: "kimi-main", family: "kimi", label: "Main", kind: "main", plan: "Ultra", status: "ready", isDefault: true, agentCount: 1, usage: usage([["five_hour", "5-hour", 0.3, 60], ["month", "Monthly", 15.3, 9 * 1440]]) },
    { ...base, id: "opencode-main", family: "opencode", label: "OpenCode Go 1", kind: "main", plan: "Go", status: "ready", isDefault: true, usage: { ...usage([]), error: "OpenCode Go doesn't report usage to other apps." } },
  ],
  agents: [
    { agentId: "a1", provider: "claude", title: "Fix checkout rounding bug", cwd: "~/code/storefront", status: "running", family: "claude", accountId: "claude-main", pinned: false, pendingAccountId: null, movable: true },
    { agentId: "a2", provider: "claude", title: "Upgrade API dependencies", cwd: "~/code/api", status: "idle", family: "claude", accountId: "claude-main", pinned: false, pendingAccountId: null, movable: true },
    { agentId: "a3", provider: "claude", title: "Write onboarding guide", cwd: "~/code/docs", status: "running", family: "claude", accountId: "claude-main", pinned: true, pendingAccountId: "claude-c", movable: true },
    { agentId: "a4", provider: "claude", title: "Add dark mode", cwd: "~/code/web-app", status: "running", family: "claude", accountId: "claude-j", pinned: false, pendingAccountId: null, movable: true },
    { agentId: "a5", provider: "claude", title: "Refactor settings page", cwd: "~/code/web-app", status: "idle", family: "claude", accountId: "claude-j", pinned: false, pendingAccountId: null, movable: true },
    { agentId: "a6", provider: "kimi", title: "Fix push notifications", cwd: "~/code/mobile", status: "error", family: "kimi", accountId: "kimi-main", pinned: false, pendingAccountId: null, movable: true },
  ],
  logins: [],
  activity: [
    { agentId: "a4", agentTitle: "Add dark mode", row: { family: "claude", from: "Work", to: "Personal", reason: "early", resetsAt: null, continued: false, continuedIn: null, toFamily: null, outcome: "switched", detail: null, at: iso(-12) } },
    { agentId: "a3", agentTitle: "Write onboarding guide", row: { family: "claude", from: "Team", to: "Work", reason: "limit", resetsAt: null, continued: false, continuedIn: null, toFamily: null, outcome: "switched", detail: null, at: iso(-54) } },
    { agentId: "a2", agentTitle: "Upgrade API dependencies", row: { family: "claude", from: "Team", to: "Team", reason: "exhausted", resetsAt: null, continued: false, continuedIn: null, toFamily: null, outcome: "stayed", detail: null, at: iso(-180) } },
  ],
  nextUp: { claude: "claude-c", kimi: "kimi-main", opencode: "opencode-main", codex: "codex-main" },
  providers: { claude: "claude", codex: "codex", kimi: "kimi", opencode: "opencode" },
  canReopen: true,
  installed: ["claude", "codex", "kimi", "opencode"],
  browserSignIn: true,
  showComposerPill: true,
  warnings: [],
  hostTimeZone: { name: Intl.DateTimeFormat().resolvedOptions().timeZone, offsetMinutes: -new Date().getTimezoneOffset() },
};
