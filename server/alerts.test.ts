import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAlert } from "./alerts";

describe("alerts", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the message with an ASCII title, the way ntfy reads it", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response("ok")));
    await sendAlert("https://ntfy.sh/topic", "Héllo is signed out", "Sign it in again.");
    expect(calls[0]?.url).toBe("https://ntfy.sh/topic");
    expect((calls[0]?.init.headers as Record<string, string>).Title).toBe("paseo-accounts: H?llo is signed out");
    expect(calls[0]?.init.body).toBe("Sign it in again.");
  });

  it("reports a refused alert", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 403 }));
    await expect(sendAlert("https://ntfy.sh/topic", "t", "m")).rejects.toThrow(/403/);
  });
});
