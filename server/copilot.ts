import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { LoginMethod } from "../shared/model";
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
import { prepareCopilotHome } from "./homes";
import { detectCopilotLimit, detectCopilotSignOut } from "./limits";
import { mainCopilotHome } from "./paths";
import { run, stripAnsi } from "./process";

/** Copilot CLI prefers these over its stored sign-in, so a daemon-wide value must not leak in. */
const TOKEN_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

/** The GitHub user a Copilot home last signed in as (`config.json` → `lastLoggedInUser`). */
export async function copilotUser(home: string): Promise<{ login: string; host: string } | null> {
  try {
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8")) as Record<string, unknown>;
    const user = (config.lastLoggedInUser ?? config.last_logged_in_user) as { login?: unknown; host?: unknown } | undefined;
    if (typeof user?.login !== "string" || !user.login) return null;
    return { login: user.login, host: typeof user.host === "string" ? user.host : "https://github.com" };
  } catch {
    return null;
  }
}

export class CopilotAdapter implements FamilyAdapter {
  readonly family = "copilot" as const;
  /** Session events live in the shared `session-state`, and Copilot re-resolves sign-in on resume. */
  readonly portable = true;
  readonly usageSpacingMs = 60_000;

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { COPILOT_HOME: null };
    const patch: EnvPatch = { COPILOT_HOME: home };
    for (const key of TOKEN_KEYS) if (process.env[key]) patch[key] = "";
    return patch;
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command } = await providerCommand("copilot");
    const result = await run(command, ["--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareCopilotHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    const user = await copilotUser(home ?? mainCopilotHome());
    if (!user) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    const host = new URL(user.host).host;
    return {
      signedIn: true,
      email: user.login,
      plan: null,
      organization: host === "github.com" ? null : host,
      identity: `copilot|${host}|${user.login.toLowerCase()}`,
    };
  }

  async usage(): Promise<UsageRead> {
    // Reading quota needs the token from the keychain, which would prompt on the daemon's machine.
    return { fetchedAt: new Date().toISOString(), windows: [], error: "Copilot usage isn't shown here yet.", cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Copilot has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    const { command } = await providerCommand("copilot");
    const env = spawnEnv(await this.env(home));
    // With a token variable set, `copilot login` would save that token instead of signing in.
    for (const key of TOKEN_KEYS) delete env[key];
    const quiet = await quietBrowserDir();
    if (quiet) env.PATH = `${quiet}${delimiter}${env.PATH ?? ""}`;
    return new CopilotLogin(command, env);
  }

  async logout(_home: string): Promise<void> {
    // The token stays in the keychain under the user's name, shared with any other home that uses it.
  }

  detectLimit = detectCopilotLimit;
  detectSignOut = detectCopilotSignOut;
}

/** `copilot login --device-code`: prints a link and code, then waits until it's approved. */
class CopilotLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;

  constructor(command: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, ["login", "--device-code"], { env, stdio: ["ignore", "pipe", "pipe"] });
    const read = (chunk: Buffer) => {
      this.output += stripAnsi(chunk.toString("utf8"));
      const link = parseCopilotLogin(this.output);
      if (link && this.progress.step === "starting") this.update({ step: "waiting", url: link.url, userCode: link.code });
    };
    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not start Copilot CLI: ${error.message}` }));
      this.child.on("close", (code) => {
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0 && !/token was not saved/i.test(this.output)) return resolve({ ok: true, message: null });
        const last = this.output.trim().split("\n").filter(Boolean).pop();
        resolve({ ok: false, message: last ?? `copilot login exited with code ${code}` });
      });
    });
  }

  async submitCode(): Promise<void> {
    throw new Error("Copilot signs in on GitHub's page; there's no code to paste here.");
  }

  cancel(): void {
    this.canceled = true;
    this.child.kill("SIGTERM");
  }
}

export function parseCopilotLogin(output: string): { url: string; code: string } | null {
  const match = output.match(/visit (https?:\/\/\S+) and enter code (\S+)/i);
  return match?.[1] && match[2] ? { url: match[1], code: match[2] } : null;
}
