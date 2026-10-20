import { spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
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
import { preparePiHome } from "./homes";
import { detectApiStyleLimit, detectClaudeLimit, detectKimiSignOut } from "./limits";
import { mainPiDir } from "./paths";
import { run, stripAnsi } from "./process";

/** Subscription sign-ins Pi supports, in the order an account picks one when the CLI login has several. */
const OAUTH_PROVIDERS = ["anthropic", "openai-codex", "github-copilot"] as const;
const PROVIDER_LABEL: Record<string, string> = { anthropic: "Claude", "openai-codex": "ChatGPT", "github-copilot": "Copilot" };

type AuthFile = Record<string, { type?: unknown; access?: unknown } | undefined>;

async function readAuth(dir: string): Promise<AuthFile> {
  try {
    const value = JSON.parse(await readFile(join(dir, "auth.json"), "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as AuthFile) : {};
  } catch {
    return {};
  }
}

const oauthProviders = (auth: AuthFile) => OAUTH_PROVIDERS.filter((id) => auth[id]?.type === "oauth");

/** The email in a ChatGPT access token, the only Pi sign-in that names its account. */
function tokenEmail(token: unknown): string | null {
  if (typeof token !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
    const profile = payload["https://api.openai.com/profile"] as { email?: unknown } | undefined;
    return typeof profile?.email === "string" ? profile.email : typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** Pi's OAuth module (from `@mariozechner/pi-ai`), found next to the installed `pi`. */
export async function findPiOAuth(command: string): Promise<string | null> {
  let binary = command;
  if (!isAbsolute(binary)) {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (directory && (await exists(join(directory, command)))) {
        binary = join(directory, command);
        break;
      }
    }
  }
  const cli = await realpath(binary).catch(() => null);
  if (!cli) return null;
  const root = dirname(dirname(cli)); // …/pi-coding-agent/dist/cli.js
  for (const candidate of [join(root, "node_modules", "@mariozechner", "pi-ai"), join(dirname(root), "pi-ai")]) {
    const index = join(candidate, "dist", "utils", "oauth", "index.js");
    if (await exists(index)) return index;
  }
  return null;
}

/**
 * Runs one of Pi's own OAuth sign-ins and saves it to `auth.json` (mode 600) like Pi does. Unlike
 * `pi-ai login`, a pasted code (first stdin line) is accepted at once, so phones can finish it.
 */
export const LOGIN_RUNNER = `
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
const [oauthIndex, providerId, authPath] = process.argv.slice(1);
const { getOAuthProvider } = await import(pathToFileURL(oauthIndex).href);
const provider = getOAuthProvider(providerId);
if (!provider) { console.error("Unknown provider " + providerId); process.exit(1); }
let pasted;
const manual = new Promise((resolve) => (pasted = resolve));
createInterface({ input: process.stdin }).on("line", (line) => line.trim() && pasted(line.trim()));
const credentials = await provider.login({
  onAuth: (info) => { console.log("URL " + info.url); if (info.instructions) console.log("INFO " + info.instructions); },
  onPrompt: async (prompt) => (/enterprise/i.test(prompt.message) ? "" : manual),
  onProgress: (message) => console.log("PROGRESS " + message),
  onManualCodeInput: () => manual,
});
let auth = {};
try { auth = JSON.parse(readFileSync(authPath, "utf8")); } catch {}
auth[providerId] = { type: "oauth", ...credentials };
writeFileSync(authPath, JSON.stringify(auth, null, 2), { mode: 0o600 });
console.log("DONE");
process.exit(0);
`;

export class PiAdapter implements FamilyAdapter {
  readonly family = "pi" as const;
  /** Session files record only the model, so they reopen on any account. */
  readonly portable = true;
  readonly usageSpacingMs = 60_000;

  async env(home: string | null): Promise<EnvPatch> {
    return { PI_CODING_AGENT_DIR: home };
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("pi");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return preparePiHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    const auth = await readAuth(home ?? mainPiDir());
    const signedIn = oauthProviders(auth);
    if (signedIn.length === 0) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    const email = tokenEmail(auth["openai-codex"]?.access);
    return {
      signedIn: true,
      email,
      plan: signedIn.map((id) => PROVIDER_LABEL[id]).join(" + "),
      organization: null,
      identity: email ? `pi|${email.toLowerCase()}` : null,
    };
  }

  async usage(): Promise<UsageRead> {
    return { fetchedAt: new Date().toISOString(), windows: [], error: "Pi doesn't report subscription usage.", cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Pi has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    if (!home) throw new Error("Sign your Pi CLI login in with /login inside Pi.");
    const { command } = await providerCommand("pi");
    const oauth = await findPiOAuth(command);
    if (!oauth) throw new Error("Couldn't find Pi's sign-in module next to the pi command. Reinstall Pi with npm.");
    // A new account signs in to the same subscription as the CLI login (Claude when it has none).
    const provider = oauthProviders(await readAuth(mainPiDir()))[0] ?? "anthropic";
    const env = spawnEnv(await this.env(home));
    const quiet = await quietBrowserDir();
    if (quiet) env.PATH = `${quiet}${delimiter}${env.PATH ?? ""}`;
    return new PiLogin(["--input-type=module", "-e", LOGIN_RUNNER, "--", oauth, provider, join(home, "auth.json")], env);
  }

  async logout(_home: string): Promise<void> {
    // The sign-in lives in the home itself, which is deleted next.
  }

  detectLimit = (event: Parameters<FamilyAdapter["detectLimit"]>[0]) => detectClaudeLimit(event) ?? detectApiStyleLimit(event);
  detectSignOut = detectKimiSignOut;
}

export class PiLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;

  constructor(args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn("node", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => undefined);
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.output += stripAnsi(chunk.toString("utf8"));
      const parsed = parsePiLogin(this.output);
      // The device code can arrive a moment after the link.
      if (parsed && (this.progress.url !== parsed.url || this.progress.userCode !== parsed.userCode)) this.update({ step: "waiting", ...parsed });
    });
    this.child.stderr.on("data", (chunk: Buffer) => (this.output += stripAnsi(chunk.toString("utf8"))));
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => resolve({ ok: false, message: `Could not run Node for Pi's sign-in: ${error.message}` }));
      this.child.on("close", (code) => {
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0 && this.output.includes("DONE")) return resolve({ ok: true, message: null });
        const last = this.output.trim().split("\n").filter(Boolean).pop();
        resolve({ ok: false, message: last ?? `Pi's sign-in exited with code ${code}` });
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
 * The sign-in link from the runner. A device code (Copilot) is typed on the page; otherwise the
 * link finishes by itself in a browser on the host, or the redirect URL can be pasted back.
 */
export function parsePiLogin(output: string): { url: string; codeUrl: string | null; userCode: string | null } | null {
  const url = output.match(/^URL (\S+)/m)?.[1];
  if (!url) return null;
  const userCode = output.match(/^INFO .*Enter code:\s*(\S+)/m)?.[1] ?? null;
  return { url, codeUrl: userCode ? null : url, userCode };
}
