import { spawn } from "node:child_process";
import { delimiter } from "node:path";
import type { LoginMethod, UsageWindow } from "../shared/model";
import {
  ProgressEmitter,
  spawnEnv,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LoginHandle,
  type RedeemReply,
  type UsageRead,
} from "./adapter";
import { providerCommand, quietBrowserDir } from "./binaries";
import { run, stripAnsi } from "./process";

/** One account's limits, as `omp usage --json` reports them. */
interface OmpReport {
  provider?: unknown;
  metadata?: Record<string, unknown>;
  limits?: Array<{
    id?: unknown;
    label?: unknown;
    scope?: { accountId?: unknown; projectId?: unknown };
    window?: { label?: unknown; resetsAt?: unknown };
    amount?: { used?: unknown; limit?: unknown; usedFraction?: unknown };
  }>;
}

interface OmpUsage {
  reports?: OmpReport[];
  accountsWithoutUsage?: Array<{ provider?: unknown; email?: unknown }>;
}

const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function accountName(report: OmpReport, index: number): string {
  const meta = report.metadata ?? {};
  const scoped = report.limits?.map((limit) => text(limit.scope?.accountId) ?? text(limit.scope?.projectId)).find(Boolean);
  return text(meta.email) ?? text(meta.accountId) ?? scoped ?? `account ${index + 1}`;
}

/** Every pooled account's limits as usage bars, named after the account they belong to. */
export function parseOmpUsage(usage: OmpUsage): UsageWindow[] {
  const windows: UsageWindow[] = [];
  (usage.reports ?? []).forEach((report, index) => {
    const who = accountName(report, index);
    for (const limit of report.limits ?? []) {
      const amount = limit.amount ?? {};
      const used = Number(amount.used);
      const cap = Number(amount.limit);
      const fraction = Number.isFinite(Number(amount.usedFraction))
        ? Number(amount.usedFraction)
        : Number.isFinite(used) && Number.isFinite(cap) && cap > 0
          ? used / cap
          : NaN;
      if (!Number.isFinite(fraction)) continue;
      const resets = Number(limit.window?.resetsAt);
      const title = text(limit.window?.label) ?? text(limit.label) ?? "limit";
      windows.push({
        id: `${String(report.provider)}:${who}:${text(limit.id) ?? title}`,
        label: `${who} · ${title}`,
        usedPercent: Math.min(100, Math.max(0, fraction * 100)),
        resetsAt: Number.isFinite(resets) && resets > 0 ? new Date(resets).toISOString() : null,
      });
    }
  });
  return windows;
}

/** Providers with an account in the pool, most common first. */
function pooledProviders(usage: OmpUsage): string[] {
  const providers = [...(usage.reports ?? []), ...(usage.accountsWithoutUsage ?? [])].map((entry) => text(entry.provider)).filter((p): p is string => p !== null);
  return [...new Set(providers)];
}

/**
 * Oh My Pi keeps several accounts per provider and rotates between them on limits by itself. So it
 * shows here as one card: the CLI login, with every pooled account's usage, and "Add account" runs
 * `omp login` to add one more to that pool. Nothing is routed, and limits are left to Oh My Pi.
 */
export class OmpAdapter implements FamilyAdapter {
  readonly family = "omp" as const;
  readonly portable = true;
  readonly usageSpacingMs = 120_000;

  private async read(): Promise<OmpUsage | null> {
    const { command } = await providerCommand("omp");
    const result = await run(command, ["usage", "--json"], { timeoutMs: 60_000 });
    if (result.code !== 0) return null;
    try {
      return JSON.parse(result.stdout) as OmpUsage;
    } catch {
      return null;
    }
  }

  async env(): Promise<EnvPatch> {
    return {};
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command } = await providerCommand("omp");
    const result = await run(command, ["--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  async prepareHome(): Promise<void> {
    // Oh My Pi's accounts all live in its own database; there are no per-account folders.
  }

  async identity(): Promise<Identity> {
    const usage = await this.read();
    const count = (usage?.reports?.length ?? 0) + (usage?.accountsWithoutUsage?.length ?? 0);
    if (!usage || count === 0) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    return { signedIn: true, email: null, plan: `${count} account${count === 1 ? "" : "s"}`, organization: null, identity: "omp|pool" };
  }

  async usage(): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const usage = await this.read();
    if (!usage) return { fetchedAt, windows: [], error: "Couldn't read `omp usage`.", cached: false, resets: null };
    return { fetchedAt, windows: parseOmpUsage(usage), error: null, cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Use `omp usage reset` for Oh My Pi's banked resets.", left: null };
  }

  async login(_home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    const { command } = await providerCommand("omp");
    // A new account joins the provider the pool already uses (Claude when it's empty).
    const provider = pooledProviders((await this.read()) ?? {})[0] ?? "anthropic";
    const env = spawnEnv({});
    const quiet = await quietBrowserDir();
    if (quiet) env.PATH = `${quiet}${delimiter}${env.PATH ?? ""}`;
    return new OmpLogin(command, provider, env);
  }

  async logout(): Promise<void> {
    // Accounts are removed with `omp` itself.
  }

  /** Oh My Pi rotates to another pooled account itself, so its limits never move the agent here. */
  detectLimit = () => null;
  detectSignOut = () => null;
}

class OmpLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;

  constructor(command: string, provider: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, ["login", provider], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => undefined);
    const read = (chunk: Buffer) => {
      this.output += stripAnsi(chunk.toString("utf8"));
      const parsed = parseOmpLogin(this.output);
      if (parsed && (this.progress.url !== parsed.url || this.progress.codeUrl !== parsed.codeUrl || this.progress.userCode !== parsed.userCode)) {
        this.update({ step: "waiting", ...parsed });
      }
    };
    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not start Oh My Pi: ${error.message}` }));
      this.child.on("close", (code) => {
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0 && /Logged in to/i.test(this.output)) return resolve({ ok: true, message: null });
        const failure = this.output.match(/Login failed: .*/)?.[0] ?? this.output.trim().split("\n").filter(Boolean).pop();
        resolve({ ok: false, message: failure ?? `omp login exited with code ${code}` });
      });
    });
  }

  async submitCode(code: string): Promise<void> {
    this.child.stdin.write(`${code.trim()}\n`);
  }

  cancel(): void {
    this.canceled = true;
    this.child.kill("SIGTERM");
  }
}

/**
 * `omp login` prints the sign-in link, maybe a local shortcut that finishes on the host itself, and
 * for paste-code providers a prompt for the code. Device flows show a code to enter on the page.
 */
export function parseOmpLogin(output: string): { url: string; codeUrl: string | null; userCode: string | null } | null {
  const link = output.match(/Open this URL in your browser:\s*\n(\S+)/)?.[1];
  if (!link) return null;
  const shortcut = output.match(/Local shortcut \(this machine only\): (\S+)/)?.[1];
  const pastes = /Paste the authorization code/i.test(output);
  const userCode = output.match(/(?:enter|user) code:?\s*([A-Z0-9]{4}-?[A-Z0-9]{4})/i)?.[1] ?? null;
  return { url: shortcut ?? link, codeUrl: pastes ? link : null, userCode };
}
