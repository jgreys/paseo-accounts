import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dataDir } from "./paths";

describe("data directory", () => {
  const saved = process.env.PASEO_HOME;
  let root: string | null = null;

  afterEach(() => {
    process.env.PASEO_HOME = saved;
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  it("uses paseo-accounts on a fresh install", () => {
    root = mkdtempSync(join(tmpdir(), "paseo-accounts-paths-"));
    process.env.PASEO_HOME = root;
    expect(dataDir()).toBe(join(root, "paseo-accounts"));
  });

});
