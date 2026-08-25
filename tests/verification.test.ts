import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LeaderWorkflow } from "../src/core/workflow.js";
import { parseApprovedCommand } from "../src/core/verification-runner.js";
import type { ExecutionReport } from "../src/core/schemas.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function reportedWorkspace(command = "node --version") {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegate-verify-")); roots.push(root);
  await writeFile(path.join(root, "task.md"), "Build and verify a desktop product.\n", "utf8");
  const flow = new LeaderWorkflow(root);
  await flow.intake("task.md"); await flow.approveTask(); await flow.architecture("Boundary", "Keep execution isolated."); await flow.createPlan(); await flow.approvePlanWithPatch(); await flow.handoff("generic");
  const report: ExecutionReport = { reportId: "verification-report", stepId: "step-001", handoffVersion: 1, agent: { name: "test" }, status: "completed", summary: "environment discovered", filesRead: ["task.md"], filesChanged: [], commandsRun: [{ command, exitCode: 0, status: "passed" }], outputs: [], assumptions: [], risks: [], unresolvedItems: [], deviations: [], recommendedNextAction: "verify", environmentFacts: { discoveredBy: "test", sourceRevision: null, languages: ["TypeScript"], frameworks: [], packageManagers: ["npm"], entryPoints: [], importantFiles: ["task.md"], buildCommands: [], testCommands: [], verificationCommands: [command], environmentRequirements: ["Node.js"], unknowns: [], discoveredAt: new Date().toISOString() }, generatedAt: new Date().toISOString() };
  await flow.ingest(report); await flow.confirmEnvironment();
  return { root, flow, report };
}

describe("CodeGate-owned verification", () => {
  it("rejects command chaining and prefix-based allowlist bypasses", async () => {
    expect(() => parseApprovedCommand("npm test && echo forged")).toThrow("Shell 元字符");
    expect(() => parseApprovedCommand("npm test | tee result.log")).toThrow("Shell 元字符");
    const { flow } = await reportedWorkspace();
    await expect(flow.runVerification("node --version --help", true)).rejects.toThrow("精确命令");
    await expect(flow.runVerification("node --version", false)).rejects.toThrow("明确确认");
  });

  it("executes an exact confirmed command and persists a hash-verifiable evidence log", async () => {
    const { root, flow } = await reportedWorkspace();
    const run = await flow.runVerification("node --version", true);

    expect(run).toMatchObject({ source: "codegate", status: "passed", exitCode: 0, command: "node --version" });
    const logPath = path.join(root, run.outputArtifact);
    await access(logPath);
    expect((await readFile(logPath, "utf8"))).toContain("--- STDOUT ---");
    expect((await flow.store.verificationRuns("step-001"))[0]?.outputHash).toBe(run.outputHash);
  });

  it("still rejects a malicious command even if it was reported and confirmed as environment data", async () => {
    const command = "node --version && echo forged";
    const { flow } = await reportedWorkspace(command);
    await expect(flow.runVerification(command, true)).rejects.toThrow("Shell 元字符");
  });
});
