import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LeaderWorkflow } from "../src/core/workflow.js";

const originalKey = process.env.CODEGATE_LEADER_API_KEY;
const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(async () => { process.env.CODEGATE_LEADER_API_KEY = originalKey; globalThis.fetch = originalFetch; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Leader model integration", () => {
  it("turns validated model questions into pending TaskSpec clarification", async () => {
    process.env.CODEGATE_LEADER_API_KEY = "test";
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Need a target", questions: [{ question: "Which platform?", impact: "Changes architecture", blocking: true }], architectureAlternatives: [{ name: "Desktop first", advantages: ["Local artifacts"], disadvantages: ["Packaging"], recommendation: true }], assumptions: ["A local workspace exists"] }) } }] }), { status: 200 }));
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-model-")); roots.push(root);
    await writeFile(path.join(root, "task.md"), "Build a leader workflow.", "utf8");
    const flow = new LeaderWorkflow(root); await flow.intake("task.md");
    const analysis = await flow.analyzeWithLeader("Need options");
    expect(analysis.architectureAlternatives[0]?.name).toBe("Desktop first");
    expect((await flow.store.task())?.openQuestions[0]).toMatchObject({ question: "Which platform?", blocking: true, answer: null });
    expect((await flow.store.state()).status).toBe("clarification-required");
  });
});
