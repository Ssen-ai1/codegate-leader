import { afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { LeaderWorkflow } from "../src/core/workflow.js";
import { LeaderStore } from "../src/core/store.js";
import type { ExecutionReport, PlanPatch } from "../src/core/schemas.js";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function git(root: string, ...args: string[]) { await execFile("git", args, { cwd: root, windowsHide: true }); }
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegate-alpha-")); roots.push(root);
  await writeFile(path.join(root, "task.md"), "# 交付物\n实现健康检查端点。\n# 要求\n必须返回 JSON 状态。\n# 验收\n运行测试并通过。\n", "utf8");
  await git(root, "init"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "CodeGate Test"); await git(root, "add", "task.md"); await git(root, "commit", "-m", "fixture");
  const flow = new LeaderWorkflow(root); await flow.intake("task.md"); await flow.approveTask(); await flow.architecture("Boundary", "Keep the existing service boundary."); await flow.createPlan(); await flow.approvePlanWithPatch();
  return { root, flow };
}

function report(filesChanged: string[], log: string): ExecutionReport {
  return { reportId: "report-" + Date.now(), stepId: "step-001", handoffVersion: 1, agent: { name: "test" }, status: "completed", summary: "explored", filesRead: ["task.md"], filesChanged, commandsRun: [{ command: "verify", exitCode: 0, status: "passed", outputArtifact: log }], outputs: [], decisionsMade: [], assumptions: [], risks: [], unresolvedItems: [], deviations: [], recommendedNextAction: "review", generatedAt: new Date().toISOString() };
}

