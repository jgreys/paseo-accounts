import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FamilySchema, LoginMethodSchema, LoginViewSchema, StateViewSchema } from "./model";

export const getState = defineRpc({
  name: "paseo-accounts.state",
  input: z.object({ refreshUsage: z.boolean().optional() }),
  output: StateViewSchema,
});

export const startLogin = defineRpc({
  name: "paseo-accounts.login.start",
  input: z.object({
    family: FamilySchema,
    /** Sign an existing account back in instead of adding a new one. */
    accountId: z.string().optional(),
    method: LoginMethodSchema.default("browser"),
  }),
  output: LoginViewSchema,
});

export const submitLoginCode = defineRpc({
  name: "paseo-accounts.login.code",
  input: z.object({ loginId: z.string(), code: z.string().trim().min(1) }),
  output: LoginViewSchema,
});

export const cancelLogin = defineRpc({
  name: "paseo-accounts.login.cancel",
  input: z.object({ loginId: z.string() }),
  output: LoginViewSchema.nullable(),
});

export const renameAccount = defineRpc({
  name: "paseo-accounts.accounts.rename",
  input: z.object({ accountId: z.string(), label: z.string().trim().min(1).max(40) }),
  output: z.object({ ok: z.literal(true) }),
});

export const removeAccount = defineRpc({
  name: "paseo-accounts.accounts.remove",
  input: z.object({ accountId: z.string() }),
  output: z.object({ ok: z.literal(true), movedAgents: z.number() }),
});

/** Signs an account out but keeps it listed, so it can be signed in again. */
export const signOutAccount = defineRpc({
  name: "paseo-accounts.accounts.signout",
  input: z.object({ accountId: z.string() }),
  output: z.object({ ok: z.literal(true), movedAgents: z.number() }),
});

export const ReopenSummarySchema = z.object({
  reopened: z.array(z.string()),
  /** Busy agents move when their current turn ends. */
  deferred: z.array(z.string()),
  failed: z.array(z.object({ agentId: z.string(), error: z.string() })),
  /** A conversation that could not move in place and continues in this new agent instead. */
  continuedIn: z.object({ agentId: z.string(), title: z.string() }).nullable().default(null),
});
export type ReopenSummary = z.infer<typeof ReopenSummarySchema>;

export const clearAccountLimit = defineRpc({
  name: "paseo-accounts.accounts.available",
  input: z.object({ accountId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

export const RedeemOutcomeSchema = z.enum([
  /** Limits were refilled. */
  "reset",
  /** The provider kept the reset because the account isn't at a limit. */
  "not_limited",
  /** No banked reset to use. */
  "none",
  "already_used",
  /** Resets are cooling down; try later. */
  "cooldown",
  /** The provider won't let this account use a reset right now. */
  "unavailable",
  /** The request failed or its result is unknown. */
  "error",
]);
export type RedeemOutcome = z.infer<typeof RedeemOutcomeSchema>;

export const RedeemResultSchema = z.object({
  outcome: RedeemOutcomeSchema,
  message: z.string(),
  /** Resets left afterwards, when the provider says. */
  left: z.number().nullable(),
  /** The agent the reset was used for, if any, was told to carry on. */
  continued: z.boolean(),
});
export type RedeemResult = z.infer<typeof RedeemResultSchema>;

export const redeemReset = defineRpc({
  name: "paseo-accounts.accounts.redeem",
  input: z.object({
    accountId: z.string(),
    /** An agent stopped by this account's limit; it carries on after a successful reset. */
    agentId: z.string().optional(),
  }),
  output: RedeemResultSchema,
});

export const setDefaultAccount = defineRpc({
  name: "paseo-accounts.accounts.default",
  input: z.object({ accountId: z.string() }),
  output: ReopenSummarySchema,
});

/** The folders whose agents use this account (and that other agents leave it to). Paths may start with `~`. */
export const setAccountPriority = defineRpc({
  name: "paseo-accounts.accounts.priority",
  input: z.object({ accountId: z.string(), priority: z.enum(["first", "normal", "last"]) }),
  output: z.object({ ok: z.literal(true) }),
});

/** Sends a test alert to a URL, so the user can check it arrives before saving it. */
export const testAlert = defineRpc({
  name: "paseo-accounts.alerts.test",
  input: z.object({ url: z.string().trim().url() }),
  output: z.object({ ok: z.literal(true) }),
});

export const setAccountFolders = defineRpc({
  name: "paseo-accounts.accounts.folders",
  input: z.object({ accountId: z.string(), paths: z.array(z.string().trim().min(1)).max(50) }),
  output: ReopenSummarySchema,
});

/** Sets an account aside for a while (nothing is routed to it) or brings it back. */
export const setAccountEnabled = defineRpc({
  name: "paseo-accounts.accounts.enabled",
  input: z.object({ accountId: z.string(), enabled: z.boolean() }),
  output: ReopenSummarySchema.extend({
    /** ChatGPT conversations that stay on the disabled account because they can't change accounts. */
    stayed: z.number(),
  }),
});

/** Carries an agent's work on in a new agent on another provider (`to`, or the first viable one). */
export const forkAgent = defineRpc({
  name: "paseo-accounts.agents.fork",
  input: z.object({ agentId: z.string(), to: z.string().optional() }),
  output: z.object({ agentId: z.string(), title: z.string() }),
});

export const setAgentAccount = defineRpc({
  name: "paseo-accounts.agents.account",
  input: z.object({
    agentId: z.string(),
    /** `null` makes the agent follow the default account again. */
    accountId: z.string().nullable(),
  }),
  output: ReopenSummarySchema,
});
