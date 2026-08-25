import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactForModel } from "../src/core/workflow.js";
import { captureBaseline, observeSince } from "../src/core/workspace-observer.js";

const execFile = promisify(execFileCallback), roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("semantic review evidence security", () => {
  it("redacts sensitive fields and inline credentials without deleting unrelated context", () => {
    const result = redactForModel({ objective: "Keep this objective", apiKey: "sk-supersecret123", nested: { note: "password=hunter2 continue", safe: "visible" } });
    expect(result).toContain("Keep this objective");
    expect(result).toContain('"apiKey": "[REDACTED]"');
    expect(result).toContain("password=[REDACTED]");
    expect(result).toContain("visible");
    expect(result).not.toContain("supersecret");
    expect(result).not.toContain("hunter2");
  });

  it("adds bounded untracked text content to semantic diff evidence", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-evidence-")); roots.push(root);
    await writeFile(path.join(root, "base.txt"), "base", "utf8");
    await execFile("git", ["init"], { cwd: root, windowsHide: true }); await execFile("git", ["config", "user.email", "test@example.com"], { cwd: root, windowsHide: true }); await execFile("git", ["config", "user.name", "CodeGate Test"], { cwd: root, windowsHide: true }); await execFile("git", ["add", "base.txt"], { cwd: root, windowsHide: true }); await execFile("git", ["commit", "-m", "base"], { cwd: root, windowsHide: true });
    const baseline = await captureBaseline(root, "step-001", 1, new Date().toISOString());
    await writeFile(path.join(root, "feature.ts"), "export const feature = 'implemented';\n", "utf8");

    const observation = await observeSince(root, baseline);

    expect(observation.changedFiles).toContain("feature.ts");
    expect(observation.diff).toContain("export const feature");
  });
});
