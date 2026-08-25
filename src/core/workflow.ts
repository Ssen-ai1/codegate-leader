import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { LeaderStore, type StoreTransactionEntry } from "./store.js";
import { builtInSkills, SkillRegistry } from "./skills.js";
import { extractMaterial } from "./source-material.js";
import { LeaderModelClient } from "./leader-model.js";
import { buildTaskSpec, buildTaskSpecFromIdea, type ProjectIdeaInput } from "./task-intake.js";
import { buildDynamicPlan } from "./planner.js";
import { assertStateTransition, availableActions } from "./state-machine.js";
import { captureBaseline, isSafeWorkspacePath, observeSince } from "./workspace-observer.js";
import { executionReportSchema, planPatchSchema, type CorrectionPatch, type ExecutionReport, type Handoff, type LeaderState, type LearningProfile, type PlanPatch, type ProjectEnvironmentFacts, type ReviewReport, type TaskSpec, type UserDecisionRequest, type WorkPlan } from "./schemas.js";
import { inspectWorkspace, repairWorkspace, type WorkspaceHealthReport } from "./workspace-health.js";
import { executeApprovedCommand } from "./verification-runner.js";
import { analyzeCompetitionGuide, buildCompetitionTaskSpec, buildDefenseSession, competitionScoreMap, diagnoseDebugSession } from "./competition.js";
import { competitionMetricRecordSchema, type CompetitionMetricRecord } from "./schemas.js";

const now = () => new Date().toISOString();

export function productBlueprintFor(task: TaskSpec) {
  const answered = new Map(task.openQuestions.filter((item) => item.answer).map((item) => [item.id, item.answer!]));
  const has = (id: string, fallback: boolean) => Boolean(answered.get(id)) || fallback;
  const categories = [
    { id: "objective", label: "产品目标", complete: task.objective.trim().length >= 12, detail: task.objective },
    { id: "users", label: "目标用户", complete: has("discovery-users", task.requirements.some((item) => /用户|面向|店主|团队|客户/.test(item.description))), detail: answered.get("discovery-users") ?? "尚未明确谁会使用产品" },
    { id: "mvp", label: "首版范围", complete: has("discovery-mvp", task.deliverables.length > 1), detail: answered.get("discovery-mvp") ?? "尚未划定首版包含与不包含的功能" },
    { id: "platform", label: "运行平台", complete: has("discovery-platform", task.constraints.some((item) => /平台|Windows|Web|移动|浏览器|桌面/i.test(item.description))), detail: answered.get("discovery-platform") ?? "尚未确定运行环境" },
    { id: "data", label: "数据与集成", complete: has("discovery-data", task.requirements.some((item) => /数据|账号|支付|第三方|本地|联网/.test(item.description))), detail: answered.get("discovery-data") ?? "尚未明确数据、账号、支付和第三方边界" },
    { id: "success", label: "成功标准", complete: has("discovery-success", task.acceptanceCriteria.length > 1), detail: answered.get("discovery-success") ?? "尚未定义可衡量的成功结果" },
    { id: "constraints", label: "商业与交付限制", complete: has("discovery-constraints", task.constraints.length > 0), detail: answered.get("discovery-constraints") ?? (task.constraints.map((item) => item.description).join("；") || "尚未确认时间、预算、离线或合规限制") }
  ];
  const completeCount = categories.filter((item) => item.complete).length;
  return { score: Math.round(completeCount / categories.length * 100), completeCount, total: categories.length, categories, gaps: categories.filter((item) => !item.complete).map((item) => item.label), ready: completeCount === categories.length };
}

export function competitionIdentityIssue(task: TaskSpec) {
  if (task.mode !== "competition") return null;
  const profile = task.competition;
  if (!profile) return "竞赛项目缺少结构化赛题资料。";
  if (!profile.selectionConfirmed) return "尚未由用户明确选择具体赛题编号和题名。";
  if (!profile.availableChallenges.some((item) => item.id === profile.challengeId && item.title === profile.challengeTitle)) return "当前赛题不在已解析并展示给用户的候选列表中。";
  if (profile.challengeTitle.trim() === profile.contestName.trim()) return "当前记录的是竞赛指南名称，不是具体赛题。";
  if (!profile.basicTasks.length || !task.rubricItems.length) return "具体赛题的基础要求或得分项没有解析完整。";
  return null;
}

export function architectureOptionsFor(task: TaskSpec) {
  if (task.mode === "competition" && task.competition) return competitionIdentityIssue(task) ? [] : competitionArchitectureOptionsFor(task);
  const context = [task.objective, ...task.constraints.map((item) => item.description), ...task.openQuestions.map((item) => item.answer ?? "")].join("\n").toLowerCase();
  if (/windows|桌面|electron/.test(context)) return [
    { id: "electron-local", name: "Electron 本地优先", recommended: true, summary: "TypeScript 全栈桌面架构，本地数据优先，核心规则可独立测试。", bestFor: "快速形成可销售的 Windows App", delivery: "快", cost: "低", risk: "低", advantages: ["单一 TypeScript 技术栈", "离线和系统能力成熟", "打包与自动更新路径清晰"], disadvantages: ["安装包较大", "需严格隔离主进程与渲染进程"] },
    { id: "native-windows", name: ".NET 原生桌面", recommended: false, summary: "使用 .NET/WPF 或 WinUI 获得更深的 Windows 集成。", bestFor: "强系统集成、长期 Windows 专属产品", delivery: "中", cost: "中", risk: "中", advantages: ["原生系统体验", "资源占用更可控", "企业生态成熟"], disadvantages: ["需要第二套技术能力", "跨平台成本高"] },
    { id: "web-cloud", name: "Web + 云服务", recommended: false, summary: "浏览器界面配合服务端，天然支持多设备与订阅。", bestFor: "多人协作和持续在线服务", delivery: "中", cost: "高", risk: "中", advantages: ["无需安装", "易于多端访问", "订阅和账号体系自然"], disadvantages: ["离线体验弱", "持续产生云成本与合规工作"] }
  ];
  if (/移动|android|ios|mobile|手机/.test(context)) return [
    { id: "cross-mobile", name: "跨平台移动端", recommended: true, summary: "共享业务层并通过适配器接入设备和服务能力。", bestFor: "同时覆盖 iOS 与 Android", delivery: "快", cost: "中", risk: "低", advantages: ["共享主要代码", "迭代一致", "团队规模更小"], disadvantages: ["深度原生能力需要桥接"] },
    { id: "native-mobile", name: "双端原生", recommended: false, summary: "分别构建 iOS 与 Android 客户端。", bestFor: "高性能和重度设备能力", delivery: "慢", cost: "高", risk: "中", advantages: ["平台体验最佳", "系统能力完整"], disadvantages: ["两套代码与团队", "功能一致性成本高"] },
    { id: "responsive-web", name: "响应式 Web", recommended: false, summary: "先以浏览器验证产品，再决定是否进入应用商店。", bestFor: "最低成本验证需求", delivery: "最快", cost: "低", risk: "中", advantages: ["发布快速", "无需商店审核"], disadvantages: ["设备能力和留存弱"] }
  ];
  return [
    { id: "modular-web", name: "模块化 TypeScript", recommended: true, summary: "交互、工作流、领域、存储和外部服务边界清晰分层。", bestFor: "在不锁定部署形态时稳健起步", delivery: "快", cost: "低", risk: "低", advantages: ["容易测试", "可渐进扩展", "供应商可替换"], disadvantages: ["前期需要守住模块边界"] },
    { id: "managed-platform", name: "托管平台优先", recommended: false, summary: "使用成熟 BaaS/低代码能力加速账号、数据和支付。", bestFor: "极快验证商业闭环", delivery: "最快", cost: "中", risk: "中", advantages: ["上线速度快", "运维负担小"], disadvantages: ["供应商锁定", "规模化成本不确定"] },
    { id: "service-first", name: "服务化架构", recommended: false, summary: "先建立独立 API 与服务边界，为多客户端预留空间。", bestFor: "明确的多端或企业集成需求", delivery: "慢", cost: "高", risk: "高", advantages: ["扩展边界清晰", "多端复用"], disadvantages: ["首版复杂度与运维成本高"] }
  ];
}

function competitionArchitectureOptionsFor(task: TaskSpec) {
  const profile = task.competition!, board = profile.selectedBoard ?? "待确认板卡";
  if (profile.category === "fpga-accelerator") return [
    { id: "accelerator-safe", name: "命令队列 + 基础 Blitter 保底路线", recommended: true, summary: `${board} 上先完成寄存器/命令 FIFO、矩形填充与块搬运、突发访存、双缓冲和 CPU/硬件 FPS 对照，再逐项增加图层能力。`, bestFor: "先证明 RISC-V 与 FPGA 异构渲染闭环并拿稳基础分", delivery: "快", cost: "低", risk: "低", advantages: ["软硬边界清楚", "容易建立软件基线和加速比", "DMA、带宽和时序问题可逐层定位"], disadvantages: ["首版视觉效果有限", "高级图层需要后续增量实现"] },
    { id: "accelerator-layered", name: "Sprite 与多图层平衡路线", recommended: false, summary: "在稳定 Blitter 上加入透明色、Alpha 混合、图层排序与裁剪，并保持命令协议向后兼容。", bestFor: "已有 DDR/总线和基础图形加速经验的队伍", delivery: "中", cost: "中", risk: "中", advantages: ["演示效果和技术含量平衡", "高阶项可独立验收"], disadvantages: ["读改写带宽压力更高", "混合精度与图层顺序验证复杂"] },
    { id: "accelerator-advanced", name: "高负载渲染引擎冲刺路线", recommended: false, summary: "围绕高同屏元素、缩放/旋转、并行命令处理和缓存策略进行高阶冲刺。", bestFor: "基础加速器已经在同类板卡稳定运行的强队", delivery: "慢", cost: "高", risk: "高", advantages: ["性能和现场展示上限高", "适合形成差异化亮点"], disadvantages: ["极易受 DDR 带宽、资源和时序限制", "必须保留可回退的基础版本"] }
  ];
  if (profile.category === "fpga-cpu") return [
    { id: "cpu-safe", name: "三级流水线保底路线", recommended: true, summary: `${board} 上先完成 RV32I、冲突处理、UART/GPIO 与稳定 CoreMark，再按数据决定 Cache 或分支预测。`, bestFor: "先拿稳基础分并建立可测量基线", delivery: "快", cost: "低", risk: "低", advantages: ["验证边界清楚", "易定位时序和功能错误", "便于逐项提高 CoreMark/MHz"], disadvantages: ["性能上限较低", "高阶项需要后续增量加入"] },
    { id: "cpu-balanced", name: "五级流水线平衡路线", recommended: false, summary: "以经典五级流水线为主线，预留 Cache、BTB 和异常中断接口。", bestFor: "团队已有 CPU 设计与验证基础", delivery: "中", cost: "中", risk: "中", advantages: ["性能空间更大", "结构适合后续高阶项"], disadvantages: ["冲突与转发验证复杂", "时序闭合和调试成本上升"] },
    { id: "cpu-ambitious", name: "Cache + AI 加速冲刺路线", recommended: false, summary: "从存储层次、总线突发和协处理接口出发设计高阶系统。", bestFor: "基础 CPU 已在同类板卡稳定运行的强队", delivery: "慢", cost: "高", risk: "高", advantages: ["高阶展示空间大", "应用场景和性能亮点强"], disadvantages: ["极易牺牲基础稳定性", "需要更完整的验证、带宽与资源预算"] }
  ];
  if (profile.category === "fpga-vision") return [
    { id: "vision-stream", name: "流式定点流水线", recommended: true, summary: `${board} 上采用行缓存、定点坐标映射和双线性插值，先跑通固定参数 1080P 视频闭环。`, bestFor: "实时、低延迟和资源效率优先", delivery: "中", cost: "低", risk: "中", advantages: ["延迟可预测", "适合时序和资源量化", "易扩展 Gamma/直方图模块"], disadvantages: ["定点精度设计要求高", "边界与访存验证复杂"] },
    { id: "vision-frame", name: "帧缓存映射路线", recommended: false, summary: "使用 DDR 帧缓存简化随机坐标读取和算法验证。", bestFor: "先验证畸变模型和图像质量", delivery: "快", cost: "中", risk: "中", advantages: ["算法映射直观", "便于与 OpenCV 参考结果比对"], disadvantages: ["带宽和端到端延迟更高", "DDR 控制增加系统风险"] },
    { id: "vision-dynamic", name: "IMU 动态矫正路线", recommended: false, summary: "在基础矫正链路上加入动态参数、仿射变换和极端光照预处理。", bestFor: "基础视频与标定链路已稳定的冲刺阶段", delivery: "慢", cost: "高", risk: "高", advantages: ["现场展示效果强", "覆盖多个高阶任务"], disadvantages: ["多时钟域与参数同步复杂", "现场鲁棒性压力大"] }
  ];
  if (profile.category === "fpga-ai") return [
    { id: "ai-hybrid", name: "FPGA 预处理 + ARM 识别", recommended: true, summary: `${board} 上由 FPGA 完成采集、增强、定位与低延迟传输，ARM 运行轻量识别模型。`, bestFor: "先形成完整、可演示的软硬协同闭环", delivery: "中", cost: "中", risk: "中", advantages: ["职责边界清楚", "模型迭代快", "便于量化每段延迟"], disadvantages: ["通信链路是关键风险", "需要统一数据格式与缓存策略"] },
    { id: "ai-fpga", name: "FPGA 端识别加速", recommended: false, summary: "将关键神经网络或特征算法定点化并在 FPGA 端加速。", bestFor: "已有模型和硬件算子库的团队", delivery: "慢", cost: "高", risk: "高", advantages: ["低延迟亮点突出", "FPGA 技术含量高"], disadvantages: ["量化精度和资源压力大", "验证周期长"] },
    { id: "ai-arm-first", name: "ARM 端识别保底", recommended: false, summary: "FPGA 先完成可靠采集与基础处理，识别主要由 ARM 实现。", bestFor: "时间紧、优先保证 95% 识别率和演示完整性", delivery: "快", cost: "低", risk: "低", advantages: ["快速建立准确率基线", "算法调试工具成熟"], disadvantages: ["FPGA 创新度有限", "端到端延迟可能不占优"] }
  ];
  return [
    { id: "competition-safe", name: "基础闭环优先", recommended: true, summary: `先在 ${board} 完成最小演示和全部基础得分项，再逐项增加创新功能。`, bestFor: "首次参加 FPGA/嵌入式竞赛的团队", delivery: "快", cost: "低", risk: "低", advantages: ["交付风险可控", "每一步都有可观察结果"], disadvantages: ["高阶创新需要后续冲刺"] },
    { id: "competition-balanced", name: "基础与亮点并行", recommended: false, summary: "一条主线保证基础闭环，一条隔离分支验证高阶亮点。", bestFor: "人员可以明确分工的团队", delivery: "中", cost: "中", risk: "中", advantages: ["兼顾稳定和创新", "适合多人协作"], disadvantages: ["集成窗口必须严格控制"] },
    { id: "competition-innovative", name: "创新展示优先", recommended: false, summary: "围绕独特应用场景反向设计硬件和演示。", bestFor: "基础平台已经成熟的强队", delivery: "慢", cost: "高", risk: "高", advantages: ["演示辨识度高"], disadvantages: ["基础得分和交付完整性风险大"] }
  ];
}

