import { access, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LeaderWorkflow } from "../src/core/workflow.js";
import { LeaderStore } from "../src/core/store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function readyWorkspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "codegate-health-"));
  roots.push(root);
  await writeFile(path.join(root, "task.md"), "Build and verify a commercial desktop application.\n", "utf8");
  const flow = new LeaderWorkflow(root);
  await flow.intake("task.md");
  await flow.approveTask();
  await flow.architecture("Desktop boundary", "Keep privileged operations in Electron main.");
  await flow.createPlan();
  await flow.approvePlanWithPatch();
  return { root, flow };
}

async function handedOffWorkspace() {
  const { root, flow } = await readyWorkspace();
  await flow.handoff("generic");
  return { root, flow };
}

describe("workspace diagnosis and recovery", () => {
  it("repairs the observed handed-off/state and ready/plan mismatch with a backup", async () => {
    const { root, flow } = await handedOffWorkspace();
    const plan = (await flow.store.plan())!;
    const inconsistent = { ...plan, steps: plan.steps.map((step) => step.id === "step-001" ? { ...step, status: "ready" as const } : step) };
    await writeFile(path.join(root, ".codegate", "plan", "plan.json"), JSON.stringify(inconsistent, null, 2), "utf8");

    const opened = await new LeaderWorkflow(root).openProject();

    expect(opened.health.status).toBe("repaired");
    expect(opened.health.repairs).toContain("将 step-001 修复为 handed-off");
    expect(opened.state.status).toBe("handed-off");
    expect(opened.plan?.steps[0]?.status).toBe("handed-off");
    expect(opened.plan!.version).toBeGreaterThan(plan.version);
    expect(opened.health.backupPath).not.toBeNull();
    await access(opened.health.backupPath!);
  });

  it("restores a corrupt current plan pointer from immutable history", async () => {
    const { root } = await handedOffWorkspace();
    await writeFile(path.join(root, ".codegate", "plan", "plan.json"), "{broken", "utf8");

    const opened = await new LeaderWorkflow(root).openProject();

    expect(opened.health.status).toBe("repaired");
    expect(opened.health.repairs.some((item) => item.startsWith("恢复 WorkPlan v"))).toBe(true);
    expect(opened.plan?.steps[0]?.status).toBe("handed-off");
    expect(JSON.parse(await readFile(path.join(root, ".codegate", "plan", "plan.json"), "utf8"))).toMatchObject({ status: "executing" });
  });

  it("rolls back to a runnable step when a handed-off state has no Handoff artifact", async () => {
    const { root } = await handedOffWorkspace();
    await unlink(path.join(root, ".codegate", "handoffs", "step-001-v1.json"));
    await unlink(path.join(root, ".codegate", "handoffs", "step-001-v1.md"));

    const opened = await new LeaderWorkflow(root).openProject();

    expect(opened.health.status).toBe("repaired");
    expect(opened.health.repairs).toContain("缺少 Handoff，回退到 step-ready");
    expect(opened.state.status).toBe("step-ready");
    expect(opened.plan?.steps[0]?.status).toBe("ready");
  });

  it("finishes a durable multi-artifact Handoff transaction after an interrupted write", async () => {
    const { root } = await readyWorkspace();
    const interrupted = new LeaderWorkflow(root, new LeaderStore(root, { failTransactionAfterWrites: 3 }));
    await expect(interrupted.handoff("generic")).rejects.toThrow("Injected transaction interruption");
    expect((await readdir(path.join(root, ".codegate", "transactions"))).some((file) => file.endsWith(".json"))).toBe(true);

    const opened = await new LeaderWorkflow(root).openProject();

    expect(opened.health.status).toBe("healthy");
    expect(opened.state.status).toBe("handed-off");
    expect(opened.plan?.steps[0]?.status).toBe("handed-off");
    await access(path.join(root, ".codegate", "baselines", "step-001-v1.json"));
    await access(path.join(root, ".codegate", "handoffs", "step-001-v1.json"));
    const manifests = (await readdir(path.join(root, ".codegate", "transactions"))).filter((file) => file.endsWith(".json"));
    expect(JSON.parse(await readFile(path.join(root, ".codegate", "transactions", manifests.at(-1)!), "utf8")).status).toBe("completed");
  });

  it("quarantines a malformed event log and starts a valid audit chain", async () => {
    const { root } = await handedOffWorkspace();
    await writeFile(path.join(root, ".codegate", "events.jsonl"), "{malformed\n", "utf8");

    const opened = await new LeaderWorkflow(root).openProject();

    expect(opened.health.status).toBe("repaired");
    expect(opened.eventLog.valid).toBe(true);
    expect((await readdir(path.join(root, ".codegate"))).some((file) => file.startsWith("events.corrupt-") && file.endsWith(".jsonl"))).toBe(true);
  });

  it("takes over an event lock left by a dead process", async () => {
    const { root, flow } = await readyWorkspace();
    await writeFile(path.join(root, ".codegate", "events.lock"), JSON.stringify({ pid: 999_999_999, createdAt: new Date().toISOString() }), "utf8");

    await flow.store.event("recovered-lock", { ok: true });

    expect((await flow.store.verifyEventLog()).valid).toBe(true);
  });

  it("refuses to downgrade-write a workspace created by a newer protocol", async () => {
    const { root } = await readyWorkspace();
    const target = path.join(root, ".codegate", "manifest.json"), future = { protocolVersion: 99, productVersion: "future", sentinel: "must-remain" };
    await writeFile(target, JSON.stringify(future, null, 2), "utf8");

    await expect(new LeaderWorkflow(root).openProject()).rejects.toThrow("请升级 CodeGate Leader");

    expect(JSON.parse(await readFile(target, "utf8"))).toEqual(future);
  });
});
