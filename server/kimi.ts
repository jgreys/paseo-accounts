import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { delimiter, join } from "node:path";
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
import { prepareKimiHome } from "./homes";
import { detectKimiLimit, detectKimiSignOut } from "./limits";
import { mainKimiHome } from "./paths";
import { run, stripAnsi } from "./process";

/** Kimi Code's managed API. Usage and profile only answer here, whatever region the config names. */
function apiBase(): string {
  return (process.env.KIMI_CODE_BASE_URL ?? "https://api.kimi.com/coding/v1").replace(/\/+$/, "");
}

interface KimiToken {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch seconds. */
  expiresAt: number;
}

/**
 * The sign-in Kimi Code stores for a home: `config.toml` names it (`key = "oauth/<name>"`), and
 * `credentials/<name>.json` holds the tokens. Read only; the CLI does every refresh itself.
 */
export async function readKimiToken(home: string): Promise<KimiToken | null> {
  const config = await readFile(join(home, "config.toml"), "utf8").catch(() => "");
  const named = config.match(/^\s*key\s*=\s*"oauth\/(kimi-code[^"]*)"/m)?.[1];
  const stored = (await readdir(join(home, "credentials")).catch(() => [] as string[])).filter((file) => file.endsWith(".json"));
  const files = named ? [`${named}.json`, ...stored.filter((file) => file !== `${named}.json`)] : stored;
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(home, "credentials", file), "utf8")) as Record<string, unknown>;
      if (typeof raw.access_token !== "string") continue;
      return {
        accessToken: raw.access_token,
        refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : null,
        expiresAt: typeof raw.expires_at === "number" ? raw.expires_at : 0,
      };
    } catch {
      // Missing or half-written: try the next one.
    }
  }
  return null;
}

function isFresh(token: KimiToken | null): token is KimiToken {
  return Boolean(token) && token!.expiresAt * 1000 > Date.now() + 30_000;
}

/** The user ID inside the access token, so an account is recognised even while the token is stale. */
function tokenUser(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.user_id === "string" ? payload.user_id : typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

async function getJson(path: string, token: string): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number }> {
  const response = await fetch(`${apiBase()}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return { ok: false, status: response.status };
  return { ok: true, body: (await response.json()) as Record<string, unknown> };
}

const WINDOWS: ReadonlyArray<{ key: string; id: string; label: string }> = [
  { key: "limit_5h", id: "five_hour", label: "5-hour" },
  { key: "limit_7d", id: "seven_day", label: "Weekly" },
  { key: "limit_month_total", id: "month", label: "Monthly" },
];

export function parseKimiUsage(body: Record<string, unknown>): UsageWindow[] {
  const usages = body.usages && typeof body.usages === "object" ? (body.usages as Record<string, unknown>) : {};
  const windows: UsageWindow[] = [];
  for (const { key, id, label } of WINDOWS) {
    const entry = usages[key] as { used_ratio?: unknown; reset_time?: unknown } | undefined;
    const ratio = Number(entry?.used_ratio);
    if (!entry || !Number.isFinite(ratio)) continue;
    windows.push({
      id,
      label,
      usedPercent: Math.min(100, Math.max(0, ratio * 100)),
      resetsAt: typeof entry.reset_time === "string" && entry.reset_time ? entry.reset_time : null,
    });
  }
  return windows;
}

export class KimiAdapter implements FamilyAdapter {
  readonly family = "kimi" as const;
  /** Sessions live in the shared folder, and nothing in them is tied to one account. */
  readonly portable = true;
  readonly usageSpacingMs = 60_000;

  /** Paseo runs Kimi as `kimi acp`; the plugin's own calls need just the binary. */
  private async binary(): Promise<string> {
    return (await providerCommand("kimi")).command;
  }

  async env(home: string | null): Promise<EnvPatch> {
    return { KIMI_CODE_HOME: home };
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const command = await this.binary();
    const result = await run(command, ["--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareKimiHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    const token = await readKimiToken(home ?? mainKimiHome());
    if (!token?.refreshToken) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    let user = tokenUser(token.accessToken);
    let email: string | null = null;
    let plan: string | null = null;
    if (isFresh(token)) {
      const me = await getJson("me", token.accessToken).catch(() => null);
      if (me?.ok) {
        const body = me.body;
        user = typeof body.user_id === "string" ? body.user_id : user;
        email = [body.email, body.username, body.nickname].find((value): value is string => typeof value === "string" && value !== "") ?? null;
        plan = typeof body.user_level_name === "string" && body.user_level_name ? body.user_level_name : null;
      }
    }
    return { signedIn: true, email, plan, organization: null, identity: user ? `kimi|${user}` : null };
  }

  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const token = await readKimiToken(home ?? mainKimiHome());
    if (!isFresh(token)) {
      return { fetchedAt, windows: [], error: "Usage shows after this account is next used.", cached: false, resets: null };
    }
    try {
      const reply = await getJson("usages", token.accessToken);
      if (!reply.ok) return { fetchedAt, windows: [], error: `Usage request failed (HTTP ${reply.status})`, cached: false, resets: null };
      return { fetchedAt, windows: parseKimiUsage(reply.body), error: null, cached: false, resets: null };
    } catch (error) {
      return { fetchedAt, windows: [], error: error instanceof Error ? error.message : String(error), cached: false, resets: null };
    }
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Kimi has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    const env = spawnEnv(await this.env(home));
    const quiet = await quietBrowserDir();
    if (quiet) env.PATH = `${quiet}${delimiter}${env.PATH ?? ""}`;
    return new KimiLogin(await this.binary(), env);
  }

  async logout(_home: string): Promise<void> {
    // The sign-in lives in the home itself, which is deleted next.
  }

  detectLimit = detectKimiLimit;
  detectSignOut = detectKimiSignOut;
}

/** `kimi login`: prints a device-code link and code, then waits until it's approved. */
class KimiLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;

  constructor(command: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, ["login"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const read = (chunk: Buffer) => {
      this.output += stripAnsi(chunk.toString("utf8"));
      const link = parseKimiLogin(this.output);
      if (link && this.progress.step === "starting") this.update({ step: "waiting", url: link.url, userCode: link.code });
    };
    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not start Kimi Code: ${error.message}` }));
      this.child.on("close", (code) => {
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0) return resolve({ ok: true, message: null });
        const last = this.output.trim().split("\n").filter(Boolean).pop();
        resolve({ ok: false, message: last ?? `kimi login exited with code ${code}` });
      });
    });
  }

  async submitCode(): Promise<void> {
    throw new Error("Kimi signs in on its own page; there's no code to paste here.");
  }

  cancel(): void {
    this.canceled = true;
    this.child.kill("SIGTERM");
  }
}

/** The link and code from `kimi login`'s output, once both have been printed. */
export function parseKimiLogin(output: string): { url: string; code: string | null } | null {
  const url = output.match(/https:\/\/\S+authorize_device\S*/)?.[0] ?? output.match(/https:\/\/\S+/)?.[0];
  if (!url) return null;
  const code = output.match(/enter code:\s*([A-Z0-9-]{4,})/i)?.[1] ?? new URL(url).searchParams.get("user_code");
  return { url, code };
}
