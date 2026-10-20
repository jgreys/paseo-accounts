import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SwitchRow } from "../shared/timeline";
import { ActivityLog } from "./activity";

const row = (to: string): SwitchRow => ({
  family: "claude",
  from: "a",
  to,
  reason: "early",
  resetsAt: null,
  continued: false,
  continuedIn: null,
  toFamily: null,
  outcome: "switched",
  detail: null,
  at: new Date().toISOString(),
});

describe("switch log", () => {
  const saved = process.env.PASEO_HOME;
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-activity-"));
    process.env.PASEO_HOME = root;
  });
  afterEach(() => {
    process.env.PASEO_HOME = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it("lists switches newest first and keeps them across restarts", async () => {
    const log = new ActivityLog();
    await log.add("agent-1", "Fix checkout", row("b"));
    await log.add("agent-2", null, row("c"));
    expect((await log.list()).map((entry) => entry.row.to)).toEqual(["c", "b"]);
    expect((await new ActivityLog().list())[1]).toMatchObject({ agentId: "agent-1", agentTitle: "Fix checkout" });
  });
});
