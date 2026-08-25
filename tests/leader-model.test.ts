import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LeaderWorkflow } from "../src/core/workflow.js";

const originalKey = process.env.CODEGATE_LEADER_API_KEY;
const originalBaseUrl = process.env.CODEGATE_LEADER_BASE_URL;
const originalModel = process.env.CODEGATE_LEADER_MODEL;
const originalInputRate = process.env.CODEGATE_MODEL_INPUT_USD_PER_MILLION;
const originalOutputRate = process.env.CODEGATE_MODEL_OUTPUT_USD_PER_MILLION;
const originalFetch = globalThis.fetch;
const roots: string[] = [];
afterEach(async () => { process.env.CODEGATE_LEADER_API_KEY = originalKey; process.env.CODEGATE_LEADER_BASE_URL = originalBaseUrl; process.env.CODEGATE_LEADER_MODEL = originalModel; process.env.CODEGATE_MODEL_INPUT_USD_PER_MILLION = originalInputRate; process.env.CODEGATE_MODEL_OUTPUT_USD_PER_MILLION = originalOutputRate; globalThis.fetch = originalFetch; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

  it("answers next-step questions in a new workspace without requiring TaskSpec or WorkPlan", async () => {
    delete process.env.CODEGATE_LEADER_API_KEY;
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-consult-")); roots.push(root);
    const answer = await new LeaderWorkflow(root).consult("下一步怎么做？");
    expect(answer).toContain("描述产品想法");
    expect((await new LeaderWorkflow(root).store.state()).status).toBe("new");
  });

  it("uses the configured model for universal consultation and includes authoritative state", async () => {
    process.env.CODEGATE_LEADER_API_KEY = "test"; process.env.CODEGATE_LEADER_BASE_URL = "https://api.example.test/v1"; process.env.CODEGATE_LEADER_MODEL = "example-model"; process.env.CODEGATE_MODEL_INPUT_USD_PER_MILLION = "2"; process.env.CODEGATE_MODEL_OUTPUT_USD_PER_MILLION = "8";
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "请先导入任务资料，然后检查 TaskSpec。" } }], usage: { prompt_tokens: 1000, completion_tokens: 250, total_tokens: 1250 } }), { status: 200 }));
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-consult-")); roots.push(root);
    const answer = await new LeaderWorkflow(root).consult("下一步怎么做？");
    expect(answer).toContain("导入任务资料");
    const request = vi.mocked(globalThis.fetch).mock.calls[0]!;
    expect(String(request[0])).toBe("https://api.example.test/v1/chat/completions");
    const requestBody = JSON.parse(String(request[1]?.body)) as { messages: Array<{ content: string }> };
    expect(requestBody.messages.at(-1)?.content).toContain('"status": "new"');
    expect((await new LeaderWorkflow(root).snapshot()).modelUsageSummary).toMatchObject({ calls: 1, totalTokens: 1250, estimatedCostUsd: 0.004 });
  });

  it("turns provider 402 responses into an actionable balance message", async () => {
    process.env.CODEGATE_LEADER_API_KEY = "test"; process.env.CODEGATE_LEADER_BASE_URL = "https://api.deepseek.com"; process.env.CODEGATE_LEADER_MODEL = "deepseek-v4-pro";
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), { status: 402 }));
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-balance-")); roots.push(root);
    await expect(new LeaderWorkflow(root).consult("下一步是什么？")).rejects.toThrow("模型账户余额不足");
  });
});