async function addTestEnvironment(root: string, value: ExecutionReport) {
  value.environmentFacts = { discoveredBy: "test", sourceRevision: (await execFile("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true })).stdout.trim(), languages: ["TypeScript"], frameworks: [], packageManagers: ["npm"], entryPoints: [], importantFiles: ["task.md"], buildCommands: [], testCommands: [], verificationCommands: ["node --version"], environmentRequirements: ["Node.js"], unknowns: [], discoveredAt: new Date().toISOString() };
}

describe("trusted alpha protocol", () => {
  it("creates protocol v2 and a source-traceable dynamic plan", async () => {
    const { root, flow } = await setup();
    const manifest = JSON.parse(await readFile(path.join(root, ".codegate", "manifest.json"), "utf8"));
    const schema = JSON.parse(await readFile(path.join(root, ".codegate", "protocols", "execution-report.schema.json"), "utf8"));
    const task = await flow.store.task(); const plan = await flow.store.plan();
    expect(manifest.protocolVersion).toBe(2); expect(schema.$id).toContain("execution-report-v2");
    expect(task?.requirements[0]?.description).toContain("JSON");
    expect(task?.requirements[0]?.sourcePointers[0]?.locator).toContain("#L");
    expect(plan?.steps).toHaveLength(3); expect(plan?.steps[1]?.objective).toContain("健康检查");
  });

  it("excludes unchanged pre-handoff dirt while accepting evidenced post-handoff work", async () => {
    const { root, flow } = await setup();
    await writeFile(path.join(root, "preexisting.txt"), "keep", "utf8");
    await flow.handoff("generic");
    await writeFile(path.join(root, "observed.txt"), "new evidence", "utf8");
    const log = ".codegate/agent-reports/attachments/check.log"; await writeFile(path.join(root, log), "verification passed", "utf8");
    const value = report(["observed.txt"], log); await addTestEnvironment(root, value); await flow.ingest(value); await flow.confirmEnvironment(); await flow.runVerification("node --version", true);
    const review = await flow.reviewWithEvidence(value);
    expect(review.decision).toBe("accepted");
    expect(review.driftFindings).toEqual([]);
    expect((await flow.store.state()).currentStepId).toBe("step-002");
  });

  it("opens and resolves an explicit user decision for unreported scope", async () => {
    const { root, flow } = await setup(); await flow.handoff("codex");
    await writeFile(path.join(root, "unexpected.txt"), "scope expansion", "utf8");
    const log = ".codegate/agent-reports/attachments/check.log"; await writeFile(path.join(root, log), "verification passed", "utf8");
    const value = report([], log); await flow.ingest(value); const review = await flow.reviewWithEvidence(value);
    expect(review.decision).toBe("user-decision-required");
    const state = await flow.store.state(); expect(state.pendingDecisionId).toBeTruthy();
    await flow.resolveDecision(state.pendingDecisionId!, "request-correction");
    expect((await flow.store.state()).status).toBe("correction-ready");
  });

  it("does not accept an implementation from self-declared mappings and an unapproved command", async () => {
    const { root, flow } = await setup(); await flow.handoff("generic");
    const exploreLog = ".codegate/agent-reports/attachments/explore.log"; await writeFile(path.join(root, exploreLog), "explored", "utf8");
    const exploration = report([], exploreLog); await addTestEnvironment(root, exploration);
    await flow.ingest(exploration); await flow.confirmEnvironment(); await flow.runVerification("node --version", true); expect((await flow.reviewWithEvidence(exploration)).decision).toBe("accepted"); await flow.handoff("generic");
    await writeFile(path.join(root, "feature.ts"), "export const healthy = true;", "utf8");
    const log = ".codegate/agent-reports/attachments/fake.log"; await writeFile(path.join(root, log), "looks good", "utf8");
    const plan = await flow.store.plan(); const step = plan!.steps.find((item) => item.id === "step-002")!;
    const implementation: ExecutionReport = { reportId: "report-fake-command", stepId: "step-002", handoffVersion: 1, agent: { name: "test" }, status: "completed", summary: "claimed done", filesRead: [], filesChanged: ["feature.ts"], commandsRun: [{ command: "echo passed", exitCode: 0, status: "passed", outputArtifact: log, coversAcceptanceIds: step.acceptanceIds }], outputs: [{ type: "code", path: "feature.ts", description: "implementation", coversRequirementIds: step.requirementIds, coversAcceptanceIds: step.acceptanceIds, coversRubricItemIds: step.rubricItemIds }], decisionsMade: [], assumptions: [], risks: [], unresolvedItems: [], deviations: [], recommendedNextAction: "accept", generatedAt: new Date().toISOString() };
    await flow.ingest(implementation); const review = await flow.reviewWithEvidence(implementation);
    expect(review.decision).toBe("revision-required"); expect(review.verificationFindings?.some((item) => item.code === "no-codegate-verification")).toBe(true);
  });

  it("applies a real incremental PlanPatch only to unstarted steps", async () => {
    const { flow } = await setup(); const plan = await flow.store.plan();
    const patch: PlanPatch = { id: "patch-objective", basePlanVersion: plan!.version, targetPlanVersion: plan!.version + 1, reason: "Refine the unstarted deliverable", triggeredBy: "user", operations: [{ type: "modify-step-objective", stepId: "step-002", description: "Clarify output", objective: "Implement a JSON health endpoint without unrelated refactoring." }, { type: "add-risk", description: "Record compatibility risk", risk: "Existing clients may depend on the response shape." }], affectedStepIds: ["step-002"], requiresUserApproval: true, createdAt: new Date().toISOString() };
    await expect(flow.applyPlanPatch(patch)).rejects.toThrow("需要用户批准");
    const revised = await flow.applyPlanPatch(patch, true);
    expect(revised.steps[1]?.objective).toContain("without unrelated refactoring");
    expect(revised.risks).toContain("Existing clients may depend on the response shape.");
  });

  it("versions Desktop TaskSpec edits with user-message provenance", async () => {
    const { flow } = await setup();
    await flow.reopenTask("Add a confirmed deliverable");
    const revised = await flow.reviseTaskFromUi({ newRequirement: "必须记录审计时间。", newDeliverable: "交付审计记录。", newAcceptance: "审计记录可以人工核对。" });
    expect(revised.version).toBe(3);
    expect(revised.requirements.at(-1)?.sourcePointers[0]).toMatchObject({ sourceType: "user-message", locator: "desktop-task-editor/new-requirement" });
    expect((await flow.store.state()).status).toBe("intake");
  });

  it("detects event-log tampering through the hash chain", async () => {
    const { root, flow } = await setup(); expect((await flow.store.verifyEventLog()).valid).toBe(true);
    const target = path.join(root, ".codegate", "events.jsonl"); const lines = (await readFile(target, "utf8")).trim().split(/\r?\n/); const first = JSON.parse(lines[0]!); first.type = "tampered"; lines[0] = JSON.stringify(first); await writeFile(target, lines.join("\n") + "\n", "utf8");
    expect((await flow.store.verifyEventLog()).valid).toBe(false);
  });

  it("migrates protocol-v1 state while preserving a backup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-migrate-")); roots.push(root); await mkdir(path.join(root, ".codegate"), { recursive: true });
    await writeFile(path.join(root, ".codegate", "state.json"), JSON.stringify({ schemaVersion: 1, status: "new", taskId: null, taskSpecVersion: null, workPlanVersion: null, currentStepId: null, updatedAt: new Date().toISOString() }), "utf8");
    const store = new LeaderStore(root); await store.init();
    expect((await store.state()).schemaVersion).toBe(2);
    expect(JSON.parse(await readFile(path.join(root, ".codegate", "state-v1.backup.json"), "utf8")).schemaVersion).toBe(1);
  });
});
