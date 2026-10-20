import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeAdapter } from "./opencode";

describe("OpenCode Go accounts", () => {
  const saved = process.env.XDG_DATA_HOME;
  let root: string | null = null;
  afterEach(() => {
    process.env.XDG_DATA_HOME = saved;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("signs in with a pasted key and layers it over the user's other sign-ins", async () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-opencode-"));
    process.env.XDG_DATA_HOME = join(root, "data");
    mkdirSync(join(root, "data", "opencode"), { recursive: true });
    writeFileSync(join(root, "data", "opencode", "auth.json"), JSON.stringify({ "opencode-go": { type: "api", key: "main" }, other: { type: "api", key: "x" } }));
    const home = join(root, "home");
    const adapter = new OpenCodeAdapter();
    await adapter.prepareHome(home);

    const login = await adapter.login(home, "code");
    expect(login.progress).toMatchObject({ step: "waiting", codeUrl: "https://opencode.ai/auth" });
    await login.submitCode("second");
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(statSync(join(home, "auth.json")).mode & 0o777).toBe(0o600);

    const env = await adapter.env(home);
    expect(JSON.parse(env.OPENCODE_AUTH_CONTENT!)).toEqual({ "opencode-go": { type: "api", key: "second" }, other: { type: "api", key: "x" } });
    expect(await adapter.env(null)).toEqual({ OPENCODE_AUTH_CONTENT: null });

    const [main, added] = [await adapter.identity(null), await adapter.identity(home)];
    expect(main.signedIn && added.signedIn).toBe(true);
    expect(main.identity).not.toBe(added.identity);
    expect(added.identity).not.toContain("second");
  });
});
