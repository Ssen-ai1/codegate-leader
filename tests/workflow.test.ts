import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { architectureOptionsFor, LeaderWorkflow, productBlueprintFor } from "../src/core/workflow.js";
import type { ExecutionReport } from "../src/core/schemas.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() { const root = await mkdtemp(path.join(os.tmpdir(), "codegate-leader-")); roots.push(root); await writeFile(path.join(root, "task.md"), "Build a reviewed Leader workflow.\n"); const flow = new LeaderWorkflow(root); await flow.intake("task.md"); await flow.approveTask(); await flow.architecture("Boundary", "Keep Leader separate from Coding Agents."); await flow.createPlan(); await flow.approvePlanWithPatch(); return { root, flow }; }
function report(status: "passed" | "failed") : ExecutionReport { return { reportId: `report-${Date.now()}`, stepId: "step-001", handoffVersion: 1, agent: { name: "test" }, status: "completed", summary: "done", filesRead: [], filesChanged: [], commandsRun: [{ command: "test", exitCode: status === "passed" ? 0 : 1, status }], outputs: [], assumptions: [], risks: [], unresolvedItems: [], deviations: [], recommendedNextAction: "review", generatedAt: new Date().toISOString() }; }

describe("CLI Leader workflow", () => {
  it("reports product-blueprint gaps and offers comparable architecture options", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-blueprint-")); roots.push(root);
    const flow = new LeaderWorkflow(root);
    const task = await flow.startFromIdea({ projectName: "库存助手", idea: "为小型餐饮店开发 Windows 库存管理应用。" });
    const initial = productBlueprintFor(task);
    expect(initial.score).toBeLessThan(100);
    expect(initial.gaps).toEqual(expect.arrayContaining(["目标用户", "首版范围", "成功标准"]));
    await flow.clarify("discovery-users", "小型餐饮店店主");
    await flow.clarify("discovery-mvp", "录入库存和低库存提醒");
    await flow.clarify("discovery-platform", "Windows 11 桌面端");
    await flow.clarify("discovery-data", "数据仅保存在本地，无账号和支付");
    await flow.clarify("discovery-success", "五分钟内完成首次库存录入");
    await flow.clarify("discovery-constraints", "离线可用，首版六周内交付");
    const completeTask = await flow.store.task();
    const blueprint = productBlueprintFor(completeTask!);
    expect(blueprint).toMatchObject({ score: 100, ready: true, gaps: [] });
    const options = architectureOptionsFor(completeTask!);
    expect(options).toHaveLength(3);
    expect(options.filter((item) => item.recommended)).toHaveLength(1);
    expect(options[0]).toMatchObject({ name: "Electron 本地优先", delivery: "快", cost: "低", risk: "低" });
    const previousKey = process.env.CODEGATE_LEADER_API_KEY;
    delete process.env.CODEGATE_LEADER_API_KEY;
    try {
      await flow.approveTask();
      expect(await flow.consult("为什么推荐这个架构？")).toContain("Electron 本地优先");
    } finally {
      if (previousKey === undefined) delete process.env.CODEGATE_LEADER_API_KEY; else process.env.CODEGATE_LEADER_API_KEY = previousKey;
    }
  });
  it("persists Leader conversations with the project and restores them in snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-assistant-")); roots.push(root);
    const flow = new LeaderWorkflow(root);
    await flow.openProject();
    const previousKey = process.env.CODEGATE_LEADER_API_KEY;
    delete process.env.CODEGATE_LEADER_API_KEY;
    try {
      const answer = await flow.consult("我只有一个想法，下一步是什么？");
      expect(answer).toContain("描述产品想法");
      const reopened = new LeaderWorkflow(root), snapshot = await reopened.snapshot();
      expect(snapshot.assistantMessages).toHaveLength(2);
      expect(snapshot.assistantMessages.map((item) => item.role)).toEqual(["user", "leader"]);
      expect(snapshot.assistantMessages[0]?.content).toContain("下一步");
      expect(snapshot.productMetrics).toMatchObject({ localOnly: true, conversations: 1, reviews: 0 });
      await access(path.join(root, ".codegate", "assistant", "history.json"));
    } finally {
      if (previousKey === undefined) delete process.env.CODEGATE_LEADER_API_KEY; else process.env.CODEGATE_LEADER_API_KEY = previousKey;
    }
  });
  it("starts from a product idea, interviews for missing facts, and turns answers into traceable TaskSpec facts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-idea-")); roots.push(root);
    const flow = new LeaderWorkflow(root);
    const task = await flow.startFromIdea({ projectName: "库存助手", idea: "为小型餐饮店开发一个可以管理库存和低库存提醒的 Windows 应用。" });
    expect(task.openQuestions.map((item) => item.id)).toEqual(expect.arrayContaining(["discovery-users", "discovery-mvp", "discovery-platform", "discovery-data", "discovery-success"]));
    expect((await flow.store.state()).status).toBe("clarification-required");

    await flow.clarify("discovery-users", "没有专业 IT 能力的小型餐饮店店主");
    await flow.clarify("discovery-mvp", "录入进货和消耗、查看库存、低库存提醒；首版暂不做供应商商城");
    await flow.clarify("discovery-platform", "Windows 11 桌面端");
    await flow.clarify("discovery-data", "本地保存库存，无账号和支付，首版不联网");
    await flow.clarify("discovery-success", "新用户可在 5 分钟内建立商品并看到低库存提醒");
    expect((await flow.store.state()).status).toBe("intake");
    const revised = await flow.store.task();
    expect(revised?.requirements.some((item) => item.description.includes("餐饮店店主"))).toBe(true);
    expect(revised?.deliverables.some((item) => item.description.includes("录入进货"))).toBe(true);
    expect(revised?.constraints.some((item) => item.description.includes("Windows 11"))).toBe(true);
    expect(revised?.acceptanceCriteria.some((item) => item.description.includes("5 分钟"))).toBe(true);
    await flow.approveTask();
    expect(await flow.recommendArchitecture()).toContain("Electron + TypeScript");
    expect((await flow.store.state()).status).toBe("architecture-review");
  });
  it("keeps TaskSpec and WorkPlan version histories immutable", async () => { const { root, flow } = await setup(); const task = await flow.store.task(); const plan = await flow.store.plan(); expect(task).not.toBeNull(); expect(plan).not.toBeNull(); await expect(flow.store.saveTask(task!)).rejects.toThrow("不能重写历史"); await expect(flow.store.savePlan(plan!)).rejects.toThrow("不能重写历史"); await access(path.join(root, ".codegate", "task", "task-spec-v1.json")); await access(path.join(root, ".codegate", "plan", "plan-v2.json")); });
  it("installs selected reusable skills and compiles their method into the Handoff", async () => { const { root, flow } = await setup(); const handoff = await flow.handoff("generic"); expect(handoff.content).toContain("实现交接"); expect(handoff.content).toContain("质量门槛"); await access(path.join(root, ".codegate", "skills", "implementation-handoff-v1.0.0.json")); });
  it("records reported environment facts as pending until the user confirms them", async () => { const { root, flow } = await setup(); await flow.handoff("generic"); const value = report("passed"); value.environmentFacts = { discoveredBy: "test", sourceRevision: null, languages: ["TypeScript"], frameworks: [], packageManagers: ["npm"], entryPoints: ["src/cli.ts"], importantFiles: ["package.json"], buildCommands: ["npm run build"], testCommands: ["npm test"], verificationCommands: ["npm run check"], environmentRequirements: ["Node.js"], unknowns: [], discoveredAt: new Date().toISOString() }; await flow.ingest(value); expect((await flow.store.environment())?.status).toBe("pending-confirmation"); await flow.confirmEnvironment(); expect((await flow.store.environment())).toMatchObject({ revision: 2, status: "confirmed", languages: ["TypeScript"] }); await access(path.join(root, ".codegate", "environment", "facts-v2.json")); });
  it("versions a user learning profile independently from execution artifacts", async () => { const { root, flow } = await setup(); const profile = await flow.setLearningProfile({ level: "beginner", preferredDepth: "deep", knownTopics: [], learningGoals: ["understand reviews"], recurringConfusions: ["Git Diff"] }); expect(profile).toMatchObject({ revision: 1, level: "beginner" }); await access(path.join(root, ".codegate", "learning", "profile-v1.json")); });
  it("approves, hands off, accepts CodeGate-owned evidence, and unlocks the dependent step", async () => { const { root, flow } = await setup(); await flow.handoff("generic"); const value = report("passed"); value.environmentFacts = { discoveredBy: "test", sourceRevision: null, languages: ["TypeScript"], frameworks: [], packageManagers: ["npm"], entryPoints: [], importantFiles: [], buildCommands: [], testCommands: [], verificationCommands: ["node --version"], environmentRequirements: ["Node.js"], unknowns: [], discoveredAt: new Date().toISOString() }; await flow.ingest(value); await flow.confirmEnvironment(); expect((await flow.runVerification("node --version", true)).status).toBe("passed"); const review = await flow.reviewWithEvidence(value); expect(review.decision).toBe("accepted"); expect((await flow.store.state())).toMatchObject({ status: "step-ready", currentStepId: "step-002" }); expect((await flow.store.plan())?.steps[0]?.status).toBe("accepted"); await access(path.join(root, ".codegate", "plan", "patches", `review-${review.id}-plan-patch.json`)); });
  it("creates correction artifacts and immutable sequential handoffs when evidence is insufficient", async () => { const { root, flow } = await setup(); const original = await flow.handoff("codex"); const value = report("failed"); await flow.ingest(value); const review = await flow.reviewWithPatch(value); expect(review.decision).toBe("revision-required"); expect((await flow.store.state()).status).toBe("correction-ready"); await flow.correct("codex"); const first = JSON.parse(await readFile(path.join(root, ".codegate", "handoffs", "step-001-v1.json"), "utf8")); const second = JSON.parse(await readFile(path.join(root, ".codegate", "handoffs", "step-001-v2.json"), "utf8")); expect(first.content).toBe(original.content); expect(second.content).toContain("Correction Requirements"); expect((await flow.store.plan())?.steps[0]?.status).toBe("handed-off"); });
  it("reopens architecture from an active Handoff without rewriting its historical Plan or Prompt", async () => {
    const { root, flow } = await setup();
    const handoff = await flow.handoff("codex"), planBefore = await flow.store.plan();
    await flow.reopenArchitecture("Switch the persistence boundary before continuing.");
    expect(await flow.store.state()).toMatchObject({ status: "architecture-review", currentStepId: null });
    const superseded = await flow.store.plan();
    expect(superseded).toMatchObject({ version: planBefore!.version + 1, status: "superseded" });
    expect(superseded?.risks.at(-1)).toContain("Switch the persistence boundary");
    expect(JSON.parse(await readFile(path.join(root, ".codegate", "handoffs", `${handoff.stepId}-v${handoff.version}.json`), "utf8"))).toMatchObject({ id: handoff.id, content: handoff.content });
    expect(JSON.parse(await readFile(path.join(root, ".codegate", "plan", `plan-v${planBefore!.version}.json`), "utf8"))).toMatchObject({ version: planBefore!.version, status: planBefore!.status });
  });
  it("rejects a report that cites a Handoff version that was never issued", async () => { const { flow } = await setup(); await flow.handoff("generic"); const value = report("passed"); value.handoffVersion = 99; await expect(flow.ingest(value)).rejects.toThrow("Handoff 不存在"); });
  it("rejects a claimed passing command when its log attachment is absent", async () => { const { flow } = await setup(); await flow.handoff("generic"); const value = report("passed"); value.commandsRun[0]!.outputArtifact = ".codegate/agent-reports/attachments/missing.log"; await flow.ingest(value); expect((await flow.reviewWithEvidence(value)).decision).toBe("revision-required"); });
});
