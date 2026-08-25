import path from "node:path";
import { appendFile, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  architectureDecisionSchema,
  assistantMessageSchema,
  correctionPatchSchema,
  competitionDebugSessionSchema,
  competitionDefenseSessionSchema,
  competitionMetricRecordSchema,
  executionReportSchema,
  handoffSchema,
  leaderAnalysisSchema,
  learningProfileSchema,
  modelUsageSchema,
  projectEnvironmentFactsSchema,
  projectConfigSchema,
  planPatchSchema,
  reviewReportSchema,
  skillManifestSchema,
  stateSchema,
  taskSpecSchema,
  userDecisionRequestSchema,
  verificationRunSchema,
  workspaceBaselineSchema,
  workPlanSchema,
  type ArchitectureDecision,
  type AssistantMessage,
  type CorrectionPatch,
  type CompetitionDebugSession,
  type CompetitionDefenseSession,
  type CompetitionMetricRecord,
  type ExecutionReport,
  type Handoff,
  type ProjectEnvironmentFacts,
  type ProjectConfig,
  type LeaderState,
  type LeaderAnalysis,
  type LearningProfile,
  type ModelUsage,
  type ReviewReport,
  type SkillManifest,
  type TaskSpec,
  type UserDecisionRequest,
  type VerificationRun,
  type WorkspaceBaseline,
  type WorkPlan
} from "./schemas.js";
import { executionReportJsonSchema, ownershipProtocol, protocolIndex, protocolVersion } from "./protocols.js";

