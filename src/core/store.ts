import path from "node:path";
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  architectureDecisionSchema,
  correctionPatchSchema,
  executionReportSchema,
  handoffSchema,
  leaderAnalysisSchema,
  learningProfileSchema,
  projectEnvironmentFactsSchema,
  planPatchSchema,
  reviewReportSchema,
  skillManifestSchema,
  stateSchema,
  taskSpecSchema,
  workPlanSchema,
  type ArchitectureDecision,
  type CorrectionPatch,
  type ExecutionReport,
  type Handoff,
  type ProjectEnvironmentFacts,
  type LeaderState,
  type LeaderAnalysis,
  type LearningProfile,
  type ReviewReport,
  type SkillManifest,
  type TaskSpec,
  type WorkPlan
} from "./schemas.js";

const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function json(target: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(target, "utf8")); } catch { return null; }
}

async function write(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export class LeaderStore {
  readonly dir: string;

  constructor(root: string) { this.dir = path.join(path.resolve(root), ".codegate"); }
  file(...parts: string[]) { return path.join(this.dir, ...parts); }

  async init() {
    for (const part of ["task/sources", "architecture/decisions", "plan/patches", "skills", "handoffs", "agent-reports/attachments", "reviews", "corrections", "learning", "environment", "protocols"]) {
      await mkdir(this.file(part), { recursive: true });
    }
    if (!await json(this.file("state.json"))) {
      await write(this.file("state.json"), {
        schemaVersion: 1, status: "new", taskId: null, taskSpecVersion: null,
        workPlanVersion: null, currentStepId: null, updatedAt: now()
      });
    }
  }

  async state(): Promise<LeaderState> { await this.init(); return stateSchema.parse(await json(this.file("state.json"))); }
  async setState(next: LeaderState) { await write(this.file("state.json"), stateSchema.parse(next)); await this.event("state", { status: next.status }); }
  async event(type: string, data: unknown) { await mkdir(this.dir, { recursive: true }); await appendFile(this.file("events.jsonl"), `${JSON.stringify({ id: randomUUID(), type, at: now(), data })}\n`); }

  async task(): Promise<TaskSpec | null> { const value = await json(this.file("task/task-spec.json")); return value ? taskSpecSchema.parse(value) : null; }
  async plan(): Promise<WorkPlan | null> { const value = await json(this.file("plan/plan.json")); return value ? workPlanSchema.parse(value) : null; }
  async environment(): Promise<ProjectEnvironmentFacts | null> { const value = await json(this.file("environment/current.json")); return value ? projectEnvironmentFactsSchema.parse(value) : null; }

  async saveEnvironment(value: ProjectEnvironmentFacts) {
    const facts = projectEnvironmentFactsSchema.parse(value);
    const history = this.file(`environment/facts-v${facts.revision}.json`);
    if (await json(history)) throw new Error(`Environment facts v${facts.revision} 已存在，不能重写历史。`);
    await write(this.file("environment/current.json"), facts);
    await write(history, facts);
    await this.event("environment-facts", { revision: facts.revision, status: facts.status });
  }

  async saveTask(value: TaskSpec) {
    const task = taskSpecSchema.parse(value);
    const history = this.file(`task/task-spec-v${task.version}.json`);
    if (await json(history)) throw new Error(`TaskSpec v${task.version} 已存在，不能重写历史。`);
    await write(this.file("task/task-spec.json"), task);
    await write(history, task);
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
    if (await json(history)) throw new Error(`WorkPlan v${plan.version} 已存在，不能重写历史。`);
    await write(this.file("plan/plan.json"), plan);
    await write(history, plan);
    await this.event("plan", { version: plan.version });
  }

  async savePlanPatch(value: unknown) {
    const patch = planPatchSchema.parse(value);
    const target = this.file(`plan/patches/${patch.id}.json`);
    if (await json(target)) throw new Error(`PlanPatch ${patch.id} 已存在，不能重写历史。`);
    await write(target, patch);
    await this.event("plan-patch", { id: patch.id, target: patch.targetPlanVersion });
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

  async learningProfile(): Promise<LearningProfile | null> { const value = await json(this.file("learning/profile.json")); return value ? learningProfileSchema.parse(value) : null; }
  async saveLearningProfile(value: LearningProfile) {
    const profile = learningProfileSchema.parse(value);
    const history = this.file(`learning/profile-v${profile.revision}.json`);
    if (await json(history)) throw new Error(`Learning profile v${profile.revision} 已存在，不能重写历史。`);
    await write(this.file("learning/profile.json"), profile); await write(history, profile);
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
    if (await json(target)) throw new Error(`ExecutionReport ${report.reportId} 已存在，不能重写历史。`);
    await write(target, report);
    await this.event("execution-report", { id: report.reportId });
  }

  async saveReview(value: ReviewReport) {
    const review = reviewReportSchema.parse(value);
    const target = this.file(`reviews/${review.id}.json`);
    if (await json(target)) throw new Error(`Review ${review.id} 已存在，不能重写历史。`);
    await write(target, review);
    await this.event("review", { id: review.id, decision: review.decision });
  }

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

  static hash = hash;
}

function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
