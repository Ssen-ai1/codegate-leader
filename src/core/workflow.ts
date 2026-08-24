import { readFile } from "node:fs/promises";
import path from "node:path";
import { LeaderStore } from "./store.js";
import { builtInSkills, SkillRegistry } from "./skills.js";
import { extractMaterial, extractRubricLines } from "./source-material.js";
import { LeaderModelClient } from "./leader-model.js";
import type { CorrectionPatch, ExecutionReport, Handoff, LearningProfile, ProjectEnvironmentFacts, ReviewReport, TaskSpec, WorkPlan } from "./schemas.js";

const now = () => new Date().toISOString();
const source = (id: string, locator: string, content: string) => ({ sourceId: id, sourceType: "workspace-file" as const, locator, contentHash: LeaderStore.hash(content) });

export class LeaderWorkflow {
  constructor(readonly root: string, readonly store = new LeaderStore(root)) {}
  async init() { await this.store.init(); await Promise.all(builtInSkills.map((skill) => this.store.installSkill(skill))); }

  async intake(taskFile: string) {
    await this.init();
    const state = await this.store.state();
    if (state.status !== "new") throw new Error("已有任务；请在新工作区开始，或先审查现有 .codegate 状态。");
    const absolute = path.resolve(this.root, taskFile);
    if (!this.isInsideRoot(absolute)) throw new Error("任务资料必须位于目标工作区内。");
    const material = await extractMaterial(absolute);
    const content = material.text;
    const pointer = { ...source("task-file", taskFile.replaceAll("\\", "/"), content), sourceType: material.sourceType };
    const rubricItems = extractRubricLines(content).map((description, index) => ({ id: "rubric-" + (index + 1), description, mappedRequirementIds: ["req-primary"], mappedDeliverableIds: ["del-primary"], mappedStepIds: [], status: "unmapped" as const, sourcePointers: [pointer] }));
    const task: TaskSpec = {
      id: "task-" + Date.now(), version: 1, title: path.basename(taskFile), objective: content.trim().slice(0, 4000),
      deliverables: [{ id: "del-primary", description: "完成用户在任务资料中确认的主要交付物。", required: true, sourcePointers: [pointer] }],
      requirements: [{ id: "req-primary", description: "保留并实现任务资料中的已确认要求。", priority: "must", sourcePointers: [pointer] }],
      constraints: [{ id: "constraint-leader", description: "CodeGate 不直接生成业务代码或控制 Coding Agent。", hard: true, sourcePointers: [pointer] }],
      nonGoals: ["自动控制 Coding Agent", "语言专用 AST/LSP", "未授权外部操作"], assumptions: [], openQuestions: [],
      acceptanceCriteria: [{ id: "ac-primary", title: "主要交付物已验证", description: "执行报告、Git Diff 和验证结果能够共同支持交付。", required: true, verificationMethod: "artifact-review", expectedEvidence: ["ExecutionReport", "Git Diff", "verification log"], sourcePointers: [pointer] }],
      rubricItems, sourceMaterialIds: ["task-file"], createdAt: now(), updatedAt: now()
    };
    await this.store.saveTask(task);
    await this.store.setState({ schemaVersion: 1, status: "intake", taskId: task.id, taskSpecVersion: 1, workPlanVersion: null, currentStepId: null, updatedAt: now() });
    return task;
  }

