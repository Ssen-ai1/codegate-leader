import { describe, expect, it } from "vitest";
import { taskSpecSchema } from "../src/core/schemas.js";

describe("Leader protocol schemas", () => {
  it("requires source-traceable task facts", () => {
    const source = { sourceId: "user", sourceType: "user-message" as const, locator: "message", contentHash: "hash" };
    expect(() => taskSpecSchema.parse({ id: "task", version: 1, title: "Task", objective: "Objective", deliverables: [{ id: "del", description: "Deliverable", required: true, sourcePointers: [source] }], requirements: [{ id: "req", description: "Requirement", priority: "must", sourcePointers: [source] }], constraints: [], nonGoals: [], assumptions: [], openQuestions: [], acceptanceCriteria: [{ id: "ac", title: "Acceptance", description: "Check", required: true, verificationMethod: "manual-review", expectedEvidence: ["review"], sourcePointers: [source] }], rubricItems: [], sourceMaterialIds: ["user"], createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" })).not.toThrow();
  });
});
