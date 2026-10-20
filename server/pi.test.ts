import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { findPiOAuth, LOGIN_RUNNER, parsePiLogin, PiAdapter, PiLogin } from "./pi";

describe("Pi", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  let root: string | null = null;
  afterEach(() => {
    process.env.PI_CODING_AGENT_DIR = saved;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("reads the link, and the device code when there is one", () => {
    expect(parsePiLogin("URL https://claude.ai/oauth/authorize?x=1\nINFO Complete login in your browser.\n")).toEqual({
      url: "https://claude.ai/oauth/authorize?x=1",
      codeUrl: "https://claude.ai/oauth/authorize?x=1",
      userCode: null,
    });
    expect(parsePiLogin("URL https://github.com/login/device\nINFO Enter code: AB12-CD34\n")).toEqual({
      url: "https://github.com/login/device",
      codeUrl: null,
      userCode: "AB12-CD34",
    });
    expect(parsePiLogin("PROGRESS starting")).toBeNull();
  });

  it("finds pi-ai's OAuth module beside an npm-installed pi", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-pi-"));
    const agent = join(root, "lib", "node_modules", "@mariozechner", "pi-coding-agent");
    const oauth = join(root, "lib", "node_modules", "@mariozechner", "pi-ai", "dist", "utils", "oauth");
    mkdirSync(join(agent, "dist"), { recursive: true });
    mkdirSync(oauth, { recursive: true });
    writeFileSync(join(agent, "dist", "cli.js"), "");
    writeFileSync(join(oauth, "index.js"), "");
    mkdirSync(join(root, "bin"));
    symlinkSync(join(agent, "dist", "cli.js"), join(root, "bin", "pi"));
    expect(await findPiOAuth(join(root, "bin", "pi"))).toMatch(/pi-ai\/dist\/utils\/oauth\/index\.js$/);
  });

  it("is signed in when auth.json holds a subscription sign-in", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-pi-"));
    process.env.PI_CODING_AGENT_DIR = join(root, "main");
    mkdirSync(join(root, "main"));
    const adapter = new PiAdapter();
    expect((await adapter.identity(null)).signedIn).toBe(false);
    writeFileSync(join(root, "main", "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } }));
    expect(await adapter.identity(null)).toMatchObject({ signedIn: true, plan: "Claude" });
    expect(await adapter.env(join(root, "acct"))).toEqual({ PI_CODING_AGENT_DIR: join(root, "acct") });
  });

  it("finishes a sign-in with a pasted code and saves it privately", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-pi-"));
    const fake = join(root, "oauth.mjs");
    writeFileSync(
      fake,
      `export const getOAuthProvider = () => ({ login: async (cb) => { cb.onAuth({ url: "https://example.com/auth", instructions: "Complete login" }); const code = await cb.onManualCodeInput(); return { access: code, refresh: "r", expires: 1 }; } });`,
    );
    const authPath = join(root, "auth.json");
    const login = new PiLogin(["--input-type=module", "-e", LOGIN_RUNNER, "--", fake, "anthropic", authPath], process.env);
    await new Promise<void>((resolve) => login.onProgress((p) => p.step === "waiting" && resolve()));
    expect(login.progress.codeUrl).toBe("https://example.com/auth");
    await login.submitCode("the-code");
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(JSON.parse(readFileSync(authPath, "utf8")).anthropic).toMatchObject({ type: "oauth", access: "the-code" });
    expect(statSync(authPath).mode & 0o777).toBe(0o600);
  });
});
