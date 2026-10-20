import { z } from "zod";

/** The subscription families this plugin manages. Custom provider profiles map onto one of them. */
export const FamilySchema = z.enum(["claude", "codex", "copilot", "kimi", "opencode", "pi", "omp"]);
export type Family = z.infer<typeof FamilySchema>;
export const FAMILIES: readonly Family[] = FamilySchema.options;

export const FAMILY_LABEL: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  copilot: "Copilot",
  kimi: "Kimi",
  opencode: "OpenCode Go",
  pi: "Pi",
  omp: "Oh My Pi",
};

/** Section headings on the Accounts screen. */
export const FAMILY_HEADING: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT (Codex)",
  copilot: "GitHub Copilot",
  kimi: "Kimi Code",
  opencode: "OpenCode Go",
  pi: "Pi",
  omp: "Oh My Pi",
};

/**
 * Providers a stopped chat can carry on with when every account of its own is out, most preferred
 * first. The first one here that is installed and has a usable account takes over in a new agent.
 */
export const FALLBACK_ORDER: readonly Family[] = ["claude", "codex", "kimi", "opencode", "copilot", "pi", "omp"];

/** The providers a `from` agent can carry on with, most preferred first. */
export function fallbackFamilies(from: Family): Family[] {
  return FALLBACK_ORDER.filter((family) => family !== from);
}

/** A family or provider id for people: the family label when there is one, else the id itself. */
export function familyLabel(id: string): string {
  return (FAMILY_LABEL as Record<string, string>)[id] ?? id;
}

