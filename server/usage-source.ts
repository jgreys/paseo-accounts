import type { UsageReport, UsageWindow as PaseoWindow } from "@getpaseo/plugin/server/usage";
import { formatPlan } from "../shared/format";
import type { Usage } from "../shared/model";
import type { StoredAccount } from "./state";

/** Paseo wants `[A-Za-z0-9._-]{1,128}`; our ids already are, this only guards odd ones. */
export function usageKey(accountId: string): string {
  return accountId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128) || "account";
}

const SHORT: Record<string, string> = { five_hour: "5h", seven_day: "wk", primary: "5h", secondary: "wk", month: "mo" };

function tone(used: number): PaseoWindow["tone"] {
  return used >= 100 ? "danger" : used >= 80 ? "warning" : "ok";
}

/** One account's last reading, in the shape of Paseo's Usage view. Never asks the provider again. */
export function usageReport(account: StoredAccount, usage: Usage | undefined): UsageReport {
  if (!account.signedIn) return { status: "error", error: "Signed out. Sign in again in Accounts." };
  if (!usage || usage.windows.length === 0) return { status: "error", error: usage?.error ?? "No usage reading yet." };
  // The account-wide windows go in the summary; a provider that names none of them shows its first.
  const summary = (id: string, index: number) => (SHORT[id] !== undefined || (index === 0 && !usage.windows.some((w) => SHORT[w.id])));
  const windows = usage.windows.map((window, index): PaseoWindow => ({
    id: window.id,
    label: window.label,
    ...(SHORT[window.id] ? { shortLabel: SHORT[window.id] } : {}),
    ...(summary(window.id, index) ? { summary: true } : {}),
    usedPct: window.usedPercent,
    remainingPct: Math.max(0, 100 - window.usedPercent),
    resetsAt: window.resetsAt,
    tone: tone(window.usedPercent),
  }));
  const plan = formatPlan(account.plan);
  const extra = usage.extra;
  const balances = extra && extra.currency === "USD"
    ? [{ id: "extra_usage", label: "Extra usage", used: extra.usedMinor / 10 ** extra.exponent, limit: extra.limitMinor / 10 ** extra.exponent, remaining: Math.max(0, extra.limitMinor - extra.usedMinor) / 10 ** extra.exponent, unit: "usd" as const }]
    : [];
  return { status: "available", ...(plan ? { planLabel: plan } : {}), windows, ...(balances.length ? { balances } : {}) };
}
