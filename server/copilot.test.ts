import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CopilotAdapter, copilotUser, parseCopilotLogin } from "./copilot";
import { detectCopilotLimit, detectCopilotSignOut } from "./limits";

const failed = (message: string) => ({ outcome: { kind: "failed" as const, error: { message } }, timeline: [] });

describe("Copilot CLI", () => {
  let home: string | null = null;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = null;
  });

  it("reads the device-code link and code", () => {
    expect(parseCopilotLogin("To authenticate, visit https://github.com/login/device and enter code AB12-CD34\nWaiting for authorization...")).toEqual({
      url: "https://github.com/login/device",
      code: "AB12-CD34",
    });
    expect(parseCopilotLogin("Starting…")).toBeNull();
  });

  it("knows who a home is signed in as", async () => {
    home = mkdtempSync(join(tmpdir(), "paseo-accounts-copilot-"));
    expect(await copilotUser(home)).toBeNull();
    writeFileSync(join(home, "config.json"), JSON.stringify({ lastLoggedInUser: { host: "https://github.com", login: "octocat" } }));
    expect(await new CopilotAdapter().identity(home)).toMatchObject({ signedIn: true, email: "octocat", identity: "copilot|github.com|octocat" });
    expect(await new CopilotAdapter().env(home)).toMatchObject({ COPILOT_HOME: home });
  });

  it("tells spent credits from rate limits, and spots sign-outs", () => {
    expect(detectCopilotLimit(failed("You've run out of your included AI credits for the month."))?.kind).toBe("budget");
    expect(detectCopilotLimit(failed("You've reached your weekly rate limit."))?.kind).toBe("window");
    expect(detectCopilotLimit(failed("Something else broke"))).toBeNull();
    expect(detectCopilotSignOut(failed("Error: No authentication information found."))).not.toBeNull();
  });
});
