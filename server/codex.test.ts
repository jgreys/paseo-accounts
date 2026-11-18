import { describe, expect, it } from "vitest";
import { codexIdentity, sameIdentity } from "./codex";
import type { StoredAccount } from "./state";

const account = (fields: Partial<StoredAccount>): StoredAccount => ({
  id: "codex-1",
  family: "codex",
  label: "work",
  kind: "managed",
  home: "/tmp/work",
  autoLabel: false,
  email: null,
  plan: null,
  organization: null,
  identity: null,
  signedIn: true,
  disabled: false,
  priority: "normal",
  limitedUntil: null,
  limitKind: null,
  limitedAt: null,
  createdAt: "2026-09-01T00:00:00Z",
  ...fields,
});

describe("codexIdentity", () => {
  it("separates workspace members by email", () => {
    expect(codexIdentity("ws-1", "Work@Acme.com", "team")).toBe("chatgpt|ws-1|work@acme.com");
  });

  it("falls back to the workspace alone when the email is missing", () => {
    expect(codexIdentity("ws-1", null, "team")).toBe("chatgpt|ws-1");
  });

  it("uses email and plan when the workspace is missing", () => {
    expect(codexIdentity(null, "Work@Acme.com", "prolite")).toBe("chatgpt-email|work@acme.com|prolite");
  });

  it("has no identity when neither is known", () => {
    expect(codexIdentity(null, null, null)).toBeNull();
  });
});

describe("sameIdentity", () => {
  it("matches on the exact string", () => {
    const stored = account({ identity: "chatgpt|ws-1|work@acme.com", email: "Work@Acme.com" });
    expect(sameIdentity(stored, "chatgpt|ws-1|work@acme.com", "work@acme.com")).toBe(true);
  });

  it("matches a legacy identity with the same email", () => {
    const stored = account({ identity: "chatgpt|ws-1", email: "Work@Acme.com" });
    expect(sameIdentity(stored, "chatgpt|ws-1|work@acme.com", "work@acme.com")).toBe(true);
  });

  it("rejects a legacy identity for a different email", () => {
    const stored = account({ identity: "chatgpt|ws-1", email: "Work@Acme.com" });
    expect(sameIdentity(stored, "chatgpt|ws-1|other@acme.com", "other@acme.com")).toBe(false);
  });

  it("accepts a legacy identity recorded before any email was learned", () => {
    const stored = account({ identity: "chatgpt|ws-1" });
    expect(sameIdentity(stored, "chatgpt|ws-1|work@acme.com", "work@acme.com")).toBe(true);
  });

  it("rejects a different workspace", () => {
    const stored = account({ identity: "chatgpt|ws-2", email: "Work@Acme.com" });
    expect(sameIdentity(stored, "chatgpt|ws-1|work@acme.com", "work@acme.com")).toBe(false);
  });
});
