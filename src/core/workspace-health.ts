import { access, cp, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { stateSchema, taskSpecSchema, workPlanSchema, type LeaderState, type WorkPlan } from "./schemas.js";
import { LeaderStore } from "./store.js";

export type WorkspaceHealthIssue = {
  code: string;
  severity: "warning" | "error" | "fatal";
  description: string;
  recoverable: boolean;
};

export type WorkspaceHealthReport = {
  status: "healthy" | "degraded" | "repaired";
  writable: boolean;
  issues: WorkspaceHealthIssue[];
  repairs: string[];
  backupPath: string | null;
  checkedAt: string;
};

const now = () => new Date().toISOString();
const normalize = (value: string) => value.replaceAll("\\", "/");
const contentHash = (value: string) => createHash("sha256").update(value).digest("hex");

async function eventLogError(target: string) {
  let content = "";
  try { content = await readFile(target, "utf8"); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : String(error); }
  try {
    const events = content.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { id: string; type: string; at: string; data: unknown; previousHash?: string | null; eventHash?: string });
    if (!events.length || events.some((event) => !event.eventHash)) return null;
    let previousHash: string | null = null;
    for (const event of events) {
      const base = { id: event.id, type: event.type, at: event.at, data: event.data, previousHash: event.previousHash ?? null };
      if (base.previousHash !== previousHash || event.eventHash !== contentHash(JSON.stringify(base))) return "事件哈希链不一致";
      previousHash = event.eventHash!;
    }
    return null;
  } catch (error) { return error instanceof Error ? error.message : String(error); }
}