function localConsultation(question: string, state: LeaderState, task: TaskSpec | null, plan: WorkPlan | null, nextStep: string) {
  const query = question.toLowerCase();
  if (task?.mode === "competition") {
    const identityIssue = competitionIdentityIssue(task);
    if (identityIssue) return `当前不能继续：${identityIssue}。CodeGate 必须先从原始资料中列出候选赛题，并由你明确选择赛题编号和完整题名；在此之前不会生成或批准架构、计划和执行 Prompt。`;
    const profile = task.competition!;
    if (state.status === "task-spec-ready") {
      const options = architectureOptionsFor(task), recommended = options.find((item) => item.recommended)!;
      if (/为什么|推荐|why/.test(query)) return `推荐“${recommended.name}”，因为当前应先在 ${profile.selectedBoard ?? "已确认板卡"} 建立可上板、可测量的基础闭环。它适合${recommended.bestFor}；优势是${recommended.advantages.join("、")}；主要代价是${recommended.disadvantages.join("、")}。推荐不代表禁止冲高阶项，而是要求先保留可回退基线。`;
    }
    if (/基础分|保分|先做/.test(query)) return profile.basicTasks.length ? `当前先保这些基础项：\n${profile.basicTasks.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n每项都要同时留下仿真/工具日志、上板现象和对应源码位置。` : "赛题未明确分列基础任务；先完成最小硬件闭环和全部必需验收项。";
    if (/答辩|评委/.test(query)) return "优先准备六类问题：整体数据流与路线取舍、最差时序路径、资源代价、仿真与上板证据边界、现场输入变化下的失效点、以及源码/报告/波形/视频是否齐全。完成计划后可点击“开始答辩演练”生成项目专属问题。";
    if (/调试|错误|报错/.test(query)) return "若是编译、仿真、综合、布局布线、时序、下载或上板的局部失败，使用“调试快车道”粘贴首个错误；它只生成最小修复 Prompt，不重写正式冲刺计划。若修复会改变板卡、接口或总体路线，则停止快车道并回到实现路线决策。";
  }
  if (task && state.status === "task-spec-ready") {
    const options = architectureOptionsFor(task), recommended = options.find((item) => item.recommended)!;
    if (/为什么|推荐|why/.test(query)) return `推荐“${recommended.name}”，因为它最符合当前产品的平台与首版边界：${recommended.bestFor}。主要优势是${recommended.advantages.join("、")}；需要接受的代价是${recommended.disadvantages.join("、")}。这不是强制选择，你可以在页面上与另外两个方案比较后再决定。`;
    if (/成本|费用|价格|差异|compare/.test(query)) return options.map((item) => `${item.name}：交付${item.delivery}、成本${item.cost}、风险${item.risk}，适合${item.bestFor}`).join("\n");
  }
  if (task && state.status === "clarification-required") {
    const pending = task.openQuestions.find((item) => item.answer === null);
    if (pending) return `当前先确认“${pending.question}”是因为：${pending.impact}。你的答案会直接写入产品蓝图，之后仍可创建新版本修改。`;
  }
  if (plan && /风险|risk/.test(query)) return plan.risks.length ? `当前计划识别到 ${plan.risks.length} 项风险：\n${plan.risks.map((item, index) => `${index + 1}. ${item}`).join("\n")}` : "当前计划尚未记录显式风险；仍需在每一步通过验证证据检查实现偏差。";
  if (plan && state.currentStepId && ["step-ready", "handed-off"].includes(state.status)) {
    const step = plan.steps.find((item) => item.id === state.currentStepId);
    if (step && /产出|输出|完成|报告|判断/.test(query)) return `当前步骤要产出：${step.expectedOutputs.join("；") || step.objective}。完成后 Agent 还必须提交结构化 Execution Report；CodeGate 会按 ${step.verificationInstructions.join("；") || "任务验收映射"} 独立验证，不能只凭 Agent 自述通过。`;
  }
  return nextStep;
}

export class LeaderWorkflow {
  constructor(readonly root: string, readonly store = new LeaderStore(root)) {}
  async init() { await this.store.init(); for (const skill of builtInSkills) await this.store.installSkill(skill); }

  async openProject() {
    const existingEntries = await readdir(path.join(path.resolve(this.root), ".codegate")).catch(() => []);
    await this.store.prepareDirectories();
    if (!existingEntries.length) { await this.init(); return this.snapshot(); }
    const preliminaryHealth = await inspectWorkspace(this.root);
    const incompatible = preliminaryHealth.issues.find((issue) => issue.code === "protocol-newer");
    if (incompatible) throw new Error(incompatible.description + " 已阻止任何写入，请升级 CodeGate Leader。");
    await this.store.recoverPendingTransactions();
    const health = await repairWorkspace(this.root, this.store);
    await this.init();
    return this.snapshot(health);
  }

  async snapshot(precomputedHealth?: WorkspaceHealthReport) {
    await this.init();
    const [state, task, plan, environment, learningProfile, architectureDecisions, pendingDecisions, reviews, planPatches, verificationRuns, eventLog, latestLeaderAnalysis, assistantMessages, modelUsage, health, projectConfig, competitionDebugSessions, competitionMetricRecords, competitionDefenseSessions] = await Promise.all([this.store.state(), this.store.task(), this.store.plan(), this.store.environment(), this.store.learningProfile(), this.store.decisions(), this.store.pendingDecisions(), this.store.reviews(), this.store.planPatches(), this.store.verificationRuns(), this.store.verifyEventLog(), this.store.latestLeaderAnalysis(), this.store.assistantMessages(), this.store.modelUsage(), precomputedHealth ?? inspectWorkspace(this.root), this.store.projectConfig(), this.store.competitionDebugSessions(), this.store.competitionMetricRecords(), this.store.competitionDefenseSessions()]);
    const verificationCommands = environment?.status === "confirmed" ? [...new Set([...environment.buildCommands, ...environment.testCommands, ...environment.verificationCommands])] : [];
    const currentHandoff = state.currentStepId ? await this.store.latestHandoff(state.currentStepId) : null;
    const currentReport = state.currentStepId ? (await this.store.reports(state.currentStepId)).filter((report) => !currentHandoff || report.handoffVersion === currentHandoff.version).at(-1) ?? null : null;
    const pricedCalls = modelUsage.filter((item) => item.estimatedCostUsd !== null);
    const modelUsageSummary = { calls: modelUsage.length, totalTokens: modelUsage.reduce((sum, item) => sum + item.totalTokens, 0), estimatedCostUsd: pricedCalls.length ? pricedCalls.reduce((sum, item) => sum + (item.estimatedCostUsd ?? 0), 0) : null, byOperation: Object.fromEntries(["consult", "analysis", "mentor", "review"].map((operation) => [operation, modelUsage.filter((item) => item.operation === operation).length])), recent: modelUsage.slice(-10).reverse() };
    const productMetrics = { localOnly: true, conversations: Math.floor(assistantMessages.length / 2), planRevisions: planPatches.length, verificationRuns: verificationRuns.length, reviews: reviews.length, acceptedSteps: plan?.steps.filter((item) => item.status === "accepted").length ?? 0, totalSteps: plan?.steps.length ?? 0, lastActivityAt: state.updatedAt };
    const projectMode = task?.mode ?? projectConfig.mode;
    const competition = task?.mode === "competition" ? { profile: task.competition, identityIssue: competitionIdentityIssue(task), scoreMap: competitionScoreMap(task, plan, competitionMetricRecords), debugSessions: competitionDebugSessions.slice(-20).reverse(), metricRecords: competitionMetricRecords, latestDefense: competitionDefenseSessions.at(-1) ?? null } : null;
    return { state, task, plan, environment, learningProfile, architectureDecisions, architectureOptions: task ? architectureOptionsFor(task) : [], productBlueprint: task && task.mode !== "competition" ? productBlueprintFor(task) : null, projectMode, competition, pendingDecisions, reviews, planPatches, verificationRuns, verificationCommands, currentHandoff, currentReport, assistantMessages, modelUsageSummary, productMetrics, eventLog, latestLeaderAnalysis, health, availableActions: competition?.identityIssue ? [] : availableActions(state.status) };
  }

  async setProjectMode(mode: "product" | "competition") {
    const [state, task] = await Promise.all([this.store.state(), this.store.task()]);
    if (state.status !== "new" || task) throw new Error("项目开始后不能直接切换模式；请新建项目或通过版本化任务修订。");
    return this.store.saveProjectConfig(mode);
  }

  async inspectCompetitionSource(taskFile: string) {
    const absolute = path.resolve(this.root, taskFile);
    if (!this.isInsideRoot(absolute)) throw new Error("赛题资料必须先安全复制到当前工作区。");
    const material = await extractMaterial(absolute);
    return { sourceFile: taskFile, analysis: analyzeCompetitionGuide(material.text), warnings: material.warnings };
  }

  async intakeCompetition(taskFile: string, challengeId: string) {
    await this.init();
    const state = await this.store.state();
    if (state.status !== "new") throw new Error("已有任务，不能重复导入初始赛题。");
    const absolute = path.resolve(this.root, taskFile);
    if (!this.isInsideRoot(absolute)) throw new Error("赛题资料必须位于当前工作区内。");
    const material = await extractMaterial(absolute);
    const task = buildCompetitionTaskSpec(taskFile, material.text, material.sourceType, now(), challengeId, material.lineLocators);
    await this.store.saveProjectConfig("competition");
    const nextState: LeaderState = { schemaVersion: 2, status: "clarification-required", taskId: task.id, taskSpecVersion: task.version, workPlanVersion: null, currentStepId: null, pendingDecisionId: null, updatedAt: now() };
    await this.commitStateful("competition-intake", state, nextState, this.taskArtifacts(task));
    if (material.warnings.length) await this.store.event("source-warning", { source: taskFile, warnings: material.warnings });
    return task;
  }

