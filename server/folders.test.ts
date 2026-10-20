import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeFolder } from "./service";

describe("normalizeFolder", () => {
  it("expands ~ and drops trailing slashes", () => {
    expect(normalizeFolder("~/projects/hub/")).toBe(join(homedir(), "projects/hub"));
    expect(normalizeFolder("/p/hub/../api//")).toBe("/p/api");
    expect(normalizeFolder("/")).toBe("/");
  });

  it("rejects relative paths", () => {
    expect(() => normalizeFolder("projects/hub")).toThrow(/full folder path/);
  });
});