async function readSchema<T>(target: string, parse: (value: unknown) => T): Promise<{ value: T | null; exists: boolean; error: string | null }> {
  try { return { value: parse(JSON.parse(await readFile(target, "utf8"))), exists: true, error: null }; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { value: null, exists: false, error: null };
    return { value: null, exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

function expectedStepStatus(status: LeaderState["status"]): WorkPlan["steps"][number]["status"] | null {
  if (status === "step-ready") return "ready";
  if (status === "handed-off") return "handed-off";
  if (status === "result-reported" || status === "under-review") return "reported";
  if (status === "correction-ready") return "revision-required";
  if (status === "blocked") return "blocked";
  return null;
}

export async function inspectWorkspace(root: string): Promise<WorkspaceHealthReport> {
  const directory = path.join(path.resolve(root), ".codegate"), issues: WorkspaceHealthIssue[] = [];
  let writable = true;
  try { await access(directory, constants.R_OK | constants.W_OK); } catch { writable = false; issues.push({ code: "workspace-not-writable", severity: "fatal", description: "CodeGate 状态目录不可读写。", recoverable: false }); }
  const state = await readSchema(path.join(directory, "state.json"), (value) => stateSchema.parse(value));
  const task = await readSchema(path.join(directory, "task", "task-spec.json"), (value) => taskSpecSchema.parse(value));
  const plan = await readSchema(path.join(directory, "plan", "plan.json"), (value) => workPlanSchema.parse(value));
  const manifest = await readSchema(path.join(directory, "manifest.json"), (value) => value as { protocolVersion?: number });
  if (manifest.error) issues.push({ code: "manifest-invalid", severity: "fatal", description: "manifest.json 无法解析：" + manifest.error, recoverable: true });
  else if ((manifest.value?.protocolVersion ?? 0) > 2) issues.push({ code: "protocol-newer", severity: "fatal", description: `工作区协议 v${manifest.value!.protocolVersion} 高于当前支持的 v2。`, recoverable: false });
  if (!state.exists) issues.push({ code: "state-missing", severity: "fatal", description: "缺少 state.json。", recoverable: true });
  else if (state.error) issues.push({ code: "state-invalid", severity: "fatal", description: "state.json 无法解析：" + state.error, recoverable: true });
  if (task.exists && task.error) issues.push({ code: "task-current-invalid", severity: "fatal", description: "当前 TaskSpec 损坏：" + task.error, recoverable: true });
  if (plan.exists && plan.error) issues.push({ code: "plan-current-invalid", severity: "fatal", description: "当前 WorkPlan 损坏：" + plan.error, recoverable: true });
  const logError = await eventLogError(path.join(directory, "events.jsonl"));
  if (logError) issues.push({ code: "event-log-invalid", severity: "fatal", description: "事件日志损坏：" + logError, recoverable: true });
  if (state.value && task.value && state.value.taskSpecVersion !== task.value.version) issues.push({ code: "task-version-mismatch", severity: "error", description: `State 引用 TaskSpec v${state.value.taskSpecVersion ?? "null"}，当前指针为 v${task.value.version}。`, recoverable: true });
  if (state.value && plan.value && state.value.workPlanVersion !== plan.value.version) issues.push({ code: "plan-version-mismatch", severity: "error", description: `State 引用 WorkPlan v${state.value.workPlanVersion ?? "null"}，当前指针为 v${plan.value.version}。`, recoverable: true });
  if (state.value?.currentStepId && plan.value) {
    const step = plan.value.steps.find((item) => item.id === state.value!.currentStepId);
    if (!step) issues.push({ code: "current-step-missing", severity: "fatal", description: `State 当前步骤 ${state.value.currentStepId} 不存在。`, recoverable: true });
    else {
      const expected = expectedStepStatus(state.value.status);
      if (expected && step.status !== expected) issues.push({ code: "state-step-mismatch", severity: "error", description: `State=${state.value.status}，但 ${step.id}=${step.status}，预期 ${expected}。`, recoverable: true });
      if (state.value.status === "handed-off") {
        if (!await hasHandoff(directory, step.id)) issues.push({ code: "handoff-missing", severity: "fatal", description: `状态为 handed-off，但 ${step.id} 没有 Handoff。`, recoverable: true });
      }
      if (state.value.status === "result-reported" || state.value.status === "under-review") {
        if (!await hasReport(directory, step.id)) issues.push({ code: "report-missing", severity: "fatal", description: `状态为 ${state.value.status}，但 ${step.id} 没有 Execution Report。`, recoverable: true });
      }
    }
  }
  return { status: issues.length ? "degraded" : "healthy", writable, issues, repairs: [], backupPath: null, checkedAt: now() };
}

async function latestValid<T>(directory: string, pattern: RegExp, parse: (value: unknown) => T) {
  const files = (await readdir(directory).catch(() => [])).map((file) => ({ file, version: Number(file.match(pattern)?.[1] ?? 0) })).filter((item) => item.version > 0).sort((a, b) => b.version - a.version);
  for (const item of files) {
    const parsed = await readSchema(path.join(directory, item.file), parse);
    if (parsed.value) return parsed.value;
  }
  return null;
}

async function hasHandoff(directory: string, stepId: string) {
  const handoffs = await readdir(path.join(directory, "handoffs")).catch(() => []);
  return handoffs.some((file) => file.startsWith(stepId + "-v") && file.endsWith(".json"));
}

async function hasReport(directory: string, stepId: string) {
  const reports = await readdir(path.join(directory, "agent-reports")).catch(() => []);
  for (const file of reports.filter((item) => item.endsWith(".json"))) {
    try {
      const value = JSON.parse(await readFile(path.join(directory, "agent-reports", file), "utf8")) as { stepId?: unknown };
      if (value.stepId === stepId) return true;
    } catch { /* A malformed report is not valid recovery evidence. */ }
  }
  return false;
}

async function backupWorkspace(root: string, reason: string) {
  const source = path.join(path.resolve(root), ".codegate"), id = new Date().toISOString().replace(/[:.]/g, "-") + "-" + reason, target = path.join(source, "backups", id);
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "backups" || entry.name === "events.lock") continue;
    await cp(path.join(source, entry.name), path.join(target, entry.name), { recursive: true, force: false, errorOnExist: true });
  }
  await writeFile(path.join(target, "recovery.json"), JSON.stringify({ reason, createdAt: now(), source: normalize(source) }, null, 2) + "\n", "utf8");
  return normalize(target);
}

function deriveState(taskVersion: number | null, plan: WorkPlan | null): LeaderState {
  const timestamp = now();
  if (!taskVersion) return { schemaVersion: 2, status: "new", taskId: null, taskSpecVersion: null, workPlanVersion: null, currentStepId: null, pendingDecisionId: null, updatedAt: timestamp };
  if (!plan) return { schemaVersion: 2, status: "task-spec-ready", taskId: "recovered-task", taskSpecVersion: taskVersion, workPlanVersion: null, currentStepId: null, pendingDecisionId: null, updatedAt: timestamp };
  const current = plan.steps.find((step) => ["handed-off", "reported", "revision-required", "ready", "blocked"].includes(step.status));
  const status: LeaderState["status"] = plan.status === "completed" || plan.steps.every((step) => step.status === "accepted" || step.status === "abandoned") ? "task-completed" : current?.status === "handed-off" ? "handed-off" : current?.status === "reported" ? "result-reported" : current?.status === "revision-required" ? "correction-ready" : current?.status === "blocked" ? "blocked" : current?.status === "ready" ? "step-ready" : plan.status === "draft" ? "plan-ready" : "blocked";
  return { schemaVersion: 2, status, taskId: plan.id.replace(/^plan-/, ""), taskSpecVersion: taskVersion, workPlanVersion: plan.version, currentStepId: current?.id ?? null, pendingDecisionId: null, updatedAt: timestamp };
}

export async function repairWorkspace(root: string, store: LeaderStore): Promise<WorkspaceHealthReport> {
  const before = await inspectWorkspace(root);
  if (!before.issues.length || !before.writable || before.issues.some((issue) => !issue.recoverable)) return before;
  const backupPath = await backupWorkspace(root, "automatic-repair"), repairs: string[] = [];
  const directory = path.join(path.resolve(root), ".codegate");
  if (before.issues.some((issue) => issue.code === "event-log-invalid")) {
    const corruptName = `events.corrupt-${Date.now()}.jsonl`;
    await rename(path.join(directory, "events.jsonl"), path.join(directory, corruptName));
    repairs.push(`隔离损坏事件日志为 ${corruptName}`);
  }
  if (before.issues.some((issue) => issue.code === "manifest-invalid")) {
    const corruptName = `manifest.corrupt-${Date.now()}.json`;
    await rename(path.join(directory, "manifest.json"), path.join(directory, corruptName));
    repairs.push(`隔离损坏清单为 ${corruptName}`);
  }
  let task = await readSchema(path.join(directory, "task", "task-spec.json"), (value) => taskSpecSchema.parse(value));
  if (!task.value) {
    const recovered = await latestValid(path.join(directory, "task"), /^task-spec-v(\d+)\.json$/, (value) => taskSpecSchema.parse(value));
    if (recovered) { await writeFile(path.join(directory, "task", "task-spec.json"), JSON.stringify(recovered, null, 2) + "\n", "utf8"); repairs.push(`恢复 TaskSpec v${recovered.version}`); task = { value: recovered, exists: true, error: null }; }
  }
  let plan = await readSchema(path.join(directory, "plan", "plan.json"), (value) => workPlanSchema.parse(value));
  if (!plan.value) {
    const recovered = await latestValid(path.join(directory, "plan"), /^plan-v(\d+)\.json$/, (value) => workPlanSchema.parse(value));
    if (recovered) { await writeFile(path.join(directory, "plan", "plan.json"), JSON.stringify(recovered, null, 2) + "\n", "utf8"); repairs.push(`恢复 WorkPlan v${recovered.version}`); plan = { value: recovered, exists: true, error: null }; }
  }
  const stateRead = await readSchema(path.join(directory, "state.json"), (value) => stateSchema.parse(value));
  let state = stateRead.value ?? deriveState(task.value?.version ?? null, plan.value);
  if (!stateRead.value) repairs.push("重建 LeaderState");
  if (task.value) state = { ...state, taskId: task.value.id, taskSpecVersion: task.value.version };
  if (plan.value) state = { ...state, workPlanVersion: plan.value.version };
  if (state.currentStepId && plan.value) {
    let step = plan.value.steps.find((item) => item.id === state.currentStepId);
    if (!step) {
      state = deriveState(task.value?.version ?? null, plan.value);
      if (task.value) state = { ...state, taskId: task.value.id };
      repairs.push("当前步骤不存在，已根据 WorkPlan 重建工作流状态");
      step = state.currentStepId ? plan.value.steps.find((item) => item.id === state.currentStepId) : undefined;
    }
    if (step) {
      let desiredStatus = expectedStepStatus(state.status);
      if (state.status === "handed-off" && !await hasHandoff(directory, step.id)) {
        state = { ...state, status: "step-ready" }; desiredStatus = "ready";
        repairs.push("缺少 Handoff，回退到 step-ready");
      }
      if (["result-reported", "under-review"].includes(state.status) && !await hasReport(directory, step.id)) {
        const handedOff = await hasHandoff(directory, step.id);
        state = { ...state, status: handedOff ? "handed-off" : "step-ready" };
        desiredStatus = handedOff ? "handed-off" : "ready";
        repairs.push("缺少 Execution Report，回退到可恢复状态");
      }
      if (desiredStatus && step.status !== desiredStatus) {
        const nextVersion = await store.nextPlanVersion();
        const repairedPlan: WorkPlan = { ...plan.value, version: nextVersion, steps: plan.value.steps.map((item) => item.id === step!.id ? { ...item, status: desiredStatus! } : item), updatedAt: now() };
        await store.savePlan(repairedPlan);
        plan = { value: repairedPlan, exists: true, error: null };
        state = { ...state, workPlanVersion: nextVersion };
        repairs.push(`将 ${step.id} 修复为 ${desiredStatus}`);
      }
    }
  }
  await store.setState({ ...state, updatedAt: now() });
  const after = await inspectWorkspace(root);
  return { ...after, status: after.issues.length ? "degraded" : "repaired", repairs, backupPath, checkedAt: now() };
}