  async approveTask() {
    const [task, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("当前没有待审批的 TaskSpec。");
    if (task.openQuestions.some((item) => item.blocking && item.answer === null)) {
      await this.store.setState({ ...state, status: "clarification-required", updatedAt: now() });
      throw new Error("存在未回答的阻塞问题；不能批准 TaskSpec。");
    }
    await this.store.setState({ ...state, status: "task-spec-ready", updatedAt: now() });
  }

  async clarify(questionId: string, answer: string) {
    const [task, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("当前 TaskSpec 不接受澄清。");
    const question = task.openQuestions.find((item) => item.id === questionId);
    if (!question) throw new Error("未找到该澄清问题。");
    if (question.answer !== null) throw new Error("该澄清问题已回答；请通过 TaskSpec 修订改变结论。");
    const revised: TaskSpec = {
      ...task,
      version: task.version + 1,
      openQuestions: task.openQuestions.map((item) => item.id === questionId ? { ...item, answer } : item),
      updatedAt: now()
    };
    await this.store.saveTask(revised);
    await this.store.setState({ ...state, status: "intake", taskSpecVersion: revised.version, updatedAt: now() });
    return revised;
  }

  async analyzeWithLeader(userMessage = "") {
    const [task, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("只能在 TaskSpec 批准前运行 Leader 分析。");
    const analysis = await new LeaderModelClient().analyze(task.objective, userMessage);
    const revised: TaskSpec = {
      ...task, version: task.version + 1,
      assumptions: [...task.assumptions, ...analysis.assumptions.map((description, index) => ({ id: "model-assumption-" + (task.assumptions.length + index + 1), description, status: "unconfirmed" as const }))],
      openQuestions: [...task.openQuestions, ...analysis.questions.map((item, index) => ({ id: "model-question-" + (task.openQuestions.length + index + 1), ...item, answer: null }))],
      updatedAt: now()
    };
    await this.store.saveTask(revised);
    await this.store.saveLeaderAnalysis(analysis);
    await this.store.setState({ ...state, status: revised.openQuestions.some((item) => item.blocking && item.answer === null) ? "clarification-required" : "intake", taskSpecVersion: revised.version, updatedAt: now() });
    return analysis;
  }

  async setLearningProfile(input: Omit<LearningProfile, "revision" | "updatedAt">) {
    const current = await this.store.learningProfile();
    const profile: LearningProfile = { ...input, revision: (current?.revision ?? 0) + 1, updatedAt: now() };
    await this.store.saveLearningProfile(profile);
    return profile;
  }

  async askMentor(question: string) {
    const [task, plan, state, profile] = await Promise.all([this.requireTask(), this.requirePlan(), this.store.state(), this.store.learningProfile()]);
    const step = plan.steps.find((item) => item.id === state.currentStepId) ?? plan.steps[0]!;
    const answer = await new LeaderModelClient().mentor("Task: " + task.objective + "\nStep: " + step.title + "\nRationale: " + step.rationale, question, profile);
    await this.store.event("mentor-question", { stepId: step.id, question });
    return answer;
  }

  async updateTask(task: TaskSpec) {
    const [current, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("TaskSpec 只能在批准前修订。");
    if (task.id !== current.id || task.version !== current.version + 1) throw new Error("TaskSpec 修订必须保持 ID，并将版本递增 1。");
    if (task.createdAt !== current.createdAt) throw new Error("TaskSpec 修订不能改变创建时间。");
    await this.store.saveTask({ ...task, updatedAt: now() });
    await this.store.setState({ ...state, status: "intake", taskSpecVersion: task.version, updatedAt: now() });
  }

  async architecture(title: string, decision: string) {
    const task = await this.requireTask(), state = await this.store.state();
    if (state.status !== "task-spec-ready" && state.status !== "architecture-review") throw new Error("需先完成 TaskSpec。");
    await this.store.saveDecision({ id: "adr-" + Date.now(), version: 1, title, status: "accepted", context: task.objective, decision, alternatives: [], consequences: [], affectedStepIds: [], sourcePointers: task.requirements[0]!.sourcePointers, createdAt: now() });
    await this.store.setState({ ...state, status: "architecture-review", updatedAt: now() });
  }

  async createPlan() {
    const task = await this.requireTask(), state = await this.store.state();
    if (state.status !== "architecture-review") throw new Error("需先完成架构审查。");
    const requirementIds = task.requirements.map((item) => item.id);
    const deliverableIds = task.deliverables.map((item) => item.id);
    const acceptanceIds = task.acceptanceCriteria.map((item) => item.id);
    const rubricItemIds = task.rubricItems.map((item) => item.id);
    const steps = [
      { id: "step-001", title: "探索工作区与落实架构", objective: "确认环境事实、模块边界和验证路径。", rationale: "避免对未知仓库做实现假设。", dependencyStepIds: [], requirementIds: [], deliverableIds: [], acceptanceIds: [], rubricItemIds: [], architectureDecisionIds: [], recommendedSkillIds: ["architecture-design", "implementation-handoff"], expectedInputs: ["TaskSpec"], expectedOutputs: ["环境事实与实现边界"], verificationInstructions: ["记录实际发现的构建和测试命令"], stopConditions: ["发现会改变架构或范围的事实时停止"], status: "ready" as const },
      { id: "step-002", title: "执行经批准的实现", objective: "由 Coding Agent 在既定边界内实现当前交付物。", rationale: "执行层保持与 Leader 解耦。", dependencyStepIds: ["step-001"], requirementIds, deliverableIds, acceptanceIds: [], rubricItemIds, architectureDecisionIds: [], recommendedSkillIds: ["implementation-handoff", "test-strategy"], expectedInputs: ["已接受的环境事实"], expectedOutputs: ["实现 Diff 和测试结果"], verificationInstructions: ["运行相关验证"], stopConditions: ["需求、架构或范围发生改变时停止"], status: "pending" as const },
      { id: "step-003", title: "验收与交付审查", objective: "交叉检查结果、证据和评分覆盖。", rationale: "完成声明不能替代独立验收。", dependencyStepIds: ["step-002"], requirementIds: [], deliverableIds: [], acceptanceIds, rubricItemIds, architectureDecisionIds: [], recommendedSkillIds: ["code-and-result-review"], expectedInputs: ["ExecutionReport、Diff、日志"], expectedOutputs: ["ReviewReport"], verificationInstructions: ["审查所有验收证据"], stopConditions: ["证据不足时生成纠偏"], status: "pending" as const }
    ];
    const plan: WorkPlan = { id: "plan-" + task.id, version: 1, taskSpecVersion: task.version, summary: "先确认事实，再交接执行，最后独立审查。", stepIds: steps.map((step) => step.id), status: "draft", steps, risks: ["未确认的环境事实", "执行报告与实际 Diff 不一致"], createdAt: now(), updatedAt: now() };
    await this.store.savePlan(plan);
    return plan;
  }

  async approvePlan() {
    const [plan, state] = await Promise.all([this.requirePlan(), this.store.state()]);
    if (state.status !== "architecture-review" || plan.status !== "draft") throw new Error("当前没有待审批的 Plan。");
    this.assertPlanValid(await this.requireTask(), plan);
    const approved: WorkPlan = { ...plan, version: plan.version + 1, status: "approved", updatedAt: now() };
    await this.store.savePlan(approved);
    await this.store.setState({ ...state, status: "step-ready", workPlanVersion: approved.version, currentStepId: approved.steps.find((item) => item.status === "ready")?.id ?? null, updatedAt: now() });
  }

  async handoff(agent: Handoff["agentAdapter"]) { return this.createHandoff(agent); }

  async ingest(report: ExecutionReport) {
    const [state, plan] = await Promise.all([this.store.state(), this.requirePlan()]);
    if (state.status !== "handed-off" || state.currentStepId !== report.stepId) throw new Error("报告不对应当前交接步骤。");
    if (!await this.store.handoff(report.stepId, report.handoffVersion)) throw new Error("报告引用的 Handoff 不存在；不能接受未交接的执行结果。");
    if (this.currentStep(plan, report.stepId).status !== "handed-off") throw new Error("当前步骤未处于已交接状态。");
    await this.store.saveReport(report);
    if (report.environmentFacts) {
      const current = await this.store.environment();
      const facts: ProjectEnvironmentFacts = { ...report.environmentFacts, revision: (current?.revision ?? 0) + 1, status: "pending-confirmation" };
      await this.store.saveEnvironment(facts);
    }
    const nextPlan = this.withStep(plan, report.stepId, "reported", "executing");
    await this.store.savePlan(nextPlan);
    await this.store.setState({ ...state, status: "result-reported", workPlanVersion: nextPlan.version, updatedAt: now() });
  }

  async confirmEnvironment() {
    const facts = await this.store.environment();
    if (!facts) throw new Error("尚无待确认的环境事实。");
    if (facts.status !== "pending-confirmation") throw new Error("当前环境事实不处于待确认状态。");
    await this.store.saveEnvironment({ ...facts, revision: facts.revision + 1, status: "confirmed" });
  }

  async review(report: ExecutionReport): Promise<ReviewReport> {
    const [task, plan, state, environment] = await Promise.all([this.requireTask(), this.requirePlan(), this.store.state(), this.store.environment()]);
    if (state.status !== "result-reported" || state.currentStepId !== report.stepId) throw new Error("需先导入当前步骤的执行报告。");
    if (this.currentStep(plan, report.stepId).status !== "reported") throw new Error("当前步骤未处于已报告状态。");
    const claimed = new Set(report.filesChanged.map(this.normalizePath)), actual = await this.gitChangedFiles();
    const missing = [...claimed].filter((file) => !actual.has(file)), extra = [...actual].filter((file) => !claimed.has(file));
    const passed = report.status === "completed" && report.commandsRun.some((command) => command.status === "passed" && command.exitCode === 0);
    const coverage = task.acceptanceCriteria.map((criterion) => ({ id: criterion.id, status: passed && !missing.length && !extra.length ? "covered" as const : "unverified" as const, evidence: passed ? ["ExecutionReport command result", "Git Diff", "command log attachment"] : [], explanation: passed && !missing.length && !extra.length ? "命令日志、报告和实际 Diff 相互一致。" : "没有足够交叉证据；报告完成声明不足以验收。" }));
    const driftFindings = [
      ...(missing.length ? [{ type: "report-mismatch" as const, description: "报告声称的文件未出现在 Git Diff：" + missing.join(", ") + "。", evidence: ["Git Diff", "report:" + report.reportId] }] : []),
      ...(extra.length ? [{ type: "scope-expansion" as const, description: "Git Diff 含未在报告声明的变更：" + extra.join(", ") + "。", evidence: ["Git Diff", "report:" + report.reportId] }] : []),
      ...(report.deviations.length ? [{ type: "goal-drift" as const, description: "Agent 报告了偏离 Handoff 的执行。", evidence: ["report:" + report.reportId] }] : []),
      ...(!passed ? [{ type: "verification-gap" as const, description: "没有可用的成功验证命令与日志证据。", evidence: ["report:" + report.reportId] }] : [])
    ];
    const decision = driftFindings.some((item) => item.type !== "verification-gap") ? "user-decision-required" as const : coverage.every((item) => item.status === "covered") ? "accepted" as const : "revision-required" as const;
    const correctionId = decision === "revision-required" ? "correction-" + Date.now() : undefined;
    const review: ReviewReport = { id: "review-" + Date.now(), stepId: report.stepId, decision, summary: decision === "accepted" ? "证据支持当前步骤验收。" : "当前步骤未被接受。", acceptanceCoverage: coverage, driftFindings, unresolvedItems: coverage.filter((item) => item.status !== "covered").map((item) => item.id), ...(correctionId ? { correctionPatchId: correctionId } : {}), generatedAt: now() };
    await this.store.saveReview(review);
    if (decision === "accepted") {
      const steps = plan.steps.map((item) => item.id === report.stepId ? { ...item, status: "accepted" as const } : item);
      const next = steps.find((item) => item.status === "pending" && item.dependencyStepIds.every((dependency) => steps.find((candidate) => candidate.id === dependency)?.status === "accepted"));
      if (next) next.status = "ready";
      const nextPlan: WorkPlan = { ...plan, version: plan.version + 1, status: steps.every((item) => item.status === "accepted") ? "completed" : "executing", steps, updatedAt: now() };
      await this.store.savePlan(nextPlan);
      await this.store.setState({ ...state, status: next ? "step-ready" : "task-completed", workPlanVersion: nextPlan.version, currentStepId: next?.id ?? null, updatedAt: now() });
    } else if (decision === "revision-required") {
      const nextPlan = this.withStep(plan, report.stepId, "revision-required", "executing");
      await this.store.savePlan(nextPlan);
      await this.store.saveCorrection({ id: correctionId!, stepId: report.stepId, reviewId: review.id, diagnosis: review.summary, mustPreserve: ["已批准 TaskSpec 和架构决策"], mustChange: ["补充可交叉验证的证据"], mustNotChange: task.nonGoals, additionalVerification: ["运行并附上实际命令日志"], requiresUserDecision: false, createdAt: now() });
      await this.store.setState({ ...state, status: "correction-ready", workPlanVersion: nextPlan.version, updatedAt: now() });
    } else await this.store.setState({ ...state, status: "user-decision-required", updatedAt: now() });
    return review;
  }

  async correct(agent: Handoff["agentAdapter"]) {
    const state = await this.store.state();
    if (state.status !== "correction-ready" || !state.currentStepId) throw new Error("当前没有待执行的 CorrectionPatch。");
    const correction = await this.store.latestCorrection(state.currentStepId);
    if (!correction) throw new Error("缺少当前步骤的 CorrectionPatch。");
    return (await this.createHandoff(agent, correction)).content;
  }

  async approvePlanWithPatch() {
    const before = await this.requirePlan(); await this.approvePlan(); const after = await this.requirePlan();
    await this.store.savePlanPatch({ id: "plan-approval-v" + after.version, basePlanVersion: before.version, targetPlanVersion: after.version, reason: "User approved the WorkPlan.", triggeredBy: "user", operations: [{ type: "set-step-status", stepId: "step-001", description: "Make the first dependency-ready step available." }], affectedStepIds: ["step-001"], requiresUserApproval: false, createdAt: now() });
  }
  async reviewWithPatch(report: ExecutionReport) {
    const before = await this.requirePlan(), review = await this.review(report), after = await this.requirePlan();
    if (after.version !== before.version) await this.store.savePlanPatch({ id: "review-" + review.id + "-plan-patch", basePlanVersion: before.version, targetPlanVersion: after.version, reason: review.summary, triggeredBy: "review", operations: [{ type: "set-step-status", stepId: report.stepId, description: "Apply review decision " + review.decision + "." }], affectedStepIds: [report.stepId], requiresUserApproval: false, createdAt: now() });
    return review;
  }
  async reviewWithEvidence(report: ExecutionReport) {
    const commandsRun = await Promise.all(report.commandsRun.map(async (command) => {
      if (command.status !== "passed" || !command.outputArtifact) return command.status === "passed" ? { ...command, status: "failed" as const, exitCode: 1 } : command;
      const target = path.resolve(this.root, command.outputArtifact);
      if (!this.isInsideRoot(target)) return { ...command, status: "failed" as const, exitCode: 1 };
      try { return (await readFile(target, "utf8")).trim() ? command : { ...command, status: "failed" as const, exitCode: 1 }; } catch { return { ...command, status: "failed" as const, exitCode: 1 }; }
    }));
    return this.reviewWithPatch({ ...report, commandsRun });
  }
  async explain() {
    const [task, plan, state, environment] = await Promise.all([this.requireTask(), this.requirePlan(), this.store.state(), this.store.environment()]);
    const step = plan.steps.find((item) => item.id === state.currentStepId) ?? plan.steps[0]!;
    return ["# Mentor Brief", "", "本步骤：" + step.title, "", "它服务于：" + task.objective, "", "为什么：" + step.rationale, "", "如何验证：", "- " + step.verificationInstructions.join("\n- "), "", "常见误区：Agent 报告“完成”只是声明；应查看 Diff、命令日志和独立 Review。"].join("\n");
  }

  private async createHandoff(agent: Handoff["agentAdapter"], correction?: CorrectionPatch): Promise<Handoff> {
    const [task, plan, state, environment] = await Promise.all([this.requireTask(), this.requirePlan(), this.store.state(), this.store.environment()]);
    if ((state.status !== "step-ready" && state.status !== "correction-ready") || !state.currentStepId) throw new Error("当前没有可交接步骤。");
    const step = this.currentStep(plan, state.currentStepId);
    if (step.status !== (correction ? "revision-required" : "ready")) throw new Error("当前步骤状态与交接类型不匹配。");
    const version = await this.store.nextHandoffVersion(step.id), requirements = task.requirements.filter((item) => step.requirementIds.includes(item.id));
    const skills = new SkillRegistry().select(step.recommendedSkillIds);
    const adapterInstructions = agent === "codex"
      ? "在当前工作区执行。先读取本 Handoff 和相关 .codegate 工件；不要编辑 TaskSpec、Plan 或 Review。"
      : agent === "claude-code"
        ? "在当前工作目录工作。遵守本 Handoff 的范围；完成后按报告契约写入工件，不要改变 Leader 工件。"
        : "将本 Handoff 作为中立执行协议；在目标工作区完成当前步骤并提交结构化报告。";
    const skillMethod = skills.flatMap((skill) => [
      "### " + skill.name + " (" + skill.id + ")",
      "适用理由：" + skill.description,
      ...skill.procedure.map((procedure) => "- " + procedure.instruction + " 输出：" + procedure.output),
      "质量门槛：" + skill.qualityGates.join("；")
    ]).join("\n");
    if (step.id === "step-002" && environment?.status !== "confirmed") throw new Error("执行实现前必须确认探索步骤报告的环境事实。");
    const environmentSection = environment ? ["", "## Known Environment Facts", "状态：" + environment.status, "语言：" + (environment.languages.join(", ") || "Unknown"), "框架：" + (environment.frameworks.join(", ") || "Unknown"), "构建命令：" + (environment.buildCommands.join("；") || "Unknown"), "测试命令：" + (environment.testCommands.join("；") || "Unknown"), "未知项：" + (environment.unknowns.join("；") || "无")] : [];
    const content = [
      "# CodeGate Handoff: " + step.id + " v" + version, "", "## Agent Adapter\n" + agent + "\n" + adapterInstructions, "",
      "## Task Identity\n" + task.id + " / TaskSpec v" + task.version + " / Plan v" + plan.version, "",
      "## Current Step Objective\n" + step.objective, "",
      "## Relevant Requirements\n- " + requirements.map((item) => item.id + ": " + item.description).join("\n- "), "",
      "## Scope and Non-Goals\n- 只完成 " + step.id + "；不得扩大范围。\n- " + task.nonGoals.join("\n- "), "",
      "## Required Skills / Method\n" + skillMethod, "",
      ...environmentSection,
      "## Expected Outputs\n- " + step.expectedOutputs.join("\n- "), "",
      "## Verification Requirements\n- " + step.verificationInstructions.join("\n- "), "",
      "## Stop Conditions\n- " + step.stopConditions.join("\n- "),
      ...(correction ? ["", "## Correction Requirements", "- 诊断：" + correction.diagnosis, "- 必须保留：" + correction.mustPreserve.join("；"), "- 必须修改：" + correction.mustChange.join("；"), "- 不得修改：" + correction.mustNotChange.join("；"), "- 附加验证：" + correction.additionalVerification.join("；")] : []),
      "", "## Execution Report Contract", "在 .codegate/agent-reports/ 写入结构化报告，且 handoffVersion 必须为 " + version + "；为每条成功命令保存非空日志附件。报告是声明，不等于验收。"
    ].join("\n");
    const handoff: Handoff = { id: "handoff-" + step.id + "-v" + version, version, stepId: step.id, taskSpecVersion: task.version, workPlanVersion: plan.version, agentAdapter: agent, content, selectedSkillIds: step.recommendedSkillIds, inputRefs: ["task-spec:v" + task.version, "plan:v" + plan.version], createdAt: now() };
    await this.store.saveHandoff(handoff);
    const nextPlan = this.withStep(plan, step.id, "handed-off", "executing");
    await this.store.savePlan(nextPlan);
    await this.store.setState({ ...state, status: "handed-off", workPlanVersion: nextPlan.version, updatedAt: now() });
    return handoff;
  }
  private withStep(plan: WorkPlan, stepId: string, status: WorkPlan["steps"][number]["status"], planStatus: WorkPlan["status"]) { return { ...plan, version: plan.version + 1, status: planStatus, steps: plan.steps.map((item) => item.id === stepId ? { ...item, status } : item), updatedAt: now() }; }
  private assertPlanValid(task: TaskSpec, plan: WorkPlan) {
    const ids = new Set(plan.steps.map((step) => step.id));
    if (ids.size !== plan.steps.length || plan.stepIds.length !== plan.steps.length || plan.stepIds.some((id) => !ids.has(id))) throw new Error("PlanStep ID 必须唯一且与 WorkPlan.stepIds 一致。");
    for (const step of plan.steps) {
      if (step.dependencyStepIds.some((id) => id === step.id || !ids.has(id))) throw new Error("Plan 包含不存在或自引用的步骤依赖。");
      if (step.status === "ready" && step.dependencyStepIds.length) throw new Error("带依赖的步骤不能在批准时直接 Ready。");
    }
    const visit = (id: string, visiting = new Set<string>(), done = new Set<string>()): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new Error("Plan 不得包含循环依赖。");
      visiting.add(id);
      for (const dependency of this.currentStep(plan, id).dependencyStepIds) visit(dependency, visiting, done);
      visiting.delete(id); done.add(id);
    };
    for (const id of ids) visit(id);
    const mapped = (itemId: string, field: "deliverableIds" | "acceptanceIds" | "rubricItemIds") => plan.steps.some((step) => step[field].includes(itemId));
    if (task.deliverables.filter((item) => item.required).some((item) => !mapped(item.id, "deliverableIds"))) throw new Error("每个必需 Deliverable 必须映射到一个 PlanStep。");
    if (task.acceptanceCriteria.filter((item) => item.required).some((item) => !mapped(item.id, "acceptanceIds"))) throw new Error("每个必需验收项必须映射到一个 PlanStep。");
    if (task.rubricItems.filter((item) => item.score !== undefined).some((item) => !mapped(item.id, "rubricItemIds"))) throw new Error("每个有分值的 Rubric Item 必须映射到一个 PlanStep。");
  }
  private currentStep(plan: WorkPlan, stepId: string) { const step = plan.steps.find((item) => item.id === stepId); if (!step) throw new Error("当前步骤丢失。"); return step; }
  private async requireTask() { const task = await this.store.task(); if (!task) throw new Error("缺少 TaskSpec。"); return task; }
  private async requirePlan() { const plan = await this.store.plan(); if (!plan) throw new Error("缺少 WorkPlan。"); return plan; }
  private normalizePath = (value: string) => value.replaceAll("\\", "/");
  private isInsideRoot(candidate: string) { const relative = path.relative(path.resolve(this.root), candidate); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }
  private async gitChangedFiles() {
    const { execFile } = await import("node:child_process");
    const run = (args: string[]) => new Promise<string>((resolve) => {
      execFile("git", args, { cwd: this.root, windowsHide: true }, (_error, stdout) => resolve(stdout));
    });
    const [diff, status] = await Promise.all([run(["diff", "--name-only", "HEAD"]), run(["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).codegate"])]);
    const changed = diff.split(/\r?\n/).filter(Boolean);
    for (const line of status.split(/\r?\n/).filter(Boolean)) {
      const target = line.slice(3).split(" -> ").at(-1);
      if (target) changed.push(target);
    }
    return new Set(changed.map(this.normalizePath));
  }
}