  async intake(taskFile: string) {
    await this.init();
    const state = await this.store.state();
    if (state.status !== "new") throw new Error("已有任务；请在新工作区开始，或先审查现有 .codegate 状态。");
    const absolute = path.resolve(this.root, taskFile);
    if (!this.isInsideRoot(absolute)) throw new Error("任务资料必须位于目标工作区内。");
    const material = await extractMaterial(absolute);
    const content = material.text;
    const task = buildTaskSpec(taskFile, content, material.sourceType, now(), material.lineLocators);
    const nextState: LeaderState = { schemaVersion: 2, status: task.openQuestions.some((item) => item.blocking) ? "clarification-required" : "intake", taskId: task.id, taskSpecVersion: 1, workPlanVersion: null, currentStepId: null, pendingDecisionId: null, updatedAt: now() };
    await this.commitStateful("task-intake", state, nextState, this.taskArtifacts(task));
    if (material.warnings.length) await this.store.event("source-warning", { source: taskFile, warnings: material.warnings });
    return task;
  }

  async startFromIdea(input: ProjectIdeaInput) {
    await this.init();
    const state = await this.store.state();
    if (state.status !== "new") throw new Error("当前项目已经开始规划，不能重复创建初始任务。");
    const task = buildTaskSpecFromIdea(input, now());
    const nextState: LeaderState = { schemaVersion: 2, status: task.openQuestions.some((item) => item.blocking && item.answer === null) ? "clarification-required" : "intake", taskId: task.id, taskSpecVersion: task.version, workPlanVersion: null, currentStepId: null, pendingDecisionId: null, updatedAt: now() };
    await this.commitStateful("idea-intake", state, nextState, this.taskArtifacts(task));
    return task;
  }

