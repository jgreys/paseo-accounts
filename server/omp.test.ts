import { describe, expect, it } from "vitest";
import { parseOmpLogin, parseOmpUsage } from "./omp";

describe("Oh My Pi", () => {
  it("lists every pooled account's limits, named after the account", () => {
    const windows = parseOmpUsage({
      reports: [
        {
          provider: "anthropic",
          metadata: { email: "a@x.com" },
          limits: [
            { id: "5h", label: "Session", window: { label: "5-hour", resetsAt: Date.parse("2026-10-14T15:00:00Z") }, amount: { usedFraction: 0.4 } },
            { id: "wk", label: "Weekly", amount: { used: 30, limit: 120 } },
            { id: "x", label: "Unknown", amount: {} },
          ],
        },
        { provider: "anthropic", limits: [{ id: "5h", label: "Session", scope: { accountId: "acct-2" }, amount: { usedFraction: 1 } }] },
      ],
    });
    expect(windows).toEqual([
      { id: "anthropic:a@x.com:5h", label: "a@x.com · 5-hour", usedPercent: 40, resetsAt: "2026-10-14T15:00:00.000Z" },
      { id: "anthropic:a@x.com:wk", label: "a@x.com · Weekly", usedPercent: 25, resetsAt: null },
      { id: "anthropic:acct-2:5h", label: "acct-2 · Session", usedPercent: 100, resetsAt: null },
    ]);
  });

  it("reads the link, the host-only shortcut and the paste prompt from omp login", () => {
    const loopback = "\nOpen this URL in your browser:\nhttps://claude.ai/oauth/authorize?x=1\nLocal shortcut (this machine only): http://localhost:54545/launch\n";
    expect(parseOmpLogin(loopback)).toEqual({ url: "http://localhost:54545/launch", codeUrl: null, userCode: null });
    const paste = "\nOpen this URL in your browser:\nhttps://auth.example.com/x\nPaste the authorization code (or full redirect URL):";
    expect(parseOmpLogin(paste)).toEqual({ url: "https://auth.example.com/x", codeUrl: "https://auth.example.com/x", userCode: null });
    expect(parseOmpLogin("Loading…")).toBeNull();
  });
});
