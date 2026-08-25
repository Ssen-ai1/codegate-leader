import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { buildTaskSpec } from "../src/core/task-intake.js";
import { buildDynamicPlan } from "../src/core/planner.js";
import { evaluateComparativeRuns } from "../src/core/evaluation.js";

describe("Golden Set contract", () => {
  it("covers the required task, drift, agent-switch, and learning scenarios", async () => {
    const cases = JSON.parse(await readFile(new URL("../golden/cases.json", import.meta.url), "utf8")) as Array<{ id: string; kind: string; taskText: string; assertions: string[] }>;
    expect(cases).toHaveLength(9);
    expect(new Set(cases.map((item) => item.kind))).toEqual(new Set(["clear-coding", "clarification", "rubric", "multi-step", "drift", "evidence", "change", "handoff", "learning"]));
    expect(cases.every((item) => item.assertions.length > 0)).toBe(true);
    for (const item of cases) {
      const task = buildTaskSpec(`${item.id}.md`, item.taskText, "workspace-file", "2026-08-24T00:00:00.000Z");
      const plan = buildDynamicPlan(task, [], null, "2026-08-24T00:00:00.000Z");
      expect(task.requirements.length, item.id).toBeGreaterThan(0);
      expect(task.deliverables.length, item.id).toBeGreaterThan(0);
      expect(plan.steps.length, item.id).toBeGreaterThanOrEqual(3);
      expect(plan.steps.length, item.id).toBeLessThanOrEqual(8);
      expect(task.deliverables.filter((deliverable) => deliverable.required).every((deliverable) => plan.steps.some((step) => step.deliverableIds.includes(deliverable.id))), item.id).toBe(true);
    }
  });

  it("calculates an explicit Go/No-Go result from paired real-run metrics", () => {
    const common = { completed: true, missedRubricItems: 0, mentorScore: 4 };
    const result = evaluateComparativeRuns([
      { ...common, caseId: "case", mode: "direct", completionMinutes: 100, managementMinutes: 30, missedRequirements: 2, driftCount: 3, recoveryMinutes: 20 },
      { ...common, caseId: "case", mode: "codegate", completionMinutes: 100, managementMinutes: 10, missedRequirements: 0, driftCount: 1, recoveryMinutes: 5 }
    ]);
    expect(result.go).toBe(true);
    expect(result.metrics.omissionReduction).toBe(1);
  });
});