const now = () => new Date().toISOString();
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function json(target: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(target, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`无法读取 CodeGate 工件 ${target}：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function write(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

async function writeVersioned(current: string, history: string, value: unknown, label: string): Promise<void> {
  const previous = await json(history);
  if (previous) {
    if (JSON.stringify(previous) !== JSON.stringify(value)) throw new Error(`${label} 已存在，不能重写历史。`);
    const pointer = await json(current);
    if (JSON.stringify(pointer) === JSON.stringify(value)) throw new Error(`${label} 已存在，不能重写历史。`);
  } else await write(history, value);
  // Writing history first makes a failed current-pointer update recoverable by
  // safely retrying the same immutable value.
  await write(current, value);
}

export type StoreTransactionEntry = {
  relativePath: string;
  value: unknown;
  format?: "json" | "text";
  immutable?: boolean;
};

type TransactionManifest = {
  id: string;
  label: string;
  status: "pending" | "completed";
  createdAt: string;
  completedAt: string | null;
  entries: Array<{ relativePath: string; stageFile: string; contentHash: string; immutable: boolean }>;
};

export class LeaderStore {
  readonly dir: string;

  constructor(root: string, private readonly testHooks: { failTransactionAfterWrites?: number } = {}) { this.dir = path.join(path.resolve(root), ".codegate"); }
  file(...parts: string[]) { return path.join(this.dir, ...parts); }

  async prepareDirectories() {
    for (const part of ["task/sources", "architecture/decisions", "plan/patches", "skills", "handoffs", "agent-reports/attachments", "reviews", "corrections", "learning", "assistant", "usage", "environment", "protocols", "baselines", "decisions", "backups", "transactions", "verifications", "competition/debug", "competition/metrics", "competition/defense"]) {
      await mkdir(this.file(part), { recursive: true });
    }
  }

  async init() {
    await this.prepareDirectories();
    await this.recoverPendingTransactions();
    await this.migrateEventLog();
    const manifest = await json(this.file("manifest.json")) as { protocolVersion?: number; createdAt?: string } | null;
    if ((manifest?.protocolVersion ?? 0) > protocolVersion) throw new Error(`该工作区使用更新的协议 v${manifest!.protocolVersion}；当前应用仅支持 v${protocolVersion}。请升级 CodeGate Leader，已阻止降级写入。`);
    const existingState = await json(this.file("state.json"));
    if (!existingState) {
      await write(this.file("state.json"), {
        schemaVersion: 2, status: "new", taskId: null, taskSpecVersion: null,
        workPlanVersion: null, currentStepId: null, pendingDecisionId: null, updatedAt: now()
      });
    } else if ((existingState as { schemaVersion?: number }).schemaVersion === 1) {
      await write(this.file("state-v1.backup.json"), existingState);
      await write(this.file("state.json"), { ...existingState as object, schemaVersion: 2, pendingDecisionId: null, updatedAt: now() });
    }
    await write(this.file("manifest.json"), { protocolVersion, productVersion: "0.2.0-alpha.9", workspaceRoot: path.dirname(this.dir), createdAt: manifest?.createdAt ?? now(), updatedAt: now() });
    await Promise.all([
      write(this.file("protocols/index.json"), protocolIndex),
      write(this.file("protocols/execution-report.schema.json"), executionReportJsonSchema),
      write(this.file("protocols/ownership.json"), ownershipProtocol)
    ]);
  }

  async commitArtifacts(label: string, entries: StoreTransactionEntry[], eventData: unknown = {}) {
    await this.prepareDirectories();
    if (!entries.length) throw new Error("事务必须至少包含一个工件。");
    const id = randomUUID(), transactionDirectory = this.file("transactions", id);
    await mkdir(transactionDirectory, { recursive: false });
    const seen = new Set<string>();
    const manifestEntries: TransactionManifest["entries"] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const relativePath = entry.relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
      const target = path.resolve(this.dir, relativePath), relative = path.relative(this.dir, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || relativePath.startsWith("transactions/")) throw new Error(`事务工件路径不安全：${entry.relativePath}`);
      if (seen.has(relativePath)) throw new Error(`事务包含重复工件：${relativePath}`);
      seen.add(relativePath);
      const content = entry.format === "text" ? String(entry.value) : JSON.stringify(entry.value, null, 2) + "\n";
      const stageFile = `${index}.stage`;
      await writeFile(path.join(transactionDirectory, stageFile), content, "utf8");
      manifestEntries.push({ relativePath, stageFile, contentHash: hash(content), immutable: entry.immutable ?? false });
    }
    const manifest: TransactionManifest = { id, label, status: "pending", createdAt: now(), completedAt: null, entries: manifestEntries };
    const manifestPath = this.file("transactions", `${id}.json`);
    await write(manifestPath, manifest);
    await this.applyTransaction(manifest, true);
    await write(manifestPath, { ...manifest, status: "completed", completedAt: now() });
    await Promise.all(manifest.entries.map((entry) => unlink(path.join(transactionDirectory, entry.stageFile)).catch(() => undefined)));
    await this.event("transaction", { id, label, artifacts: entries.map((entry) => entry.relativePath), data: eventData });
    return id;
  }

  async recoverPendingTransactions() {
    const directory = this.file("transactions");
    await mkdir(directory, { recursive: true });
    const files = await readdir(directory);
    for (const file of files.filter((item) => item.endsWith(".json")).sort()) {
      const value = await json(path.join(directory, file));
      const manifest = value as TransactionManifest | null;
      if (!manifest || manifest.status !== "pending" || !Array.isArray(manifest.entries)) continue;
      await this.applyTransaction(manifest, false);
      await write(path.join(directory, file), { ...manifest, status: "completed", completedAt: now() });
      const stageDirectory = this.file("transactions", manifest.id);
      await Promise.all(manifest.entries.map((entry) => unlink(path.join(stageDirectory, entry.stageFile)).catch(() => undefined)));
    }
  }

  private async applyTransaction(manifest: TransactionManifest, allowFault: boolean) {
    const stageDirectory = this.file("transactions", manifest.id);
    let writes = 0;
    for (const entry of manifest.entries) {
      const target = path.resolve(this.dir, entry.relativePath), relative = path.relative(this.dir, target);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`事务清单路径不安全：${entry.relativePath}`);
      let existing: Buffer | null = null;
      try { existing = await readFile(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (existing && hash(existing) === entry.contentHash) continue;
      if (existing && entry.immutable) throw new Error(`不可变事务工件已存在且内容不同：${entry.relativePath}`);
      const stage = await readFile(path.join(stageDirectory, entry.stageFile));
      if (hash(stage) !== entry.contentHash) throw new Error(`事务暂存工件校验失败：${entry.relativePath}`);
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${manifest.id}.tmp`;
      await writeFile(temporary, stage);
      await rename(temporary, target);
      writes++;
      if (allowFault && this.testHooks.failTransactionAfterWrites === writes) throw new Error("Injected transaction interruption");
    }
  }

  async state(): Promise<LeaderState> { await this.init(); return stateSchema.parse(await json(this.file("state.json"))); }
  async setState(next: LeaderState) { await write(this.file("state.json"), stateSchema.parse(next)); await this.event("state", { status: next.status }); }
  async event(type: string, data: unknown) {
    await mkdir(this.dir, { recursive: true });
    await this.withEventLock(async () => {
      let previousHash: string | null = null;
      try {
        const lines = (await readFile(this.file("events.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
        previousHash = lines.length ? (JSON.parse(lines.at(-1)!) as { eventHash?: string }).eventHash ?? null : null;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const base = { id: randomUUID(), type, at: now(), data, previousHash };
      await appendFile(this.file("events.jsonl"), `${JSON.stringify({ ...base, eventHash: hash(JSON.stringify(base)) })}\n`);
    });
  }

  async verifyEventLog() {
    let content = "";
    try { content = await readFile(this.file("events.jsonl"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { valid: true, events: 0 }; throw error; }
    let previousHash: string | null = null; let count = 0;
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      const event = JSON.parse(line) as { id: string; type: string; at: string; data: unknown; previousHash: string | null; eventHash: string };
      const base = { id: event.id, type: event.type, at: event.at, data: event.data, previousHash: event.previousHash };
      if (event.previousHash !== previousHash || event.eventHash !== hash(JSON.stringify(base))) return { valid: false, events: count };
      previousHash = event.eventHash; count++;
    }
    return { valid: true, events: count };
  }

  private async withEventLock<T>(action: () => Promise<T>): Promise<T> {
    const lock = this.file("events.lock");
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const handle = await open(lock, "wx");
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: now() }), "utf8"); return await action(); } finally { await handle.close(); await unlink(lock).catch(() => undefined); }
      } catch (error) {
        if (!["EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          const lockAge = await stat(lock).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
          const owner: { pid?: number } = await readFile(lock, "utf8").then((value) => JSON.parse(value) as { pid?: number }).catch(() => ({}));
          let ownerAlive = true;
          if (typeof owner.pid === "number") { try { process.kill(owner.pid, 0); } catch { ownerAlive = false; } }
          if (!ownerAlive || lockAge > 30_000 || (!owner.pid && lockAge > 5_000)) { await unlink(lock).catch(() => undefined); continue; }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error("CodeGate 事件日志正被另一个进程占用。");
  }

  private async migrateEventLog() {
    let content = "";
    try { content = await readFile(this.file("events.jsonl"), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    const lines = content.split(/\r?\n/).filter(Boolean);
    if (!lines.length) return;
    const parsed = lines.map((line) => JSON.parse(line) as { id: string; type: string; at: string; data: unknown; eventHash?: string });
    if (parsed.every((event) => event.eventHash)) return;
    const backup = this.file("events-v1.backup.jsonl");
    if (!await json(backup).catch(() => null)) await writeFile(backup, content, "utf8");
    let previousHash: string | null = null;
    const migrated = parsed.map((event) => {
      const base = { id: event.id, type: event.type, at: event.at, data: event.data, previousHash };
      const next = { ...base, eventHash: hash(JSON.stringify(base)) };
      previousHash = next.eventHash;
      return JSON.stringify(next);
    });
    await writeFile(this.file("events.jsonl"), migrated.join("\n") + "\n", "utf8");
  }

  async task(): Promise<TaskSpec | null> { const value = await json(this.file("task/task-spec.json")); return value ? taskSpecSchema.parse(value) : null; }
  async projectConfig(): Promise<ProjectConfig> {
    const value = await json(this.file("project.json"));
    return value ? projectConfigSchema.parse(value) : { mode: "product", createdAt: now(), updatedAt: now() };
  }
  async saveProjectConfig(mode: ProjectConfig["mode"]) {
    const current = await json(this.file("project.json")) as ProjectConfig | null, timestamp = now();
    const config = projectConfigSchema.parse({ mode, createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp });
    await write(this.file("project.json"), config); await this.event("project-mode", { mode }); return config;
  }
  async plan(): Promise<WorkPlan | null> { const value = await json(this.file("plan/plan.json")); return value ? workPlanSchema.parse(value) : null; }
  async environment(): Promise<ProjectEnvironmentFacts | null> { const value = await json(this.file("environment/current.json")); return value ? projectEnvironmentFactsSchema.parse(value) : null; }

  async decisions(): Promise<ArchitectureDecision[]> {
    const files = await readdir(this.file("architecture/decisions"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("architecture/decisions", file))));
    const parsed = values.filter((value): value is object => value !== null).map((value) => architectureDecisionSchema.parse(value));
    const latest = new Map<string, ArchitectureDecision>();
    for (const decision of parsed) if (!latest.has(decision.id) || latest.get(decision.id)!.version < decision.version) latest.set(decision.id, decision);
    return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async assistantMessages(): Promise<AssistantMessage[]> {
    const value = await json(this.file("assistant/history.json"));
    if (!value) return [];
    return assistantMessageSchema.array().parse(value).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async appendAssistantExchange(userContent: string, leaderContent: string, state: LeaderState["status"]) {
    const current = await this.assistantMessages(), createdAt = now(), suffix = randomUUID();
    const messages = assistantMessageSchema.array().parse([
      ...current,
      { id: `user-${suffix}`, role: "user", content: userContent, state, createdAt },
      { id: `leader-${suffix}`, role: "leader", content: leaderContent, state, createdAt }
    ]);
    await write(this.file("assistant/history.json"), messages.slice(-100));
    await this.event("assistant-exchange", { state, userMessageId: `user-${suffix}`, leaderMessageId: `leader-${suffix}` });
    return messages.slice(-100);
  }

  async modelUsage(): Promise<ModelUsage[]> {
    const value = await json(this.file("usage/model-calls.json"));
    return value ? modelUsageSchema.array().parse(value).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : [];
  }

  async recordModelUsage(value: Omit<ModelUsage, "id" | "createdAt">) {
    const current = await this.modelUsage();
    const record = modelUsageSchema.parse({ ...value, id: `model-${randomUUID()}`, createdAt: now() });
    await write(this.file("usage/model-calls.json"), [...current, record].slice(-1_000));
    await this.event("model-usage", { operation: record.operation, model: record.model, totalTokens: record.totalTokens, estimatedCostUsd: record.estimatedCostUsd });
    return record;
  }

  async saveEnvironment(value: ProjectEnvironmentFacts) {
    const facts = projectEnvironmentFactsSchema.parse(value);
    const history = this.file(`environment/facts-v${facts.revision}.json`);
    await writeVersioned(this.file("environment/current.json"), history, facts, `Environment facts v${facts.revision}`);
    await this.event("environment-facts", { revision: facts.revision, status: facts.status });
  }

  async saveTask(value: TaskSpec) {
    const task = taskSpecSchema.parse(value);
    const history = this.file(`task/task-spec-v${task.version}.json`);
    await writeVersioned(this.file("task/task-spec.json"), history, task, `TaskSpec v${task.version}`);
    await this.event("task-spec", { version: task.version });
  }

  async saveDecision(value: ArchitectureDecision) {
    const decision = architectureDecisionSchema.parse(value);
    const target = this.file(`architecture/decisions/${decision.id}-v${decision.version}.json`);
    if (await json(target)) throw new Error(`ArchitectureDecision ${decision.id} v${decision.version} 已存在，不能重写历史。`);
    await write(target, decision);
    await this.event("architecture-decision", { id: decision.id, version: decision.version });
  }

  async savePlan(value: WorkPlan) {
    const plan = workPlanSchema.parse(value);
    const history = this.file(`plan/plan-v${plan.version}.json`);
    await writeVersioned(this.file("plan/plan.json"), history, plan, `WorkPlan v${plan.version}`);
    await this.event("plan", { version: plan.version });
  }

  async nextPlanVersion() {
    const files = await readdir(this.file("plan"));
    const versions = files.map((file) => Number(file.match(/^plan-v(\d+)\.json$/)?.[1] ?? 0));
    return Math.max(0, ...versions) + 1;
  }

  async savePlanPatch(value: unknown) {
    const patch = planPatchSchema.parse(value);
    const target = this.file(`plan/patches/${patch.id}.json`);
    if (await json(target)) throw new Error(`PlanPatch ${patch.id} 已存在，不能重写历史。`);
    await write(target, patch);
    await this.event("plan-patch", { id: patch.id, target: patch.targetPlanVersion });
  }

  async planPatches() {
    const files = await readdir(this.file("plan/patches"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("plan/patches", file))));
    return values.filter((value): value is object => value !== null).map((value) => planPatchSchema.parse(value)).sort((a, b) => a.targetPlanVersion - b.targetPlanVersion);
  }

  async installSkill(value: SkillManifest) {
    const skill = skillManifestSchema.parse(value);
    const target = this.file(`skills/${skill.id}-v${skill.version}.json`);
    if (await json(target)) return;
    await write(target, skill);
    await this.event("skill-installed", { id: skill.id, version: skill.version });
  }

  async saveLeaderAnalysis(value: LeaderAnalysis) {
    const analysis = leaderAnalysisSchema.parse(value);
    const id = "analysis-" + Date.now();
    await write(this.file(`learning/${id}.json`), analysis);
    await this.event("leader-analysis", { id });
  }

  async latestLeaderAnalysis(): Promise<LeaderAnalysis | null> {
    const files = await readdir(this.file("learning"));
    const candidates = files.filter((file) => /^analysis-\d+\.json$/.test(file)).sort();
    const value = candidates.length ? await json(this.file("learning", candidates.at(-1)!)) : null;
    return value ? leaderAnalysisSchema.parse(value) : null;
  }

  async learningProfile(): Promise<LearningProfile | null> { const value = await json(this.file("learning/profile.json")); return value ? learningProfileSchema.parse(value) : null; }
  async saveLearningProfile(value: LearningProfile) {
    const profile = learningProfileSchema.parse(value);
    const history = this.file(`learning/profile-v${profile.revision}.json`);
    await writeVersioned(this.file("learning/profile.json"), history, profile, `Learning profile v${profile.revision}`);
    await this.event("learning-profile", { revision: profile.revision });
  }

  async handoff(stepId: string, version: number): Promise<Handoff | null> {
    const value = await json(this.file(`handoffs/${stepId}-v${version}.json`));
    return value ? handoffSchema.parse(value) : null;
  }

  async nextHandoffVersion(stepId: string): Promise<number> {
    const files = await readdir(this.file("handoffs"));
    const versions = files
      .map((file) => file.match(new RegExp(`^${escapeRegExp(stepId)}-v(\\d+)\\.json$`))?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number);
    return (versions.length ? Math.max(...versions) : 0) + 1;
  }

  async latestHandoff(stepId: string): Promise<Handoff | null> {
    const version = await this.nextHandoffVersion(stepId) - 1;
    return version > 0 ? this.handoff(stepId, version) : null;
  }

  async saveHandoff(value: Handoff) {
    const handoff = handoffSchema.parse(value);
    const target = this.file(`handoffs/${handoff.stepId}-v${handoff.version}.json`);
    if (await json(target)) throw new Error(`Handoff ${handoff.stepId} v${handoff.version} 已存在，不能重写历史。`);
    await write(target, handoff);
    await writeFile(this.file(`handoffs/${handoff.stepId}-v${handoff.version}.md`), handoff.content, "utf8");
    await this.event("handoff", { stepId: handoff.stepId, version: handoff.version });
  }

  async saveReport(value: ExecutionReport) {
    const report = executionReportSchema.parse(value);
    const target = this.file(`agent-reports/${report.reportId}.json`);
    const existing = await json(target);
    if (existing && JSON.stringify(executionReportSchema.parse(existing)) !== JSON.stringify(report)) throw new Error(`ExecutionReport ${report.reportId} 已存在，不能重写历史。`);
    if (!existing) await write(target, report);
    await this.event("execution-report", { id: report.reportId });
  }

  async report(id: string): Promise<ExecutionReport | null> {
    const value = await json(this.file(`agent-reports/${id}.json`));
    return value ? executionReportSchema.parse(value) : null;
  }

  async reports(stepId?: string): Promise<ExecutionReport[]> {
    const files = await readdir(this.file("agent-reports"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("agent-reports", file))));
    return values.filter((value): value is object => value !== null).map((value) => executionReportSchema.parse(value)).filter((value) => !stepId || value.stepId === stepId).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  }

  async verificationRuns(stepId?: string): Promise<VerificationRun[]> {
    const files = await readdir(this.file("verifications"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("verifications", file))));
    return values.filter((value): value is object => value !== null).map((value) => verificationRunSchema.parse(value)).filter((value) => !stepId || value.stepId === stepId).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  async saveReview(value: ReviewReport) {
    const review = reviewReportSchema.parse(value);
    const target = this.file(`reviews/${review.id}.json`);
    if (await json(target)) throw new Error(`Review ${review.id} 已存在，不能重写历史。`);
    await write(target, review);
    await this.event("review", { id: review.id, decision: review.decision });
  }

  async reviews(stepId?: string): Promise<ReviewReport[]> {
    const files = await readdir(this.file("reviews"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("reviews", file))));
    return values.filter((value): value is object => value !== null).map((value) => reviewReportSchema.parse(value)).filter((value) => !stepId || value.stepId === stepId).sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
  }

  async latestReview(stepId: string): Promise<ReviewReport | null> { return (await this.reviews(stepId)).at(-1) ?? null; }

  async saveCorrection(value: unknown) {
    const patch = correctionPatchSchema.parse(value);
    const target = this.file(`corrections/${patch.id}.json`);
    if (await json(target)) throw new Error(`CorrectionPatch ${patch.id} 已存在，不能重写历史。`);
    await write(target, patch);
    await this.event("correction", { id: patch.id });
  }

  async latestCorrection(stepId: string): Promise<CorrectionPatch | null> {
    const files = await readdir(this.file("corrections"));
    const candidates = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
      const value = await json(this.file("corrections", file));
      return value ? correctionPatchSchema.safeParse(value) : null;
    }));
    return candidates
      .filter((candidate): candidate is { success: true; data: CorrectionPatch } => Boolean(candidate?.success))
      .map((candidate) => candidate.data)
      .filter((patch) => patch.stepId === stepId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  }

  async saveBaseline(value: WorkspaceBaseline) {
    const baseline = workspaceBaselineSchema.parse(value);
    const target = this.file(`baselines/${baseline.stepId}-v${baseline.handoffVersion}.json`);
    if (await json(target)) throw new Error(`WorkspaceBaseline ${baseline.stepId} v${baseline.handoffVersion} 已存在，不能重写历史。`);
    await write(target, baseline);
    await this.event("workspace-baseline", { stepId: baseline.stepId, handoffVersion: baseline.handoffVersion });
  }

  async baseline(stepId: string, handoffVersion: number): Promise<WorkspaceBaseline | null> {
    const value = await json(this.file(`baselines/${stepId}-v${handoffVersion}.json`));
    return value ? workspaceBaselineSchema.parse(value) : null;
  }

  async saveUserDecision(value: UserDecisionRequest) {
    const decision = userDecisionRequestSchema.parse(value);
    const target = this.file(`decisions/${decision.id}.json`);
    const current = await json(target);
    if (current && (current as { status?: string }).status === "resolved") throw new Error(`用户决策 ${decision.id} 已解决，不能重写。`);
    await write(target, decision);
    await this.event("user-decision", { id: decision.id, status: decision.status, resolution: decision.resolution });
  }

  async userDecision(id: string): Promise<UserDecisionRequest | null> {
    const value = await json(this.file(`decisions/${id}.json`));
    return value ? userDecisionRequestSchema.parse(value) : null;
  }

  async pendingDecisions(): Promise<UserDecisionRequest[]> {
    const files = await readdir(this.file("decisions"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("decisions", file))));
    return values.filter((value): value is object => value !== null).map((value) => userDecisionRequestSchema.parse(value)).filter((value) => value.status === "pending");
  }

  async competitionDebugSessions(): Promise<CompetitionDebugSession[]> {
    const files = await readdir(this.file("competition/debug"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("competition/debug", file))));
    return values.filter((value): value is object => value !== null).map((value) => competitionDebugSessionSchema.parse(value)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async saveCompetitionDebugSession(value: CompetitionDebugSession) {
    const session = competitionDebugSessionSchema.parse(value), target = this.file(`competition/debug/${session.id}.json`), current = await json(target);
    if (current && competitionDebugSessionSchema.parse(current).status === "resolved") throw new Error("已解决的调试会话不能重写。");
    await write(target, session); await this.event("competition-debug", { id: session.id, category: session.category, status: session.status }); return session;
  }
  async competitionMetricRecords(): Promise<CompetitionMetricRecord[]> {
    const files = await readdir(this.file("competition/metrics"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("competition/metrics", file))));
    return values.filter((value): value is object => value !== null).map((value) => competitionMetricRecordSchema.parse(value)).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
  async saveCompetitionMetricRecord(value: CompetitionMetricRecord) {
    const record = competitionMetricRecordSchema.parse(value), target = this.file(`competition/metrics/${record.id}.json`);
    if (await json(target)) throw new Error("该跑分记录已经存在，不能覆盖。");
    await write(target, record); await this.event("competition-metric", { metricId: record.metricId, value: record.value, unit: record.unit }); return record;
  }
  async competitionDefenseSessions(): Promise<CompetitionDefenseSession[]> {
    const files = await readdir(this.file("competition/defense"));
    const values = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => json(this.file("competition/defense", file))));
    return values.filter((value): value is object => value !== null).map((value) => competitionDefenseSessionSchema.parse(value)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async saveCompetitionDefenseSession(value: CompetitionDefenseSession) {
    const session = competitionDefenseSessionSchema.parse(value), target = this.file(`competition/defense/${session.id}.json`);
    if (await json(target)) throw new Error("该答辩会话已经存在，不能覆盖。");
    await write(target, session); await this.event("competition-defense", { id: session.id, questions: session.questions.length }); return session;
  }

  static hash = hash;
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
