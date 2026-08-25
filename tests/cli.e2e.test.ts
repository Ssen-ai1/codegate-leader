import { afterEach, describe, expect, it } from "vitest";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const execFile = promisify(execFileCallback);
const roots: string[] = [];
const cli = path.resolve(process.cwd(), "dist", "cli.js");

async function run(root: string, ...args: string[]) {
  const result = await execFile(process.execPath, [cli, ...args], { cwd: root, windowsHide: true });
  return result.stdout;
}

async function git(root: string, ...args: string[]) { await execFile("git", args, { cwd: root, windowsHide: true }); }

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("CLI end-to-end workflow", () => {
  it("moves an approved task through a reviewed failure into a correction handoff", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-cli-"));
    roots.push(root);
    await writeFile(path.join(root, "task.md"), "Investigate the project before implementation.\n", "utf8");
    await git(root, "init"); await git(root, "config", "user.email", "test@example.com"); await git(root, "config", "user.name", "CodeGate Test"); await git(root, "add", "task.md"); await git(root, "commit", "-m", "fixture");
    const reportPath = path.join(os.tmpdir(), "codegate-report-" + Date.now() + ".json");
    roots.push(reportPath);
    await writeFile(reportPath, JSON.stringify({ reportId: "report-cli", stepId: "step-001", handoffVersion: 1, agent: { name: "test" }, status: "failed", summary: "verification failed", filesRead: [], filesChanged: [], commandsRun: [{ command: "npm test", exitCode: 1, status: "failed" }], outputs: [], assumptions: [], risks: [], unresolvedItems: [], deviations: [], recommendedNextAction: "correct", generatedAt: new Date().toISOString() }), "utf8");

    await run(root, "init"); await run(root, "intake", "task.md"); await run(root, "approve-task"); await run(root, "architecture", "Boundary", "Keep Leader separate from Coding Agents."); await run(root, "plan"); await run(root, "approve-plan");
    expect(await run(root, "next", "--agent", "codex")).toContain("CodeGate Handoff: step-001 v1");
    await run(root, "ingest", reportPath);
    expect(await run(root, "review", reportPath)).toContain("revision-required");
    expect(await run(root, "correct", "--agent", "claude")).toContain("Correction Requirements");
    expect(await run(root, "export-handoff", "step-001")).toContain("step-001 v2");
  }, 15_000);
});