export const UsageWindowSchema = z.object({
  /** Stable key, e.g. `five_hour`, `seven_day`, `seven_day_opus`, `primary`, `secondary`. */
  id: z.string(),
  label: z.string(),
  /** 0–100. */
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Banked limit resets the provider has granted this account (Claude "limit reset", Codex reset credits). */
export const ResetOfferSchema = z.object({
  /** Resets left to use. */
  available: z.number(),
  /** The provider will accept a redeem right now. */
  usableNow: z.boolean(),
  /** Why it can't be used yet, in plain words, when it can't. */
  blockedReason: z.string().nullable(),
  /** Use-by date of the next reset, if it expires. */
  expiresAt: z.string().nullable(),
  /** Which limits a reset refills, e.g. "5-hour", "weekly". Empty when the provider doesn't say. */
  refills: z.array(z.string()),
  /** The provider's own name for the reset, if it gives one. */
  label: z.string().nullable(),
});
export type ResetOffer = z.infer<typeof ResetOfferSchema>;

export const UsageSchema = z.object({
  fetchedAt: z.string(),
  windows: z.array(UsageWindowSchema),
  /** Why usage could not be read, if it could not. Old windows may still be shown. */
  error: z.string().nullable(),
  /** Read from the CLI's own cache rather than the provider, so possibly out of date. */
  cached: z.boolean().default(false),
  /** Banked resets, when the provider reports any. */
  resets: ResetOfferSchema.nullable().default(null),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountKindSchema = z.enum([
  /** The login the CLI uses on its own (`~/.claude`, `~/.codex`). */
  "main",
  /** Created by this plugin: an isolated credential home that shares everything else with main. */
  "managed",
]);
export type AccountKind = z.infer<typeof AccountKindSchema>;

/** `disabled`: the user set it aside for a while; it stays signed in but nothing is routed to it. */
export const AccountStatusSchema = z.enum(["ready", "signed_out", "limited", "checking", "disabled"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  label: z.string(),
  kind: AccountKindSchema,
  email: z.string().nullable(),
  plan: z.string().nullable(),
  organization: z.string().nullable(),
  status: AccountStatusSchema,
  isDefault: z.boolean(),
  limitedUntil: z.string().nullable(),
  usage: UsageSchema.nullable(),
  agentCount: z.number(),
  home: z.string().nullable(),
  /** Automatic picks try `first` accounts before `normal` ones, and `last` ones only when the rest are out. */
  priority: z.enum(["first", "normal", "last"]).default("normal"),
  /** When the account runs out at its recent pace (`runsOutAt` null: it lasts until the window resets). */
  forecast: z
    .object({
      windowLabel: z.string(),
      runsOutAt: z.string().nullable(),
      resetsAt: z.string().nullable(),
      /** The same times as the host shows them, in its own time zone ("Thu 02:12"). */
      runsOutText: z.string().nullable().default(null),
      resetsText: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** The forecast window's usage over the last week, oldest first; `null` where nothing was read. */
  trend: z.array(z.number().nullable()).default([]),
  /** Folders whose agents use this account; other agents leave it alone. */
  folders: z.array(z.string()).default([]),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const AgentRouteSchema = z.object({
  agentId: z.string(),
  family: FamilySchema,
  /** Account the agent uses now, or will use when its session next opens. */
  accountId: z.string(),
  /** Chosen for this agent explicitly (by the user or an automatic switch) rather than following the default. */
  pinned: z.boolean(),
  /** The live session still runs on a different account and is waiting to be reopened. */
  pendingAccountId: z.string().nullable(),
  /**
   * The conversation can move to another account in place. False for Codex agents that already
   * have history: ChatGPT accounts can't read each other's encrypted reasoning, so switching
   * continues the work in a new agent instead.
   */
  movable: z.boolean(),
  provider: z.string().default(""),
  title: z.string().nullable().default(null),
  /** The agent's working folder. */
  cwd: z.string().nullable().default(null),
  /** Paseo's agent status: initializing, idle, running, error or closed. */
  status: z.string().default("idle"),
});
export type AgentRoute = z.infer<typeof AgentRouteSchema>;

export const LoginStepSchema = z.enum([
  "starting",
  /** Waiting for the user to finish on the sign-in page (and paste a code, if using `codeUrl`). */
  "waiting",
  "verifying",
  "done",
  "failed",
  "canceled",
]);
export type LoginStep = z.infer<typeof LoginStepSchema>;

export const LoginMethodSchema = z.enum([
  /** Finishes by itself when the link is opened on the daemon machine. */
  "browser",
  /** Works from any device: paste a code back (Claude) or type a code on the page (ChatGPT). */
  "code",
]);
export type LoginMethod = z.infer<typeof LoginMethodSchema>;

export const LoginViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  method: LoginMethodSchema,
  /** Set once the account exists (immediately when signing an existing account back in). */
  accountId: z.string().nullable(),
  step: LoginStepSchema,
  /** Link that completes by itself (browser callback) or the device-code page. */
  url: z.string().nullable(),
  /** Link whose page shows a code to paste back; works from any device. */
  codeUrl: z.string().nullable(),
  /** Device code the user types on the sign-in page (ChatGPT device flow). */
  userCode: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.string(),
});
export type LoginView = z.infer<typeof LoginViewSchema>;

export const StateViewSchema = z.object({
  accounts: z.array(AccountViewSchema),
  agents: z.array(AgentRouteSchema),
  logins: z.array(LoginViewSchema),
  /** Recent account switches across every agent, newest first. */
  activity: z
    .array(z.object({ agentId: z.string(), agentTitle: z.string().nullable(), row: z.record(z.string(), z.unknown()) }))
    .default([]),
  /** The account each provider's next new agent will start on. */
  nextUp: z.record(z.string(), z.string()).default({}),
  /** Paseo provider IDs (including custom profiles) that route through each family. */
  providers: z.record(z.string(), FamilySchema),
  /** Live sessions can be reopened on another account without waiting for the next session start. */
  canReopen: z.boolean(),
  /** The host's time zone, so times can say whose clock they're on when it differs from the viewer's. */
  hostTimeZone: z.object({ name: z.string(), offsetMinutes: z.number() }).default({ name: "UTC", offsetMinutes: 0 }),
  /** Providers whose CLI is installed where the daemon runs, so accounts can be added for them. */
  installed: z.array(FamilySchema).default([]),
  /** Available Paseo providers without plugin accounts, offered as fork targets. */
  fallbacks: z.array(z.object({ id: z.string(), label: z.string() })).default([]),
  /**
   * A browser on the daemon's machine can finish a sign-in by itself. False on servers, containers
   * and daemons started over SSH, where only the code sign-in works.
   */
  browserSignIn: z.boolean().default(true),
  showComposerPill: z.boolean(),
  warnings: z.array(z.string()),
});
export type StateView = z.infer<typeof StateViewSchema>;