  async addSourceMaterial(sourceFile: string) {
    const [current, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("资料只能在 TaskSpec 批准前添加。");
    const absolute = path.resolve(this.root, sourceFile);
    if (!this.isInsideRoot(absolute)) throw new Error("任务资料必须位于目标工作区内。");
    const material = await extractMaterial(absolute), sourceId = `source-${current.sourceMaterialIds.length + 1}`;
    const extracted = buildTaskSpec(sourceFile, material.text, material.sourceType, now(), material.lineLocators, sourceId);
    const merge = <T extends { description: string }>(existing: T[], incoming: T[]) => [...existing, ...incoming.filter((item) => !existing.some((currentItem) => currentItem.description.toLowerCase() === item.description.toLowerCase()))];
    const prefix = <T extends { id: string }>(items: T[], kind: string) => items.map((item, index) => ({ ...item, id: `${sourceId}-${kind}-${index + 1}` }));
    const requirements = merge(current.requirements, prefix(extracted.requirements, "req"));
    const deliverables = merge(current.deliverables, prefix(extracted.deliverables, "del"));
    const acceptanceCriteria = merge(current.acceptanceCriteria, prefix(extracted.acceptanceCriteria, "ac"));
    const rubricItems = merge(current.rubricItems, prefix(extracted.rubricItems, "rubric").map((item) => ({ ...item, mappedRequirementIds: requirements.map((value) => value.id), mappedDeliverableIds: deliverables.map((value) => value.id) })));
    const revised: TaskSpec = { ...current, version: current.version + 1, requirements, deliverables, constraints: merge(current.constraints, prefix(extracted.constraints, "constraint")), assumptions: merge(current.assumptions, prefix(extracted.assumptions, "assumption")), openQuestions: [...current.openQuestions, ...prefix(extracted.openQuestions, "question")], acceptanceCriteria, rubricItems, sourceMaterialIds: [...current.sourceMaterialIds, sourceId], updatedAt: now() };
    const nextState: LeaderState = { ...state, status: revised.openQuestions.some((item) => item.blocking && item.answer === null) ? "clarification-required" : "intake", taskSpecVersion: revised.version, updatedAt: now() };
    await this.commitStateful("add-source-material", state, nextState, this.taskArtifacts(revised));
    if (material.warnings.length) await this.store.event("source-warning", { source: sourceFile, warnings: material.warnings });
    return revised;
  }

  async approveTask() {
    const [task, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("当前没有待审批的 TaskSpec。");
    if (task.openQuestions.some((item) => item.blocking && item.answer === null)) {
      await this.changeState(state, { ...state, status: "clarification-required", updatedAt: now() });
      throw new Error("存在未回答的阻塞问题；不能批准 TaskSpec。");
    }
    this.assertTaskReady(task);
    await this.changeState(state, { ...state, status: "task-spec-ready", updatedAt: now() });
  }

  async clarify(questionId: string, answer: string) {
    const [task, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("当前 TaskSpec 不接受澄清。");
    const question = task.openQuestions.find((item) => item.id === questionId);
    if (!question) throw new Error("未找到该澄清问题。");
    if (question.answer !== null) throw new Error("该澄清问题已回答；请通过 TaskSpec 修订改变结论。");
    const resolvedAnswer = answer.trim();
    if (!resolvedAnswer) throw new Error("请填写答案后再继续。");
    const pointer = { sourceId: `discovery-v${task.version + 1}`, sourceType: "user-message" as const, locator: `onboarding/${questionId}`, contentHash: LeaderStore.hash(resolvedAnswer) };
    const requirements = [...task.requirements];
    const deliverables = [...task.deliverables];
    const constraints = [...task.constraints];
    const acceptanceCriteria = [...task.acceptanceCriteria];
    const assumptions = [...task.assumptions];
    let competition = task.competition;
    if (task.mode === "competition" && competition) {
      if (questionId === "competition-open-concept") {
        requirements.push({ id: `req-open-concept-v${task.version + 1}`, description: `开放选题作品定义：${resolvedAnswer}`, priority: "must", sourcePointers: [pointer] });
        deliverables.push({ id: `del-open-demo-v${task.version + 1}`, description: `现场演示自定义 SOPC 创新作品：${resolvedAnswer}`, required: true, sourcePointers: [pointer] });
        acceptanceCriteria.push({ id: `ac-open-demo-v${task.version + 1}`, title: "开放选题作品闭环可现场复现", description: resolvedAnswer, required: true, verificationMethod: "user-confirmation", expectedEvidence: ["现场演示录像", "输入输出说明", "源码与工程文件"], sourcePointers: [pointer] });
      }
      if (questionId === "competition-board") {
        competition = { ...competition, selectedBoard: resolvedAnswer };
        constraints.push({ id: `constraint-board-v${task.version + 1}`, description: `本项目硬件基线：${resolvedAnswer}`, hard: true, sourcePointers: [pointer] });
      }
      if (questionId === "competition-readiness") assumptions.push({ id: `readiness-v${task.version + 1}`, description: `团队当前起点：${resolvedAnswer}`, status: "confirmed" });
      if (questionId === "competition-strategy") requirements.push({ id: `req-strategy-v${task.version + 1}`, description: `竞赛冲刺策略：${resolvedAnswer}`, priority: "should", sourcePointers: [pointer] });
    }
    if (questionId === "discovery-users") requirements.push({ id: `req-users-v${task.version + 1}`, description: `产品主要面向：${resolvedAnswer}`, priority: "must", sourcePointers: [pointer] });
    if (questionId === "discovery-mvp") {
      requirements.push({ id: `req-mvp-v${task.version + 1}`, description: `首个版本范围：${resolvedAnswer}`, priority: "must", sourcePointers: [pointer] });
      deliverables.push({ id: `del-mvp-scope-v${task.version + 1}`, description: `按已确认 MVP 范围交付：${resolvedAnswer}`, required: true, sourcePointers: [pointer] });
    }
    if (questionId === "discovery-platform") constraints.push({ id: `constraint-platform-v${task.version + 1}`, description: `目标运行平台：${resolvedAnswer}`, hard: true, sourcePointers: [pointer] });
    if (questionId === "discovery-data") requirements.push({ id: `req-data-v${task.version + 1}`, description: `数据、账号、支付与外部服务边界：${resolvedAnswer}`, priority: "must", sourcePointers: [pointer] });
    if (questionId === "discovery-success") acceptanceCriteria.push({ id: `ac-success-v${task.version + 1}`, title: resolvedAnswer.slice(0, 120), description: resolvedAnswer, required: true, verificationMethod: "user-confirmation", expectedEvidence: ["可观察的产品结果", "用户确认记录"], sourcePointers: [pointer] });
    if (questionId === "discovery-constraints" && !/^(暂无|没有|none|no)$/i.test(resolvedAnswer)) constraints.push({ id: `constraint-discovery-v${task.version + 1}`, description: resolvedAnswer, hard: true, sourcePointers: [pointer] });
    const revised: TaskSpec = {
      ...task,
      version: task.version + 1,
      requirements,
      deliverables,
      constraints,
      acceptanceCriteria,
      assumptions,
      competition,
      openQuestions: task.openQuestions.map((item) => item.id === questionId ? { ...item, answer: resolvedAnswer } : item),
      updatedAt: now()
    };
    const nextState: LeaderState = { ...state, status: revised.openQuestions.some((item) => item.blocking && item.answer === null) ? "clarification-required" : "intake", taskSpecVersion: revised.version, updatedAt: now() };
    await this.commitStateful("clarify-task", state, nextState, this.taskArtifacts(revised));
    return revised;
  }

  async analyzeWithLeader(userMessage = "") {
    const [task, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("只能在 TaskSpec 批准前运行 Leader 分析。");
    const client = new LeaderModelClient();
    const analysis = await client.analyze(redactForModel({ objective: task.objective, deliverables: task.deliverables, requirements: task.requirements, constraints: task.constraints, assumptions: task.assumptions, openQuestions: task.openQuestions, acceptanceCriteria: task.acceptanceCriteria, rubricItems: task.rubricItems }), redactSensitiveText(userMessage));
    if (client.lastUsage) await this.store.recordModelUsage(client.lastUsage);
    const revised: TaskSpec = {
      ...task, version: task.version + 1,
      assumptions: [...task.assumptions, ...analysis.assumptions.map((description, index) => ({ id: "model-assumption-" + (task.assumptions.length + index + 1), description, status: "unconfirmed" as const }))],
      openQuestions: [...task.openQuestions, ...analysis.questions.map((item, index) => ({ id: "model-question-" + (task.openQuestions.length + index + 1), ...item, answer: null }))],
      updatedAt: now()
    };
    const nextState: LeaderState = { ...state, status: revised.openQuestions.some((item) => item.blocking && item.answer === null) ? "clarification-required" : "intake", taskSpecVersion: revised.version, updatedAt: now() };
    await this.commitStateful("leader-analysis", state, nextState, [...this.taskArtifacts(revised), { relativePath: `learning/analysis-${Date.now()}.json`, value: analysis, immutable: true }]);
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
    const client = new LeaderModelClient(), answer = await client.mentor("Task: " + task.objective + "\nStep: " + step.title + "\nRationale: " + step.rationale, question, profile);
    if (client.lastUsage) await this.store.recordModelUsage(client.lastUsage);
    await this.store.event("mentor-question", { stepId: step.id, question });
    return answer;
  }

  async startCompetitionDebug(input: { symptom?: string; log?: string }) {
    const [task, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (task.mode !== "competition") throw new Error("调试快车道只在竞赛冲刺模式中提供。");
    const symptom = String(input.symptom ?? "").trim(), log = String(input.log ?? "").trim();
    if (symptom.length < 4) throw new Error("请描述当前现象或失败步骤。");
    if (!log) throw new Error("请粘贴首个错误附近的工具日志、跑分结果或上板现象记录。");
    const session = diagnoseDebugSession({ symptom, log, stepId: state.currentStepId }, now());
    await this.store.saveCompetitionDebugSession(session);
    return session;
  }

  async resolveCompetitionDebug(id: string, resolution: string, evidence: string[] = []) {
    const sessions = await this.store.competitionDebugSessions(), session = sessions.find((item) => item.id === id);
    if (!session) throw new Error("未找到调试会话。");
    if (session.status === "resolved") throw new Error("该调试会话已经归档。");
    const result = resolution.trim();
    if (!result) throw new Error("请填写修复结果。");
    return this.store.saveCompetitionDebugSession({ ...session, status: "resolved", resolution: result, evidence: evidence.map(String).map((item) => item.trim()).filter(Boolean), resolvedAt: now() });
  }

  async recordCompetitionMetric(input: { metricId?: string; value?: number; unit?: string; context?: string; evidence?: string[] }) {
    const task = await this.requireTask();
    if (task.mode !== "competition" || !task.competition) throw new Error("跑分记录只在竞赛冲刺模式中提供。");
    const metric = task.competition.metrics.find((item) => item.id === input.metricId);
    if (!metric) throw new Error("请选择赛题中已识别的指标。");
    const record: CompetitionMetricRecord = competitionMetricRecordSchema.parse({ id: `metric-record-${Date.now()}`, metricId: metric.id, label: metric.label, value: Number(input.value), unit: String(input.unit ?? metric.unit ?? "value").trim() || "value", context: String(input.context ?? "同一测试条件下的手工记录").trim(), evidence: (input.evidence ?? []).map(String).map((item) => item.trim()).filter(Boolean), recordedAt: now() });
    return this.store.saveCompetitionMetricRecord(record);
  }

  async createCompetitionDefenseSession() {
    const [task, plan, metrics] = await Promise.all([this.requireTask(), this.store.plan(), this.store.competitionMetricRecords()]);
    if (task.mode !== "competition") throw new Error("答辩演练只在竞赛冲刺模式中提供。");
    const session = buildDefenseSession(task, plan, metrics, now());
    await this.store.saveCompetitionDefenseSession(session);
    return session;
  }

  async consult(question: string) {
    if (!question.trim()) throw new Error("请先输入要咨询的问题。");
    const [state, task, plan, environment, projectConfig] = await Promise.all([this.store.state(), this.store.task(), this.store.plan(), this.store.environment(), this.store.projectConfig()]);
    const competitionNextSteps: Record<LeaderState["status"], string> = {
      new: "这是竞赛冲刺项目。下一步导入官方赛题 PDF、Word、Markdown 或图片，选择具体挑战题目；CodeGate 会提取基础分、高阶项、板卡、工具链、测评指标和提交物。",
      "clarification-required": "先如实确认目标板卡、工具链现状和团队已经跑通的最小闭环；不知道的事实明确标记未知，不让 Agent 猜测。",
      intake: "检查竞赛得分地图与冲刺策略，确认后选择一条实现路线。",
      "task-spec-ready": "比较三条实现路线，优先选择能在当前板卡和团队起点上建立稳定基础闭环的方案。",
      "architecture-review": "实现路线已经记录。下一步生成六阶段冲刺计划：环境、最小闭环、基础分、高阶优化、现场鲁棒、提交答辩。",
      "plan-ready": "检查基础分是否早于高阶项、每项是否有证据映射，然后批准冲刺计划。",
      "step-ready": "生成当前小步的 Agent Prompt；若只是工具报错，也可直接使用调试快车道。",
      "handed-off": "让 Agent 按 Prompt 完成当前小步并写入报告；遇到局部错误时用调试快车道，不要盲目扩大修改范围。",
      "result-reported": "用已确认工具命令、报告和真实上板结果验证，再做独立审查。",
      "under-review": "完成独立证据审查，不能把 Agent 自述或仅仿真结果当作现场通过。",
      "correction-ready": "局部问题先最小纠偏；如果只是日志明确的工具错误，调试快车道更快。",
      "user-decision-required": "根据基础分稳定性、剩余时间和高阶收益做明确取舍。",
      blocked: "补齐板卡事实、工具日志或验证证据后再继续，禁止猜测硬件参数。",
      "task-completed": "检查提交清单、保存最终跑分，生成导师总结并开始模拟答辩。"
    };
    const nextStep = (task?.mode ?? projectConfig.mode) === "competition" ? competitionNextSteps[state.status] : state.status === "new"
      ? "项目目录已经打开。下一步直接描述产品想法，让 CodeGate 通过引导访谈建立 TaskSpec；已有资料时也可以选择导入。"
      : state.status === "clarification-required"
        ? "先在 TaskSpec 的待澄清问题中填写并确认所有阻塞答案，然后批准 TaskSpec。"
        : state.status === "intake"
          ? "检查或修订 TaskSpec；若事实完整，点击“批准 TaskSpec”。"
          : state.status === "task-spec-ready"
            ? "比较页面给出的三个架构方案，查看交付速度、成本、风险和代价，然后选择最适合当前产品的方案；有明确团队约束时也可填写自定义架构。"
            : state.status === "architecture-review"
              ? "架构决策已经记录。下一步点击“生成可执行计划地图”，检查步骤依赖、验收映射和计划风险。"
              : state.status === "plan-ready"
                ? "检查计划地图中的步骤依赖、范围、验收映射和风险，然后点击“批准路线并准备第一步”。"
                : state.status === "step-ready"
                  ? "在执行中心选择 Codex、Claude Code 或其他 Agent，然后点击“生成并打开 Agent Prompt”。"
                  : state.status === "handed-off"
                    ? "把当前 Agent Prompt 交给编程 Agent；完成后点击“检测并导入执行报告”，CodeGate 会再做可信验证和独立审查。"
                    : state.status === "result-reported" || state.status === "under-review"
                      ? "如环境包含已确认命令，先运行可信验证，再点击“Review Report”。"
                      : state.status === "correction-ready"
                        ? "点击“Correction Handoff”，让执行 Agent 只修复 Review 指定的问题。"
                        : state.status === "user-decision-required"
                          ? "查看待决策内容，选择处理方式并提交决策。"
                          : state.status === "blocked"
                            ? "当前流程被阻塞；查看最新 Review、风险和待决策内容后解除阻塞。"
                            : "任务已完成；可查看 Mentor Brief 和最终审查记录。";
    const context = redactForModel({ state, task: task ? { title: task.title, objective: task.objective, openQuestions: task.openQuestions.filter((item) => item.answer === null) } : null, plan: plan ? { summary: plan.summary, currentStep: plan.steps.find((item) => item.id === state.currentStepId) ?? null } : null, environment: environment ? { status: environment.status, unknowns: environment.unknowns } : null });
    const sanitizedQuestion = redactSensitiveText(question), client = new LeaderModelClient();
    const identityIssue = task ? competitionIdentityIssue(task) : null;
    const answer = identityIssue ? localConsultation(sanitizedQuestion, state, task, plan, nextStep) : client.configured ? await client.consult(context, sanitizedQuestion, nextStep) : localConsultation(sanitizedQuestion, state, task, plan, nextStep);
    if (client.lastUsage) await this.store.recordModelUsage(client.lastUsage);
    await this.store.appendAssistantExchange(sanitizedQuestion, answer, state.status);
    return answer;
  }

  async updateTask(task: TaskSpec) {
    const [current, state] = await Promise.all([this.requireTask(), this.store.state()]);
    if (state.status !== "intake" && state.status !== "clarification-required") throw new Error("TaskSpec 只能在批准前修订。");
    if (task.id !== current.id || task.version !== current.version + 1) throw new Error("TaskSpec 修订必须保持 ID，并将版本递增 1。");
    if (task.createdAt !== current.createdAt) throw new Error("TaskSpec 修订不能改变创建时间。");
    const revised = { ...task, updatedAt: now() };
    const nextState: LeaderState = { ...state, status: task.openQuestions.some((item) => item.blocking && item.answer === null) ? "clarification-required" : "intake", taskSpecVersion: task.version, updatedAt: now() };
    await this.commitStateful("update-task", state, nextState, this.taskArtifacts(revised));
  }

  async reviseTaskFromUi(input: { objective?: string; requirements?: Record<string, string>; deliverables?: Record<string, string>; acceptanceCriteria?: Record<string, string>; newRequirement?: string; newDeliverable?: string; newAcceptance?: string }) {
    const current = await this.requireTask();
    const pointerFor = (kind: string, content: string) => ({ sourceId: `desktop-edit-v${current.version + 1}`, sourceType: "user-message" as const, locator: `desktop-task-editor/${kind}`, contentHash: LeaderStore.hash(content) });
    const revise = <T extends { id: string; description: string; sourcePointers: TaskSpec["requirements"][number]["sourcePointers"] }>(items: T[], changes: Record<string, string> | undefined) => items.map((item) => {
      const description = changes?.[item.id]?.trim();
      return description && description !== item.description ? { ...item, description, sourcePointers: [...item.sourcePointers, pointerFor(item.id, description)] } : item;
    });
    let requirements = revise(current.requirements, input.requirements);
    let deliverables = revise(current.deliverables, input.deliverables);
    let acceptanceCriteria = revise(current.acceptanceCriteria, input.acceptanceCriteria);
    if (input.newRequirement?.trim()) requirements = [...requirements, { id: `req-${Date.now()}`, description: input.newRequirement.trim(), priority: "must", sourcePointers: [pointerFor("new-requirement", input.newRequirement.trim())] }];
    if (input.newDeliverable?.trim()) deliverables = [...deliverables, { id: `del-${Date.now()}`, description: input.newDeliverable.trim(), required: true, sourcePointers: [pointerFor("new-deliverable", input.newDeliverable.trim())] }];
    if (input.newAcceptance?.trim()) acceptanceCriteria = [...acceptanceCriteria, { id: `ac-${Date.now()}`, title: input.newAcceptance.trim().slice(0, 120), description: input.newAcceptance.trim(), required: true, verificationMethod: "artifact-review", expectedEvidence: ["交付物", "Git Diff"], sourcePointers: [pointerFor("new-acceptance", input.newAcceptance.trim())] }];
    const objective = input.objective?.trim() || current.objective;
    const revised: TaskSpec = { ...current, version: current.version + 1, objective, requirements, deliverables, acceptanceCriteria, updatedAt: now() };
    await this.updateTask(revised);
    return revised;
  }

  async architecture(title: string, decision: string) {
    const task = await this.requireTask(), state = await this.store.state(), analysis = await this.store.latestLeaderAnalysis();
    if (state.status !== "task-spec-ready" && state.status !== "architecture-review") throw new Error("需先完成 TaskSpec。");
    this.assertTaskReady(task);
    const resolvedDecision = decision.trim();
    if (!resolvedDecision) throw new Error("请选择实现路线，或填写自定义技术方案后再继续。");
    const architectureDecision = { id: "adr-" + Date.now(), version: 1, title, status: "accepted" as const, context: task.objective, decision: resolvedDecision, alternatives: analysis?.architectureAlternatives.map((item) => ({ name: item.name, advantages: item.advantages, disadvantages: item.disadvantages, ...(item.recommendation ? {} : { rejectionReason: "未被用户选为当前决策。" }) })) ?? [], consequences: analysis?.architectureAlternatives.find((item) => item.recommendation)?.advantages ?? [], affectedStepIds: [], sourcePointers: task.requirements[0]!.sourcePointers, createdAt: now() };
    const nextState: LeaderState = { ...state, status: "architecture-review", updatedAt: now() };
    await this.commitStateful("architecture-decision", state, nextState, [{ relativePath: `architecture/decisions/${architectureDecision.id}-v1.json`, value: architectureDecision, immutable: true }]);
  }

  async recommendArchitecture() {
    const task = await this.requireTask();
    const state = await this.store.state();
    if (state.status !== "task-spec-ready" && state.status !== "architecture-review") throw new Error("需先完成 TaskSpec。");
    this.assertTaskReady(task);
    const context = [task.objective, ...task.constraints.map((item) => item.description), ...task.openQuestions.map((item) => item.answer ?? "")].join("\n").toLowerCase();
    const stack = /windows|桌面|electron/.test(context)
      ? "Electron + TypeScript 桌面应用，主进程负责本地能力和安全边界，渲染进程负责交互；核心业务保持为可独立测试的 TypeScript 模块。"
      : /移动|android|ios|mobile|手机/.test(context)
        ? "跨平台移动客户端与独立服务层，界面、业务规则和数据访问分层，外部服务通过可替换适配器接入。"
        : /web|网页|网站|浏览器/.test(context)
          ? "TypeScript Web 应用与独立服务层，采用模块化领域边界，界面、业务逻辑、持久化和外部集成解耦。"
          : "采用模块化分层架构：交互层、应用工作流、领域规则、数据存储和外部适配器相互隔离，并为关键边界建立自动化测试。";
    const decision = `${stack} 首个版本优先形成最小可盈利闭环；账号、支付、遥测和第三方服务均通过显式接口接入，避免核心产品被供应商锁定。`;
    await this.architecture("推荐的初始技术架构", decision);
    return decision;
  }

  async createPlan() {
    const task = await this.requireTask(), state = await this.store.state();
    if (state.status !== "architecture-review") throw new Error("需先完成架构审查。");
    this.assertTaskReady(task);
    const [decisions, environment, previousPlan] = await Promise.all([this.store.decisions(), this.store.environment(), this.store.plan()]);
    const generated = buildDynamicPlan(task, decisions, environment, now());
    const plan: WorkPlan = previousPlan ? { ...generated, id: previousPlan.id, version: previousPlan.version + 1, createdAt: previousPlan.createdAt } : generated;
    const nextState: LeaderState = { ...state, status: "plan-ready", workPlanVersion: plan.version, updatedAt: now() };
    await this.commitStateful("create-plan", state, nextState, this.planArtifacts(plan));
    return plan;
  }

  async approvePlan(recordPatch = false) {
    const [plan, state, task] = await Promise.all([this.requirePlan(), this.store.state(), this.requireTask()]);
    if (state.status !== "plan-ready" || plan.status !== "draft") throw new Error("当前没有待审批的 Plan。");
    this.assertTaskReady(task);
    this.assertPlanValid(task, plan);
    const approved: WorkPlan = { ...plan, version: plan.version + 1, status: "approved", updatedAt: now() };
    const nextState: LeaderState = { ...state, status: "step-ready", workPlanVersion: approved.version, currentStepId: approved.steps.find((item) => item.status === "ready")?.id ?? null, updatedAt: now() };
    const patch: PlanPatch = { id: "plan-approval-v" + approved.version, basePlanVersion: plan.version, targetPlanVersion: approved.version, reason: "User approved the WorkPlan.", triggeredBy: "user", operations: [{ type: "set-step-status", stepId: "step-001", description: "Make the first dependency-ready step available." }], affectedStepIds: ["step-001"], requiresUserApproval: false, createdAt: now() };
    await this.commitStateful("approve-plan", state, nextState, [...this.planArtifacts(approved), ...(recordPatch ? [{ relativePath: `plan/patches/${patch.id}.json`, value: patch, immutable: true } satisfies StoreTransactionEntry] : [])]);
  }

  async handoff(agent: Handoff["agentAdapter"]) { return this.createHandoff(agent); }

  async discoverCurrentReport() {
    const state = await this.store.state();
    if (!state.currentStepId) return null;
    const handoff = await this.store.latestHandoff(state.currentStepId);
    if (!handoff) return null;
    return (await this.store.reports(state.currentStepId)).filter((report) => report.handoffVersion === handoff.version).at(-1) ?? null;
  }

  async ingest(report: ExecutionReport) {
    report = executionReportSchema.parse(report);
    const [state, plan] = await Promise.all([this.store.state(), this.requirePlan()]);
    if (state.status !== "handed-off" || state.currentStepId !== report.stepId) throw new Error("报告不对应当前交接步骤。");
    if (!await this.store.handoff(report.stepId, report.handoffVersion)) throw new Error("报告引用的 Handoff 不存在；不能接受未交接的执行结果。");
    const baseline = await this.store.baseline(report.stepId, report.handoffVersion);
    if (!baseline) throw new Error("报告引用的 Handoff 缺少 WorkspaceBaseline。");
    if (report.workspaceRevisionBefore && baseline.headRevision && report.workspaceRevisionBefore !== baseline.headRevision) throw new Error("报告的 workspaceRevisionBefore 与 Handoff 基线不一致。");
    const unsafe = report.filesChanged.filter((file) => !isSafeWorkspacePath(this.root, file));
    if (unsafe.length) throw new Error("Execution Report 的 filesChanged 包含工作区外或 CodeGate 受保护路径：" + unsafe.join(", "));
    if (this.currentStep(plan, report.stepId).status !== "handed-off") throw new Error("当前步骤未处于已交接状态。");
    let facts: ProjectEnvironmentFacts | null = null;
    if (report.environmentFacts) {
      const current = await this.store.environment();
      facts = { ...report.environmentFacts, revision: (current?.revision ?? 0) + 1, status: "pending-confirmation" };
    }
    const nextPlan = this.withStep(plan, report.stepId, "reported", "executing");
    const nextState: LeaderState = { ...state, status: "result-reported", workPlanVersion: nextPlan.version, updatedAt: now() };
    await this.commitStateful("ingest-report", state, nextState, [
      { relativePath: `agent-reports/${report.reportId}.json`, value: report, immutable: true },
      ...(facts ? this.environmentArtifacts(facts) : []),
      ...this.planArtifacts(nextPlan)
    ]);
  }

  async confirmEnvironment() {
    const facts = await this.store.environment();
    if (!facts) throw new Error("尚无待确认的环境事实。");
    if (facts.status !== "pending-confirmation") throw new Error("当前环境事实不处于待确认状态。");
    const confirmed: ProjectEnvironmentFacts = { ...facts, revision: facts.revision + 1, status: "confirmed" };
    await this.store.commitArtifacts("confirm-environment", this.environmentArtifacts(confirmed), { revision: confirmed.revision, status: confirmed.status });
  }

  async runVerification(command: string, confirmed: boolean) {
    if (!confirmed) throw new Error("执行验证命令前必须获得用户明确确认。");
    const [state, plan, environment] = await Promise.all([this.store.state(), this.requirePlan(), this.store.environment()]);
    if (!["handed-off", "result-reported", "under-review"].includes(state.status) || !state.currentStepId) throw new Error("当前状态不允许执行验证命令。");
    if (!environment || environment.status !== "confirmed") throw new Error("必须先确认环境事实和其中的验证命令。");
    const approved = [...new Set([...environment.buildCommands, ...environment.testCommands, ...environment.verificationCommands])];
    if (!approved.includes(command)) throw new Error("只能执行已确认环境中的精确命令；不允许追加参数或 Shell 操作符。");
    const step = this.currentStep(plan, state.currentStepId), handoff = await this.store.latestHandoff(step.id);
    if (!handoff) throw new Error("当前步骤没有 Handoff，不能建立验证证据链。");
    const task = await this.requireTask();
    const coversAcceptanceIds = task.acceptanceCriteria.filter((criterion) => step.acceptanceIds.includes(criterion.id) && criterion.verificationMethod === "command").map((criterion) => criterion.id);
    const { run, log } = await executeApprovedCommand(this.root, command, step.id, handoff.version, coversAcceptanceIds, Number(process.env.CODEGATE_VERIFICATION_TIMEOUT_MS ?? 120_000));
    await this.store.commitArtifacts(`verification:${run.id}`, [
      { relativePath: `verifications/${run.id}.log`, value: log, format: "text", immutable: true },
      { relativePath: `verifications/${run.id}.json`, value: run, immutable: true }
    ], { stepId: run.stepId, command: run.command, status: run.status });
    return run;
  }

  async review(report: ExecutionReport): Promise<ReviewReport> {
    const [task, plan, originalState, architectureDecisions, environment] = await Promise.all([this.requireTask(), this.requirePlan(), this.store.state(), this.store.decisions(), this.store.environment()]);
    if ((originalState.status !== "result-reported" && originalState.status !== "under-review") || originalState.currentStepId !== report.stepId) throw new Error("需先导入当前步骤的执行报告。");
    if (originalState.status === "result-reported") await this.changeState(originalState, { ...originalState, status: "under-review", updatedAt: now() });
    const state = await this.store.state();
    if (this.currentStep(plan, report.stepId).status !== "reported") throw new Error("当前步骤未处于已报告状态。");
    const step = this.currentStep(plan, report.stepId);
    const baseline = await this.store.baseline(report.stepId, report.handoffVersion);
    if (!baseline) throw new Error("缺少对应 Handoff 的 WorkspaceBaseline；不能进行可信审查。");
    const observation = await observeSince(this.root, baseline);
    const revisionMismatch = Boolean(report.workspaceRevisionAfter && observation.headRevision && report.workspaceRevisionAfter !== observation.headRevision);
    const unsafeClaims = report.filesChanged.filter((file) => !isSafeWorkspacePath(this.root, file));
    const claimed = new Set(report.filesChanged.filter((file) => isSafeWorkspacePath(this.root, file)).map(this.normalizePath));
    const actual = new Set(observation.changedFiles.map(this.normalizePath));
    const missing = [...claimed].filter((file) => !actual.has(file)), extra = [...actual].filter((file) => !claimed.has(file));
    const approvedCommands = environment?.status === "confirmed" ? [...new Set([...environment.buildCommands, ...environment.testCommands, ...environment.verificationCommands])] : [];
    const codeGateRuns = await this.store.verificationRuns(report.stepId);
    const verifiedCommands = [] as Array<(typeof codeGateRuns)[number]>;
    for (const run of codeGateRuns.filter((item) => item.handoffVersion === report.handoffVersion && item.status === "passed" && item.exitCode === 0 && approvedCommands.includes(item.command))) {
      const target = path.resolve(this.root, run.outputArtifact), relative = this.normalizePath(path.relative(path.resolve(this.root), target));
      if (!this.isInsideRoot(target) || !relative.startsWith(".codegate/verifications/")) continue;
      try { if (LeaderStore.hash(await readFile(target)) === run.outputHash) verifiedCommands.push(run); } catch { /* Missing or tampered logs are not evidence. */ }
    }
    const commandIsApproved = (command: string) => approvedCommands.includes(command);
    const passed = report.status === "completed" && verifiedCommands.some((command) => commandIsApproved(command.command));
    const evidenceRefs = [baseline.id, `report:${report.reportId}`, ...(observation.diff ? ["workspace-diff"] : []), ...verifiedCommands.map((run) => run.outputArtifact)];
    const outputPaths = report.outputs.map((item) => item.path).filter((item): item is string => Boolean(item));
    const missingOutputs: string[] = [];
    for (const output of report.outputs.filter((item) => item.path)) {
      const outputPath = output.path!;
      if (!isSafeWorkspacePath(this.root, outputPath)) { missingOutputs.push(outputPath + "（路径越界）"); continue; }
      try {
        const content = await readFile(path.resolve(this.root, outputPath));
        if (output.contentHash && LeaderStore.hash(content) !== output.contentHash) missingOutputs.push(outputPath + "（内容哈希不一致）");
      } catch { missingOutputs.push(outputPath); }
    }
    const hasArtifactEvidence = actual.size > 0 || outputPaths.length > 0 || Boolean(report.environmentFacts);
    const cleanEvidence = report.status === "completed" && !missing.length && !extra.length && !unsafeClaims.length && !missingOutputs.length && !revisionMismatch;
    const outputCovers = (field: "coversRequirementIds" | "coversAcceptanceIds" | "coversRubricItemIds", id: string) => report.outputs.some((output) => output[field]?.includes(id));
    const requirementCoverage = task.requirements.filter((item) => step.requirementIds.includes(item.id)).map((item) => {
      const verified = cleanEvidence && hasArtifactEvidence && outputCovers("coversRequirementIds", item.id);
      return { id: item.id, status: verified ? "covered" as const : "unverified" as const, evidence: verified ? evidenceRefs : [], explanation: verified ? "报告输出显式映射该需求，且与基线后的工作区证据一致。" : "没有输出显式声明并证明覆盖该需求。" };
    });
    const acceptanceCoverage = task.acceptanceCriteria.filter((item) => step.acceptanceIds.includes(item.id)).map((criterion) => {
      const verified = criterion.verificationMethod === "command" ? verifiedCommands.some((command) => commandIsApproved(command.command) && command.coversAcceptanceIds?.includes(criterion.id)) : cleanEvidence && hasArtifactEvidence && outputCovers("coversAcceptanceIds", criterion.id);
      return { id: criterion.id, status: verified ? "covered" as const : "unverified" as const, evidence: verified ? evidenceRefs : [], explanation: verified ? "当前验收方式具有可复查证据。" : "当前验收方式没有足够的可复查证据。" };
    });
    const rubricCoverage = task.rubricItems.filter((item) => step.rubricItemIds.includes(item.id)).map((item) => {
      const verified = cleanEvidence && hasArtifactEvidence && outputCovers("coversRubricItemIds", item.id);
      return { id: item.id, status: verified ? "covered" as const : "unverified" as const, evidence: verified ? evidenceRefs : [], explanation: verified ? "报告输出显式映射该评分项，且具有一致证据。" : "评分项尚未获得显式映射的实现与验证证据。" };
    });
    const verificationFindings = [
      ...(!passed && step.verificationInstructions.length ? [{ severity: "error" as const, code: "no-codegate-verification", description: "没有由 CodeGate 执行并校验日志的成功验证命令。Agent 自报命令不作为验收证据。", evidence: [`report:${report.reportId}`] }] : []),
      ...(missingOutputs.length ? [{ severity: "error" as const, code: "missing-output", description: "报告输出不存在或路径不安全：" + missingOutputs.join(", ") + "。", evidence: outputPaths }] : [])
      ,...(revisionMismatch ? [{ severity: "error" as const, code: "revision-mismatch", description: "报告的 workspaceRevisionAfter 与审查时 Git revision 不一致。", evidence: [String(report.workspaceRevisionAfter), String(observation.headRevision)] }] : [])
    ];
    let implementationFindings: NonNullable<ReviewReport["implementationFindings"]> = [
      ...(unsafeClaims.length ? [{ severity: "error" as const, code: "protected-or-unsafe-path", description: "报告包含工作区外或受保护的文件路径：" + unsafeClaims.join(", ") + "。", evidence: unsafeClaims }] : []),
      ...(missing.length ? [{ severity: "error" as const, code: "claimed-file-missing", description: "报告声称的文件未在基线后发生变化：" + missing.join(", ") + "。", evidence: [baseline.id] }] : []),
      ...(extra.length ? [{ severity: "error" as const, code: "unreported-change", description: "基线后存在未报告的工作区变更：" + extra.join(", ") + "。", evidence: [baseline.id, "workspace-diff"] }] : [])
    ];
    let architectureFindings: NonNullable<ReviewReport["architectureFindings"]> = (report.decisionsMade ?? []).filter((item) => item.requiresLeaderReview).map((item) => ({ severity: "warning" as const, code: "agent-decision-review", description: item.description + "；理由：" + item.reason, evidence: architectureDecisions.filter((decision) => decision.status === "accepted").map((decision) => decision.id) }));
    let driftFindings: ReviewReport["driftFindings"] = [
      ...(missing.length ? [{ type: "report-mismatch" as const, description: "报告声称的文件未出现在 Git Diff：" + missing.join(", ") + "。", evidence: ["Git Diff", "report:" + report.reportId] }] : []),
      ...(extra.length ? [{ type: "scope-expansion" as const, description: "Git Diff 含未在报告声明的变更：" + extra.join(", ") + "。", evidence: ["Git Diff", "report:" + report.reportId] }] : []),
      ...(unsafeClaims.length ? [{ type: "architecture-drift" as const, description: "报告触及工作区外或 CodeGate 受保护区域。", evidence: unsafeClaims }] : []),
      ...(revisionMismatch ? [{ type: "report-mismatch" as const, description: "报告的工作区结束 revision 与真实 Git revision 不一致。", evidence: [String(report.workspaceRevisionAfter), String(observation.headRevision)] }] : []),
      ...(report.deviations.length ? [{ type: "goal-drift" as const, description: "Agent 报告了偏离 Handoff 的执行。", evidence: ["report:" + report.reportId] }] : []),
      ...(!passed ? [{ type: "verification-gap" as const, description: "没有可用的成功验证命令与日志证据。", evidence: ["report:" + report.reportId] }] : [])
    ];
    let semanticNeedsUser = false;
    const reviewer = new LeaderModelClient();
    if (reviewer.configured) {
      try {
        const semantic = await reviewer.review(redactForModel({ task: { objective: task.objective, requirements: task.requirements, constraints: task.constraints, nonGoals: task.nonGoals }, step, architectureDecisions: architectureDecisions.filter((item) => item.status === "accepted"), report, workspaceDiff: observation.diff }));
        if (reviewer.lastUsage) await this.store.recordModelUsage(reviewer.lastUsage);
        architectureFindings = [...architectureFindings, ...semantic.architectureFindings];
        implementationFindings = [...implementationFindings, ...semantic.implementationFindings];
        driftFindings = [...driftFindings, ...semantic.driftFindings];
        semanticNeedsUser = semantic.requiresUserDecision;
      } catch (error) {
        await this.store.event("semantic-review-unavailable", { stepId: report.stepId, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const previousReviews = await this.store.reviews(report.stepId);
    const repeatedDrift = driftFindings.some((finding) => previousReviews.filter((review) => review.driftFindings.some((previous) => previous.type === finding.type)).length >= 1);
    const needsUser = extra.length > 0 || report.deviations.length > 0 || architectureFindings.some((item) => item.severity !== "info") || repeatedDrift || semanticNeedsUser;
    const allCovered = [...requirementCoverage, ...acceptanceCoverage, ...rubricCoverage].every((item) => item.status === "covered");
    const semanticErrors = [...architectureFindings, ...implementationFindings].some((item) => item.severity === "error");
    const decision = report.status === "blocked" ? "blocked" as const : needsUser ? "user-decision-required" as const : cleanEvidence && passed && allCovered && !semanticErrors ? "accepted" as const : "revision-required" as const;
    const correctionId = decision === "revision-required" ? "correction-" + Date.now() : undefined;
    const reviewId = "review-" + Date.now();
    const userDecisionRequestId = decision === "user-decision-required" ? "decision-" + Date.now() : undefined;
    const unresolvedItems = [...requirementCoverage, ...acceptanceCoverage, ...rubricCoverage].filter((item) => item.status !== "covered").map((item) => item.id);
    const review: ReviewReport = { id: reviewId, stepId: report.stepId, handoffVersion: report.handoffVersion, decision, summary: decision === "accepted" ? "基线、报告、工作区变化、输出和验证证据支持当前步骤验收。" : decision === "blocked" ? "执行报告显示当前步骤被阻塞。" : "当前步骤未被接受；请处理发现项。", requirementCoverage, acceptanceCoverage, rubricCoverage, architectureFindings, implementationFindings, verificationFindings, driftFindings, evidenceRefs, unresolvedItems, ...(correctionId ? { correctionPatchId: correctionId } : {}), ...(userDecisionRequestId ? { userDecisionRequestId } : {}), generatedAt: now() };
    const reviewArtifact: StoreTransactionEntry = { relativePath: `reviews/${review.id}.json`, value: review, immutable: true };
    if (decision === "accepted") {
      const steps = plan.steps.map((item) => item.id === report.stepId ? { ...item, status: "accepted" as const } : item);
      const next = steps.find((item) => item.status === "pending" && item.dependencyStepIds.every((dependency) => steps.find((candidate) => candidate.id === dependency)?.status === "accepted"));
      if (next) next.status = "ready";
      const nextPlan: WorkPlan = { ...plan, version: plan.version + 1, status: steps.every((item) => item.status === "accepted") ? "completed" : "executing", steps, updatedAt: now() };
      const nextState: LeaderState = { ...state, status: next ? "step-ready" : "task-completed", workPlanVersion: nextPlan.version, currentStepId: next?.id ?? null, updatedAt: now() };
      await this.commitStateful("review-accepted", state, nextState, [reviewArtifact, ...this.planArtifacts(nextPlan), this.reviewPlanPatch(plan, nextPlan, review)]);
    } else if (decision === "revision-required") {
      const nextPlan = this.withStep(plan, report.stepId, "revision-required", "executing");
      const correction: CorrectionPatch = { id: correctionId!, stepId: report.stepId, reviewId: review.id, diagnosis: [...implementationFindings, ...verificationFindings].map((item) => item.description).join("；") || review.summary, mustPreserve: ["已批准 TaskSpec 和架构决策", ...observation.baselineDirtyFiles.map((file) => `交接前已有变更：${file}`)], mustChange: [...new Set([...unresolvedItems.map((id) => `补齐 ${id} 的证据`), ...implementationFindings.map((item) => item.description)])], mustNotChange: task.nonGoals, additionalVerification: ["运行要求的验证命令并附上非空日志", "确保报告文件列表与基线后的实际变化一致"], requiresUserDecision: false, createdAt: now() };
      const nextState: LeaderState = { ...state, status: "correction-ready", workPlanVersion: nextPlan.version, updatedAt: now() };
      await this.commitStateful("review-revision-required", state, nextState, [reviewArtifact, ...this.planArtifacts(nextPlan), { relativePath: `corrections/${correction.id}.json`, value: correction, immutable: true }, this.reviewPlanPatch(plan, nextPlan, review)]);
    } else if (decision === "user-decision-required") {
      const request: UserDecisionRequest = { id: userDecisionRequestId!, kind: repeatedDrift ? "repeated-drift" : architectureFindings.length ? "architecture-change" : extra.length ? "scope-change" : "evidence-conflict", stepId: report.stepId, reviewId: review.id, status: "pending", question: "如何处理本轮未经批准的偏离或证据冲突？", context: [...driftFindings.map((item) => item.description), ...architectureFindings.map((item) => item.description)].join("\n"), options: ["request-correction", "accept-current", "update-plan", "block"], resolution: null, createdAt: now(), resolvedAt: null };
      const nextState: LeaderState = { ...state, status: "user-decision-required", pendingDecisionId: request.id, updatedAt: now() };
      await this.commitStateful("review-user-decision", state, nextState, [reviewArtifact, { relativePath: `decisions/${request.id}.json`, value: request, immutable: true }]);
    } else {
      const nextPlan = this.withStep(plan, report.stepId, "blocked", "executing");
      const nextState: LeaderState = { ...state, status: "blocked", workPlanVersion: nextPlan.version, updatedAt: now() };
      await this.commitStateful("review-blocked", state, nextState, [reviewArtifact, ...this.planArtifacts(nextPlan), this.reviewPlanPatch(plan, nextPlan, review)]);
    }
    return review;
  }

  async correct(agent: Handoff["agentAdapter"]) {
    const state = await this.store.state();
    if (state.status !== "correction-ready" || !state.currentStepId) throw new Error("当前没有待执行的 CorrectionPatch。");
    const correction = await this.store.latestCorrection(state.currentStepId);
    if (!correction) throw new Error("缺少当前步骤的 CorrectionPatch。");
    return (await this.createHandoff(agent, correction)).content;
  }

  async resolveDecision(id: string, resolution: UserDecisionRequest["options"][number]) {
    const [request, state, plan, task] = await Promise.all([this.store.userDecision(id), this.store.state(), this.requirePlan(), this.requireTask()]);
    if (!request || request.status !== "pending" || state.status !== "user-decision-required" || state.pendingDecisionId !== id) throw new Error("当前没有该待处理用户决策。");
    if (!request.options.includes(resolution)) throw new Error("该决策不支持所选处理方式。");
    const resolved: UserDecisionRequest = { ...request, status: "resolved", resolution, resolvedAt: now() };
    const decisionArtifact: StoreTransactionEntry = { relativePath: `decisions/${resolved.id}.json`, value: resolved };
    const step = this.currentStep(plan, request.stepId);
    if (resolution === "accept-current") {
      const steps = plan.steps.map((item) => item.id === step.id ? { ...item, status: "accepted" as const } : item);
      const next = steps.find((item) => item.status === "pending" && item.dependencyStepIds.every((dependency) => steps.find((candidate) => candidate.id === dependency)?.status === "accepted"));
      if (next) next.status = "ready";
      const revised: WorkPlan = { ...plan, version: plan.version + 1, status: next ? "executing" : "completed", steps, updatedAt: now() };
      const nextState: LeaderState = { ...state, status: next ? "step-ready" : "task-completed", workPlanVersion: revised.version, currentStepId: next?.id ?? null, pendingDecisionId: null, updatedAt: now() };
      await this.commitStateful("resolve-decision-accept", state, nextState, [decisionArtifact, ...this.planArtifacts(revised)]);
    } else if (resolution === "request-correction") {
      const review = await this.store.latestReview(step.id);
      if (!review) throw new Error("用户决策缺少对应 Review。");
      const correction: CorrectionPatch = { id: "correction-" + Date.now(), stepId: step.id, reviewId: review.id, diagnosis: request.context, mustPreserve: ["已批准 TaskSpec 和 ArchitectureDecision"], mustChange: ["消除用户决策中确认的偏离或证据冲突"], mustNotChange: task.nonGoals, additionalVerification: ["重新生成与实际工作区一致的报告和验证日志"], requiresUserDecision: false, createdAt: now() };
      const revised = this.withStep(plan, step.id, "revision-required", "executing");
      const nextState: LeaderState = { ...state, status: "correction-ready", workPlanVersion: revised.version, pendingDecisionId: null, updatedAt: now() };
      await this.commitStateful("resolve-decision-correct", state, nextState, [decisionArtifact, { relativePath: `corrections/${correction.id}.json`, value: correction, immutable: true }, ...this.planArtifacts(revised)]);
    } else if (resolution === "update-plan") {
      const revised: WorkPlan = { ...plan, version: plan.version + 1, status: "superseded", risks: [...plan.risks, `用户决策 ${id} 要求重新规划：${request.context}`], updatedAt: now() };
      const nextState: LeaderState = { ...state, status: "architecture-review", workPlanVersion: revised.version, currentStepId: null, pendingDecisionId: null, updatedAt: now() };
      await this.commitStateful("resolve-decision-replan", state, nextState, [decisionArtifact, ...this.planArtifacts(revised)]);
    } else {
      const revised = this.withStep(plan, step.id, "blocked", "executing");
      const nextState: LeaderState = { ...state, status: "blocked", workPlanVersion: revised.version, pendingDecisionId: null, updatedAt: now() };
      await this.commitStateful("resolve-decision-block", state, nextState, [decisionArtifact, ...this.planArtifacts(revised)]);
    }
    return { decision: await this.store.userDecision(id), state: await this.store.state() };
  }

  async reopenTask(reason: string) {
    const [task, state, plan] = await Promise.all([this.requireTask(), this.store.state(), this.store.plan()]);
    if (["new", "intake", "clarification-required"].includes(state.status)) throw new Error("TaskSpec 已处于可修订状态。");
    const revised: TaskSpec = { ...task, version: task.version + 1, assumptions: [...task.assumptions, { id: `change-${task.version + 1}`, description: `任务因以下原因重新打开：${reason}`, status: "confirmed" }], updatedAt: now() };
    const superseded = plan && plan.status !== "completed" && plan.status !== "superseded" ? { ...plan, version: plan.version + 1, status: "superseded" as const, risks: [...plan.risks, `TaskSpec v${revised.version} 已重新打开`], updatedAt: now() } : null;
    const nextState: LeaderState = { ...state, status: "intake", taskSpecVersion: revised.version, workPlanVersion: superseded?.version ?? state.workPlanVersion, currentStepId: null, pendingDecisionId: null, updatedAt: now() };
    await this.commitStateful("reopen-task", state, nextState, [...this.taskArtifacts(revised), ...(superseded ? this.planArtifacts(superseded) : [])]);
    return revised;
  }

  async reopenArchitecture(reason: string) {
    const [state, plan] = await Promise.all([this.store.state(), this.store.plan()]);
    await this.requireTask();
    if (["new", "intake", "clarification-required"].includes(state.status)) throw new Error("需先完成产品定义，才能调整技术架构。");
    if (state.status === "task-spec-ready" || state.status === "architecture-review") return { state, supersededPlan: null };
    const explanation = reason.trim() || "User requested an architecture revision from the Desktop stage history.";
    const superseded = plan && plan.status !== "superseded" ? { ...plan, version: plan.version + 1, status: "superseded" as const, risks: [...plan.risks, `架构因以下原因重新打开：${explanation}`], updatedAt: now() } : null;
    const nextState: LeaderState = { ...state, status: "architecture-review", workPlanVersion: superseded?.version ?? state.workPlanVersion, currentStepId: null, pendingDecisionId: null, updatedAt: now() };
    await this.commitStateful("reopen-architecture", state, nextState, [...(superseded ? this.planArtifacts(superseded) : [])]);
    return { state: nextState, supersededPlan: superseded };
  }

  async approvePlanWithPatch() {
    await this.approvePlan(true);
  }

  async applyPlanPatch(input: PlanPatch, userApproved = false) {
    const patch = planPatchSchema.parse(input);
    const [plan, task, state] = await Promise.all([this.requirePlan(), this.requireTask(), this.store.state()]);
    if (patch.basePlanVersion !== plan.version || patch.targetPlanVersion !== plan.version + 1) throw new Error("PlanPatch 版本必须以当前 Plan 为基线并递增 1。");
    if (patch.requiresUserApproval && !userApproved) throw new Error("该 PlanPatch 需要用户批准后才能应用。");
    let steps = plan.steps.map((step) => ({ ...step, dependencyStepIds: [...step.dependencyStepIds], acceptanceIds: [...step.acceptanceIds] }));
    let risks = [...plan.risks];
    const editable = (stepId: string) => {
      const step = steps.find((item) => item.id === stepId);
      if (!step) throw new Error(`PlanPatch 引用了不存在的步骤：${stepId}。`);
      if (["handed-off", "running", "reported", "under-review", "accepted"].includes(step.status)) throw new Error(`PlanPatch 不能静默修改已开始或已接受步骤：${stepId}。`);
      return step;
    };
    for (const operation of patch.operations) {
      if (operation.type === "add-step") {
        if (!operation.step) throw new Error("add-step 操作缺少 step。");
        if (steps.some((item) => item.id === operation.step!.id)) throw new Error("add-step 不能复用现有 Step ID。");
        steps.push(operation.step);
      } else if (operation.type === "add-risk") {
        if (!operation.risk) throw new Error("add-risk 操作缺少 risk。");
        risks.push(operation.risk);
      } else {
        if (!operation.stepId) throw new Error(`${operation.type} 操作缺少 stepId。`);
        const step = editable(operation.stepId);
        if (operation.type === "adjust-dependencies") {
          if (!operation.dependencyStepIds) throw new Error("adjust-dependencies 操作缺少 dependencyStepIds。");
          step.dependencyStepIds = [...operation.dependencyStepIds];
        } else if (operation.type === "modify-step-objective") {
          if (!operation.objective?.trim()) throw new Error("modify-step-objective 操作缺少 objective。");
          step.objective = operation.objective.trim();
        } else if (operation.type === "add-acceptance-mapping") {
          if (!operation.acceptanceIds?.length) throw new Error("add-acceptance-mapping 操作缺少 acceptanceIds。");
          step.acceptanceIds = [...new Set([...step.acceptanceIds, ...operation.acceptanceIds])];
        } else if (operation.type === "abandon-step") step.status = "abandoned";
        else if (operation.type === "unlock-step") step.status = "ready";
        else if (operation.type === "set-step-status") {
          if (!operation.status) throw new Error("set-step-status 操作缺少 status。");
          step.status = operation.status;
        }
      }
    }
    const revised: WorkPlan = { ...plan, version: patch.targetPlanVersion, stepIds: steps.map((step) => step.id), steps, risks: [...new Set(risks)], updatedAt: now() };
    this.assertPlanValid(task, revised);
    const nextState: LeaderState = { ...state, workPlanVersion: revised.version, updatedAt: now() };
    await this.commitStateful("apply-plan-patch", state, nextState, [...this.planArtifacts(revised), { relativePath: `plan/patches/${patch.id}.json`, value: patch, immutable: true }]);
    return revised;
  }

  async revisePlanFromUi(input: { stepId?: string; objective?: string; risk?: string }) {
    const plan = await this.requirePlan();
    const operations: PlanPatch["operations"] = [];
    if (input.stepId && input.objective?.trim()) operations.push({ type: "modify-step-objective", stepId: input.stepId, description: "User refined the step objective in Desktop.", objective: input.objective.trim() });
    if (input.risk?.trim()) operations.push({ type: "add-risk", description: "User added a plan risk in Desktop.", risk: input.risk.trim() });
    if (!operations.length) throw new Error("请至少填写一个步骤目标或新增风险。");
    const patch: PlanPatch = { id: `desktop-plan-patch-${Date.now()}`, basePlanVersion: plan.version, targetPlanVersion: plan.version + 1, reason: "User approved a Desktop WorkPlan revision.", triggeredBy: "user", operations, affectedStepIds: input.stepId ? [input.stepId] : [], requiresUserApproval: true, createdAt: now() };
    return this.applyPlanPatch(patch, true);
  }
  async reviewWithPatch(report: ExecutionReport) {
    return this.review(report);
  }
  async reviewWithEvidence(report: ExecutionReport) {
    const commandsRun = await Promise.all(report.commandsRun.map(async (command) => {
      if (command.status !== "passed" || !command.outputArtifact) return command.status === "passed" ? { ...command, status: "failed" as const, exitCode: 1 } : command;
      const target = path.resolve(this.root, command.outputArtifact);
      const relative = this.normalizePath(path.relative(path.resolve(this.root), target));
      if (!this.isInsideRoot(target) || !relative.startsWith(".codegate/agent-reports/attachments/")) return { ...command, status: "failed" as const, exitCode: 1 };
      try {
        const content = await readFile(target, "utf8");
        if (!content.trim() || (command.outputHash && LeaderStore.hash(content) !== command.outputHash)) return { ...command, status: "failed" as const, exitCode: 1 };
        return { ...command, outputHash: LeaderStore.hash(content) };
      } catch { return { ...command, status: "failed" as const, exitCode: 1 }; }
    }));
    return this.reviewWithPatch({ ...report, commandsRun });
  }
  async explain() {
    const [task, plan, state, environment, decisions, profile] = await Promise.all([this.requireTask(), this.requirePlan(), this.store.state(), this.store.environment(), this.store.decisions(), this.store.learningProfile()]);
    const step = plan.steps.find((item) => item.id === state.currentStepId) ?? plan.steps[0]!;
    const requirements = task.requirements.filter((item) => step.requirementIds.includes(item.id));
    const latestReview = await this.store.latestReview(step.id);
    if (task.mode === "competition" && task.competition) {
      const metrics = await this.store.competitionMetricRecords(), score = competitionScoreMap(task, plan, metrics), profile = task.competition;
      return ["# 竞赛导师简报", "", `赛题：${profile.challengeTitle}`, `板卡基线：${profile.selectedBoard ?? "尚未确认"}`, `当前冲刺：${step.title}`, "", "## 先理解本步为什么存在", step.rationale, "", "## 本步对应的得分项", "- " + (task.rubricItems.filter((item) => step.rubricItemIds.includes(item.id)).map((item) => item.description).join("\n- ") || "本步建立工具链或最小硬件闭环，不直接记分。"), "", "## 当前得分证据", `已规划 ${score.planned}/${score.total} 项；已有测量记录 ${score.verified}/${score.total} 项。`, "- " + (metrics.slice(-8).map((item) => `${item.label}：${item.value}${item.unit}（${item.context}）`).join("\n- ") || "尚无量化记录；不要用主观描述代替跑分。"), "", "## 必须能解释的工程原理", "- 数据从输入到输出经过哪些模块、时钟域和缓存？", "- 当前最差时序路径是什么，setup/hold 裕量是多少？", "- LUT、DSP、BRAM 与带宽的主要消耗在哪里？", "- 哪些结论来自仿真，哪些来自综合/实现，哪些来自真实上板？", "", "## 本步验证", "- " + (step.verificationInstructions.join("\n- ") || "保留可复查的工具与上板证据。"), "", "## 最近审查", latestReview ? latestReview.summary : "本步骤尚无独立审查。", "", "## 防黑盒检查", "- 能否不用代码逐行复述算法和模块边界？", "- 更换输入或放大数据量时，最先失效的环节是什么？", "- 如果删除本轮优化，基础得分闭环是否仍可恢复？", "", "## 下一步", "完成后保存跑分，并在提交阶段运行答辩演练。"].join("\n");
    }
    return ["# Mentor Brief", "", `面向：${profile?.level ?? "intermediate"} / ${profile?.preferredDepth ?? "standard"}`, "", "## 本步骤在整体中的位置", step.title + "：" + step.objective, "", "整体目标：" + task.objective, "", "## 为什么这样安排", step.rationale, "", "## 相关需求", "- " + (requirements.map((item) => item.id + "：" + item.description).join("\n- ") || "本步骤主要建立后续执行所需事实。"), "", "## 已批准技术边界", "- " + (decisions.filter((item) => item.status === "accepted").map((item) => item.title + "：" + item.decision).join("\n- ") || "暂无；未知内容必须先探索。"), "", "## 当前环境", environment ? `语言：${environment.languages.join(", ") || "Unknown"}；测试：${environment.testCommands.join("；") || "Unknown"}；状态：${environment.status}` : "尚未确认环境事实。", "", "## 如何验证", "- " + (step.verificationInstructions.join("\n- ") || "根据交付物进行人工核对。"), "", "## 最近审查", latestReview ? latestReview.summary + "\n- " + latestReview.driftFindings.map((item) => item.description).join("\n- ") : "尚无本步骤 Review。", "", "## 常见失败模式", "- 把 Agent 的完成声明当作验收结论。", "- 忽略交接前已经存在的工作区修改。", "- 为修复局部问题扩大范围或重写已接受成果。", "", "## 推荐追问", "- 这个步骤的数据流或控制流是什么？", "- 当前方案有哪些替代方案和权衡？", "- 如何手动复现并调试验证失败？"].join("\n");
  }

  private async createHandoff(agent: Handoff["agentAdapter"], correction?: CorrectionPatch): Promise<Handoff> {
    const [task, plan, state, environment, decisions] = await Promise.all([this.requireTask(), this.requirePlan(), this.store.state(), this.store.environment(), this.store.decisions()]);
    this.assertTaskReady(task);
    if ((state.status !== "step-ready" && state.status !== "correction-ready") || !state.currentStepId) throw new Error("当前没有可交接步骤。");
    const step = this.currentStep(plan, state.currentStepId);
    if (step.status !== (correction ? "revision-required" : "ready")) throw new Error("当前步骤状态与交接类型不匹配。");
    const version = await this.store.nextHandoffVersion(step.id), requirements = task.requirements.filter((item) => step.requirementIds.includes(item.id));
    const baseline = await captureBaseline(this.root, step.id, version, now());
    const previousReview = await this.store.latestReview(step.id);
    const skills = new SkillRegistry().select(step.recommendedSkillIds);
    const adapterInstructions = agent === "codex"
      ? "在当前工作区执行。先读取本 Handoff 和相关 .codegate 工件；不要编辑 TaskSpec、Plan 或 Review。"
      : agent === "claude-code"
        ? "在当前工作目录工作。遵守本 Handoff 的范围；完成后按报告契约写入工件，不要改变 Leader 工件。"
        : "将本 Handoff 作为中立执行协议；在目标工作区完成当前步骤并提交结构化报告。";
    const skillMethod = skills.flatMap((skill) => [
      "### " + skill.name + " (" + skill.id + ")",
      "适用理由：" + (step.skillSelections?.find((selection) => selection.skillId === skill.id)?.reason ?? skill.description),
      ...skill.procedure.map((procedure) => "- " + procedure.instruction + " 输出：" + procedure.output),
      "质量门槛：" + skill.qualityGates.join("；")
    ]).join("\n");
    if (step.deliverableIds.length > 0 && environment?.status !== "confirmed") throw new Error("执行实现前必须确认探索步骤报告的环境事实。");
    if (step.deliverableIds.length > 0 && environment?.sourceRevision && baseline.headRevision && environment.sourceRevision !== baseline.headRevision) {
      await this.store.saveEnvironment({ ...environment, revision: environment.revision + 1, status: "stale" });
      throw new Error("已确认环境事实对应的 Git revision 已过期；请重新探索并确认。");
    }
    const environmentSection = environment ? ["", "## Known Environment Facts", "状态：" + environment.status, "语言：" + (environment.languages.join(", ") || "Unknown"), "框架：" + (environment.frameworks.join(", ") || "Unknown"), "构建命令：" + (environment.buildCommands.join("；") || "Unknown"), "测试命令：" + (environment.testCommands.join("；") || "Unknown"), "未知项：" + (environment.unknowns.join("；") || "无")] : [];
    const content = [
      "# CodeGate Handoff: " + step.id + " v" + version, "", "## Agent Adapter\n" + agent + "\n" + adapterInstructions, "",
      "## Task Identity\n" + task.id + " / TaskSpec v" + task.version + " / Plan v" + plan.version, "",
      "## Current Step Objective\n" + step.objective, "",
      "## Relevant Requirements\n- " + requirements.map((item) => item.id + ": " + item.description).join("\n- "), "",
      "## Accepted Architecture Decisions\n- " + (decisions.filter((item) => item.status === "accepted" && (!step.architectureDecisionIds.length || step.architectureDecisionIds.includes(item.id))).map((item) => item.id + ": " + item.decision).join("\n- ") || "无已接受决策；不得自行创建架构事实。"), "",
      "## Scope and Non-Goals\n- 只完成 " + step.id + "；不得扩大范围。\n- " + task.nonGoals.join("\n- "), "",
      "## Required Skills / Method\n" + skillMethod, "",
      ...environmentSection,
      "## Expected Outputs\n- " + step.expectedOutputs.join("\n- "), "",
      "## Verification Requirements\n- " + step.verificationInstructions.join("\n- "), "",
      "## Stop Conditions\n- " + step.stopConditions.join("\n- "),
      "", "## Active Risks\n- " + plan.risks.join("\n- "),
      "", "## Workspace Baseline\n- " + baseline.id + "\n- HEAD: " + (baseline.headRevision ?? "not-a-git-repository") + "\n- 交接前已有未提交文件（必须保留且不会计入本轮成果）：" + (baseline.changedFiles.join(", ") || "无"),
      ...(previousReview ? ["", "## Previous Review", previousReview.summary, ...previousReview.driftFindings.map((item) => "- " + item.type + ": " + item.description)] : []),
      ...(correction ? ["", "## Correction Requirements", "- 诊断：" + correction.diagnosis, "- 必须保留：" + correction.mustPreserve.join("；"), "- 必须修改：" + correction.mustChange.join("；"), "- 不得修改：" + correction.mustNotChange.join("；"), "- 附加验证：" + correction.additionalVerification.join("；")] : []),
      "", "## Execution Report Contract", "按照 .codegate/protocols/execution-report.schema.json 在 .codegate/agent-reports/ 写入结构化报告，且 handoffVersion 必须为 " + version + "；workspaceRevisionBefore 应为 " + (baseline.headRevision ?? "Unknown") + "；每条成功命令必须将日志保存在 .codegate/agent-reports/attachments/，并通过 coversAcceptanceIds 显式映射验收项；每份输出使用 coversRequirementIds、coversAcceptanceIds 和 coversRubricItemIds 声明覆盖关系。没有显式映射的项目不会被验收。报告是声明，不等于验收。"
    ].join("\n");
    const handoff: Handoff = { id: "handoff-" + step.id + "-v" + version, version, stepId: step.id, taskSpecVersion: task.version, workPlanVersion: plan.version, agentAdapter: agent, content, selectedSkillIds: step.recommendedSkillIds, inputRefs: ["task-spec:v" + task.version, "plan:v" + plan.version], createdAt: now() };
    const nextPlan = this.withStep(plan, step.id, "handed-off", "executing");
    const nextState: LeaderState = { ...state, status: "handed-off", workPlanVersion: nextPlan.version, updatedAt: now() };
    assertStateTransition(state.status, nextState.status);
    await this.store.commitArtifacts(`handoff:${step.id}:v${version}`, [
      { relativePath: `baselines/${baseline.stepId}-v${baseline.handoffVersion}.json`, value: baseline, immutable: true },
      { relativePath: `handoffs/${handoff.stepId}-v${handoff.version}.json`, value: handoff, immutable: true },
      { relativePath: `handoffs/${handoff.stepId}-v${handoff.version}.md`, value: handoff.content, format: "text", immutable: true },
      { relativePath: `plan/plan-v${nextPlan.version}.json`, value: nextPlan, immutable: true },
      { relativePath: "plan/plan.json", value: nextPlan },
      { relativePath: "state.json", value: nextState }
    ], { stepId: step.id, handoffVersion: version, planVersion: nextPlan.version, state: nextState.status });
    return handoff;
  }
  private withStep(plan: WorkPlan, stepId: string, status: WorkPlan["steps"][number]["status"], planStatus: WorkPlan["status"]) { return { ...plan, version: plan.version + 1, status: planStatus, steps: plan.steps.map((item) => item.id === stepId ? { ...item, status } : item), updatedAt: now() }; }
  private assertPlanValid(task: TaskSpec, plan: WorkPlan) {
    if (plan.steps.length < 3 || plan.steps.length > 8) throw new Error("WorkPlan 必须包含 3～8 个步骤。");
    const ids = new Set(plan.steps.map((step) => step.id));
    if (ids.size !== plan.steps.length || plan.stepIds.length !== plan.steps.length || plan.stepIds.some((id) => !ids.has(id))) throw new Error("PlanStep ID 必须唯一且与 WorkPlan.stepIds 一致。");
    for (const step of plan.steps) {
      if (step.dependencyStepIds.some((id) => id === step.id || !ids.has(id))) throw new Error("Plan 包含不存在或自引用的步骤依赖。");
      if (step.status === "ready" && step.dependencyStepIds.some((id) => plan.steps.find((candidate) => candidate.id === id)?.status !== "accepted")) throw new Error("依赖尚未全部接受的步骤不能进入 Ready。");
    }
    const visit = (id: string, visiting = new Set<string>(), done = new Set<string>()): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) throw new Error("Plan 不得包含循环依赖。");
      visiting.add(id);
      for (const dependency of this.currentStep(plan, id).dependencyStepIds) visit(dependency, visiting, done);
      visiting.delete(id); done.add(id);
    };
    for (const id of ids) visit(id);
    const mapped = (itemId: string, field: "deliverableIds" | "acceptanceIds" | "rubricItemIds") => plan.steps.some((step) => step.status !== "abandoned" && step[field].includes(itemId));
    if (task.requirements.filter((item) => item.priority === "must").some((item) => !plan.steps.some((step) => step.status !== "abandoned" && step.requirementIds.includes(item.id)))) throw new Error("每个必需 Requirement 必须映射到一个 PlanStep。");
    if (task.deliverables.filter((item) => item.required).some((item) => !mapped(item.id, "deliverableIds"))) throw new Error("每个必需 Deliverable 必须映射到一个 PlanStep。");
    if (task.acceptanceCriteria.filter((item) => item.required).some((item) => !mapped(item.id, "acceptanceIds"))) throw new Error("每个必需验收项必须映射到一个 PlanStep。");
    if (task.rubricItems.filter((item) => item.score !== undefined).some((item) => !mapped(item.id, "rubricItemIds"))) throw new Error("每个有分值的 Rubric Item 必须映射到一个 PlanStep。");
    const knownSkills = new SkillRegistry();
    for (const step of plan.steps) {
      knownSkills.select(step.recommendedSkillIds);
      if (step.requirementIds.some((id) => !task.requirements.some((item) => item.id === id))) throw new Error(`${step.id} 引用了不存在的 Requirement。`);
      if (step.deliverableIds.some((id) => !task.deliverables.some((item) => item.id === id))) throw new Error(`${step.id} 引用了不存在的 Deliverable。`);
      if (step.acceptanceIds.some((id) => !task.acceptanceCriteria.some((item) => item.id === id))) throw new Error(`${step.id} 引用了不存在的 AcceptanceCriterion。`);
      if (step.rubricItemIds.some((id) => !task.rubricItems.some((item) => item.id === id))) throw new Error(`${step.id} 引用了不存在的 RubricItem。`);
    }
  }
  private taskArtifacts(task: TaskSpec): StoreTransactionEntry[] {
    return [
      { relativePath: `task/task-spec-v${task.version}.json`, value: task, immutable: true },
      { relativePath: "task/task-spec.json", value: task }
    ];
  }
  private planArtifacts(plan: WorkPlan): StoreTransactionEntry[] {
    return [
      { relativePath: `plan/plan-v${plan.version}.json`, value: plan, immutable: true },
      { relativePath: "plan/plan.json", value: plan }
    ];
  }
  private environmentArtifacts(facts: ProjectEnvironmentFacts): StoreTransactionEntry[] {
    return [
      { relativePath: `environment/facts-v${facts.revision}.json`, value: facts, immutable: true },
      { relativePath: "environment/current.json", value: facts }
    ];
  }
  private reviewPlanPatch(before: WorkPlan, after: WorkPlan, review: ReviewReport): StoreTransactionEntry {
    const patch: PlanPatch = { id: `review-${review.id}-plan-patch`, basePlanVersion: before.version, targetPlanVersion: after.version, reason: review.summary, triggeredBy: "review", operations: [{ type: "set-step-status", stepId: review.stepId, description: `Apply review decision ${review.decision}.`, status: after.steps.find((step) => step.id === review.stepId)?.status }], affectedStepIds: [review.stepId], requiresUserApproval: false, createdAt: now() };
    const validated = planPatchSchema.parse(patch);
    return { relativePath: `plan/patches/${validated.id}.json`, value: validated, immutable: true };
  }
  private async commitStateful(label: string, current: LeaderState, next: LeaderState, artifacts: StoreTransactionEntry[]) {
    assertStateTransition(current.status, next.status);
    await this.store.commitArtifacts(label, [...artifacts, { relativePath: "state.json", value: next }], { from: current.status, to: next.status });
  }
  private assertTaskReady(task: TaskSpec) {
    const identityIssue = competitionIdentityIssue(task);
    if (identityIssue) throw new Error(`赛题身份未确认：${identityIssue} 禁止生成架构、计划或执行 Prompt。`);
    if (task.mode === "competition" && !task.competition?.selectedBoard) throw new Error("竞赛项目必须由用户确认目标板卡或远程平台后才能继续。");
    if (!task.deliverables.some((item) => item.required)) throw new Error("TaskSpec 至少需要一个必需 Deliverable。");
    if (!task.requirements.length) throw new Error("TaskSpec 至少需要一个可追踪 Requirement。");
    if (!task.acceptanceCriteria.some((item) => item.required)) throw new Error("TaskSpec 至少需要一个必需 AcceptanceCriterion。");
    const groups = [task.deliverables, task.requirements, task.constraints, task.acceptanceCriteria, task.rubricItems];
    for (const group of groups) {
      const ids = group.map((item) => item.id);
      if (new Set(ids).size !== ids.length) throw new Error("TaskSpec 工件 ID 必须唯一。");
      if (group.some((item) => !item.sourcePointers.length)) throw new Error("每个任务事实必须保留 SourcePointer。");
    }
  }
  private currentStep(plan: WorkPlan, stepId: string) { const step = plan.steps.find((item) => item.id === stepId); if (!step) throw new Error("当前步骤丢失。"); return step; }
  private async requireTask() { const task = await this.store.task(); if (!task) throw new Error("缺少 TaskSpec。"); return task; }
  private async requirePlan() { const plan = await this.store.plan(); if (!plan) throw new Error("缺少 WorkPlan。"); return plan; }
  private normalizePath = (value: string) => value.replaceAll("\\", "/");
  private isInsideRoot(candidate: string) { const relative = path.relative(path.resolve(this.root), candidate); return relative && !relative.startsWith("..") && !path.isAbsolute(relative); }
  private async changeState(current: LeaderState, next: LeaderState) { assertStateTransition(current.status, next.status); await this.store.setState(next); }
}

function redactSensitiveText(value: string) {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED TOKEN]")
    .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|client[_-]?secret)\s*[:=]\s*)[^\s,;"']+/gi, "$1[REDACTED]");
}

export function redactForModel(value: unknown) {
  const sensitiveKey = /^(?:api[_-]?key|access[_-]?token|authorization|password|private[_-]?key|client[_-]?secret)$/i;
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") return redactSensitiveText(item);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, sensitiveKey.test(key) ? "[REDACTED]" : walk(child)]));
    return item;
  };
  return JSON.stringify(walk(value), null, 2);
}
