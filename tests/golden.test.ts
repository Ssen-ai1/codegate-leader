import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

describe("Golden Set contract", () => {
  it("covers the required task, drift, agent-switch, and learning scenarios", async () => {
    const cases = JSON.parse(await readFile(new URL("../golden/cases.json", import.meta.url), "utf8")) as Array<{ kind: string; assertions: string[] }>;
    expect(cases).toHaveLength(9);
    expect(new Set(cases.map((item) => item.kind))).toEqual(new Set(["clear-coding", "clarification", "rubric", "multi-step", "drift", "evidence", "change", "handoff", "learning"]));
    expect(cases.every((item) => item.assertions.length > 0)).toBe(true);
  });
});
