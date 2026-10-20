import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { familiesFromConfig } from "./families";
import { parseKimiLogin, parseKimiUsage, readKimiToken } from "./kimi";
import { detectKimiLimit } from "./limits";

describe("Kimi Code", () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it("reads the link and code from kimi login", () => {
    const output =
      "Opening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=E4B2-TYSJ\n" +
      "If the browser did not open, paste the URL above and enter code: E4B2-TYSJ\nCode expires in 1800s.\n";
    expect(parseKimiLogin(output)).toEqual({ url: "https://www.kimi.com/code/authorize_device?user_code=E4B2-TYSJ", code: "E4B2-TYSJ" });
    expect(parseKimiLogin("Starting…")).toBeNull();
  });

  it("turns Kimi's usage reply into windows", () => {
    const windows = parseKimiUsage({
      usages: {
        limit_5h: { used_ratio: 0.25, reset_time: "2026-10-14T13:24:50Z" },
        limit_month_total: { used_ratio: "0.5", reset_time: "2026-10-23T00:00:00Z" },
        limit_month_code: { used_ratio: 0.5 },
      },
    });
    expect(windows).toEqual([
      { id: "five_hour", label: "5-hour", usedPercent: 25, resetsAt: "2026-10-14T13:24:50Z" },
      { id: "month", label: "Monthly", usedPercent: 50, resetsAt: "2026-10-23T00:00:00Z" },
    ]);
  });

  it("finds the sign-in config.toml points at", async () => {
    home = mkdtempSync(join(tmpdir(), "paseo-accounts-kimi-"));
    mkdirSync(join(home, "credentials"));
    writeFileSync(join(home, "config.toml"), '[providers."managed:kimi-code".oauth]\nstorage = "file"\nkey = "oauth/kimi-code-env-abc"\n');
    writeFileSync(join(home, "credentials", "kimi-code-env-old.json"), JSON.stringify({ access_token: "old", expires_at: 1 }));
    writeFileSync(join(home, "credentials", "kimi-code-env-abc.json"), JSON.stringify({ access_token: "a.b.c", refresh_token: "r", expires_at: 99 }));
    expect(await readKimiToken(home)).toEqual({ accessToken: "a.b.c", refreshToken: "r", expiresAt: 99 });
  });

  it("is signed out when the home has no credentials", async () => {
    home = mkdtempSync(join(tmpdir(), "paseo-accounts-kimi-"));
    expect(await readKimiToken(home)).toBeNull();
  });

  it("maps Paseo's kimi provider to the Kimi family", () => {
    const providers = { kimi: { extends: "acp", command: ["kimi", "acp"], env: {} }, opencode: { command: ["opencode-shim"] } };
    expect(familiesFromConfig(providers)).toMatchObject({ kimi: "kimi", opencode: "opencode", claude: "claude" });
    expect(familiesFromConfig({ kimi: { extends: "acp", env: { KIMI_CODE_HOME: "/x" } } }).kimi).toBeUndefined();
  });

  it("spots quota errors but not replies about rate limits", () => {
    const failed = (message: string) => ({ outcome: { kind: "failed" as const, error: { message } }, timeline: [] });
    expect(detectKimiLimit(failed("Provider rate limit: exceeded your current quota"))?.kind).toBe("window");
    expect(detectKimiLimit(failed("insufficient balance, please recharge"))?.kind).toBe("budget");
    const reply = { outcome: { kind: "completed" as const }, timeline: [{ type: "user_message" as const, text: "x" }, { type: "assistant_message" as const, text: "Added a rate limit." }] };
    expect(detectKimiLimit(reply)).toBeNull();
  });
});
