import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoginMethod } from "../shared/model";
import { ProgressEmitter, type EnvPatch, type FamilyAdapter, type Identity, type LoginHandle, type RedeemReply, type UsageRead } from "./adapter";
import { providerCommand } from "./binaries";
import { writeJsonAtomic } from "./json-file";
import { detectApiStyleLimit, detectKimiSignOut } from "./limits";
import { mainOpenCodeData } from "./paths";
import { run } from "./process";

/** OpenCode's provider ID for the Go subscription, and where its sign-in keys come from. */
export const GO_PROVIDER = "opencode-go";
const KEY_PAGE = "https://opencode.ai/auth";

type AuthFile = Record<string, unknown>;

async function readAuth(path: string): Promise<AuthFile> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as AuthFile) : {};
  } catch {
    return {};
  }
}

const mainAuthPath = () => join(mainOpenCodeData(), "auth.json");
const homeAuthPath = (home: string) => join(home, "auth.json");

function goKey(auth: AuthFile): string | null {
  const entry = auth[GO_PROVIDER] as { key?: unknown } | undefined;
  return typeof entry?.key === "string" && entry.key ? entry.key : null;
}

/**
 * An OpenCode account is a Go sign-in kept in the account's own folder. Sessions get it through
 * `OPENCODE_AUTH_CONTENT`, on top of the user's other OpenCode sign-ins, so chat history and every
 * other provider stay exactly as they are. Paseo runs a dedicated OpenCode server for such sessions.
 */
export class OpenCodeAdapter implements FamilyAdapter {
  readonly family = "opencode" as const;
  /** Chats live in OpenCode's one shared database, so they open on any account. */
  readonly portable = true;
  readonly usageSpacingMs = 60_000;

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { OPENCODE_AUTH_CONTENT: null };
    const merged = { ...(await readAuth(mainAuthPath())), ...(await readAuth(homeAuthPath(home))) };
    return { OPENCODE_AUTH_CONTENT: JSON.stringify(merged) };
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("opencode");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  async prepareHome(home: string): Promise<void> {
    await mkdir(home, { recursive: true, mode: 0o700 });
  }

  async identity(home: string | null): Promise<Identity> {
    const key = goKey(await readAuth(home ? homeAuthPath(home) : mainAuthPath()));
    if (!key) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    const fingerprint = createHash("sha256").update(key).digest("hex").slice(0, 16);
    return { signedIn: true, email: null, plan: "Go", organization: null, identity: `opencode|${fingerprint}` };
  }

  async usage(): Promise<UsageRead> {
    return { fetchedAt: new Date().toISOString(), windows: [], error: "OpenCode Go doesn't report usage to other apps.", cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "OpenCode Go has no banked resets.", left: null };
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    if (!home) throw new Error("Sign your OpenCode CLI login in with `opencode auth login` in a terminal.");
    return new OpenCodeLogin(home);
  }

  async logout(_home: string): Promise<void> {
    // The key lives in the home itself, which is deleted next.
  }

  detectLimit = detectApiStyleLimit;
  detectSignOut = detectKimiSignOut;
}

/** OpenCode's own `auth login` for Go: create a key on opencode.ai and paste it. */
class OpenCodeLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private settle: (result: { ok: boolean; message: string | null }) => void = () => undefined;

  constructor(private readonly home: string) {
    super();
    this.finished = new Promise((resolve) => (this.settle = resolve));
    this.update({ step: "waiting", codeUrl: KEY_PAGE });
  }

  async submitCode(code: string): Promise<void> {
    const key = code.trim();
    if (!key) throw new Error("Paste the key from opencode.ai.");
    await writeJsonAtomic(homeAuthPath(this.home), { [GO_PROVIDER]: { type: "api", key } });
    this.settle({ ok: true, message: null });
  }

  cancel(): void {
    this.settle({ ok: false, message: "Sign-in was canceled." });
  }
}
