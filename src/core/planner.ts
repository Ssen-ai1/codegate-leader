import type { ArchitectureDecision, ProjectEnvironmentFacts, TaskSpec, WorkPlan } from "./schemas.js";

const tokens = (value: string) => new Set(value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((item) => item.length > 1));
const overlap = (left: string, right: string) => {
  const a = tokens(left), b = tokens(right);
  return [...a].filter((item) => b.has(item)).length;
};

export function buildDynamicPlan(task: TaskSpec, decisions: ArchitectureDecision[], environment: ProjectEnvironmentFacts | null, timestamp: string): WorkPlan {
  if (task.mode === "competition" && task.competition) return buildCompetitionPlan(task, decisions, environment, timestamp);
  const deliverables = task.deliverables.filter((item) => item.required).slice(0, 5);
  const implementationTargets = deliverables.length ? deliverables : [{ id: "del-task", description: task.objective, required: true, sourcePointers: [] }];
  const architectureDecisionIds = decisions.filter((item) => item.status === "accepted").map((item) => item.id);
  const exploration = {
    id: "step-001", title: environment?.status === "confirmed" ? "复核工作区事实" : "探索并确认工作区事实",
    objective: "确认代码库边界、当前 Git 基线、入口、构建命令、测试命令和仍未知的环境事实。",
    rationale: "计划中的实现约束必须建立在可复查的工作区事实上。", dependencyStepIds: [], requirementIds: [], deliverableIds: [], acceptanceIds: [], rubricItemIds: [], architectureDecisionIds,
    recommendedSkillIds: ["architecture-design", "implementation-handoff"], skillSelections: [
      { skillId: "architecture-design", reason: "当前步骤需要把未知仓库信息转化为待确认环境事实。" },
      { skillId: "implementation-handoff", reason: "探索结果必须按结构化报告契约交回。" }
    ], expectedInputs: ["TaskSpec", "已接受的 ArchitectureDecision", "当前工作区"], expectedOutputs: ["ProjectEnvironmentFacts", "工作区基线说明"],
    verificationInstructions: ["报告实际发现的构建、测试或验证命令，并为已运行命令保存日志"], stopConditions: ["发现与已批准架构或任务范围冲突的事实时停止并报告"], status: "ready" as const
  };

  const implementation = implementationTargets.map((deliverable, index) => {
    const requirementMatches = task.requirements.filter((item) => overlap(item.description, deliverable.description) > 0);
    const requirementIds = (requirementMatches.length ? requirementMatches : implementationTargets.length === 1 ? task.requirements : task.requirements.filter((_item, requirementIndex) => requirementIndex % implementationTargets.length === index)).map((item) => item.id);
    const acceptanceMatches = task.acceptanceCriteria.filter((item) => overlap(item.description, deliverable.description) > 0);
    const rubricIds = task.rubricItems.filter((item) => item.mappedDeliverableIds.includes(deliverable.id) || item.mappedRequirementIds.some((id) => requirementIds.includes(id))).map((item) => item.id);
    const algorithmic = /算法|复杂度|性能|排序|搜索|优化|algorithm|performance/i.test(deliverable.description + " " + requirementMatches.map((item) => item.description).join(" "));
    const skillIds = ["implementation-handoff", "test-strategy", ...(algorithmic ? ["algorithm-analysis"] : [])];
    return {
      id: `step-${String(index + 2).padStart(3, "0")}`, title: `实现交付物：${deliverable.description.slice(0, 80)}`,
      objective: deliverable.description, rationale: "按独立交付物组织执行可以保持范围清晰，并让证据与需求逐项对应。",
      dependencyStepIds: [index === 0 ? exploration.id : `step-${String(index + 1).padStart(3, "0")}`], requirementIds, deliverableIds: [deliverable.id], acceptanceIds: acceptanceMatches.map((item) => item.id), rubricItemIds: rubricIds, architectureDecisionIds,
      recommendedSkillIds: skillIds, skillSelections: skillIds.map((skillId) => ({ skillId, reason: skillId === "test-strategy" ? "该交付物需要独立、可留存的验收证据。" : skillId === "algorithm-analysis" ? "需求包含算法或性能风险。" : "该步骤需要受边界约束的实现交接。" })),
      expectedInputs: ["已确认的环境事实", deliverable.id, ...requirementIds], expectedOutputs: [deliverable.description, "对应的实现 Diff", "验证日志"],
      verificationInstructions: acceptanceMatches.length ? acceptanceMatches.map((item) => item.description) : ["运行与本交付物相关的最小充分验证，并保存非空日志"],
      stopConditions: ["需要改变 TaskSpec、已批准架构、依赖或验收标准时停止", "发现与当前交付物无关的重构需求时停止"], status: "pending" as const
    };
  });

  const finalId = `step-${String(implementation.length + 2).padStart(3, "0")}`;
  const mappedAcceptance = new Set(implementation.flatMap((step) => step.acceptanceIds));
  const finalStep = {
    id: finalId, title: "集成验证与交付物核对", objective: "运行任务级验证，核对所有交付物、必需需求、验收项和评分项。",
    rationale: "逐步骤通过不代表组合后的最终交付已经满足任务级标准。", dependencyStepIds: [implementation.at(-1)?.id ?? exploration.id],
    requirementIds: task.requirements.filter((item) => item.priority === "must").map((item) => item.id), deliverableIds: task.deliverables.filter((item) => item.required).map((item) => item.id),
    acceptanceIds: task.acceptanceCriteria.filter((item) => item.required && !mappedAcceptance.has(item.id)).map((item) => item.id), rubricItemIds: task.rubricItems.map((item) => item.id), architectureDecisionIds,
    recommendedSkillIds: ["test-strategy", "code-and-result-review"], skillSelections: [
      { skillId: "test-strategy", reason: "需要形成任务级验证矩阵与日志。" }, { skillId: "code-and-result-review", reason: "需要在交付前核对覆盖映射和实际产物。" }
    ], expectedInputs: ["所有已接受实现步骤", "TaskSpec 验收矩阵", "Rubric Matrix"], expectedOutputs: ["任务级验证日志", "最终交付物清单"],
    verificationInstructions: task.acceptanceCriteria.map((item) => item.description), stopConditions: ["任一必需验收项缺少证据时不得声明完成"], status: "pending" as const
  };
  const steps = [exploration, ...implementation, finalStep];
  return {
    id: `plan-${task.id}`, version: 1, taskSpecVersion: task.version,
    summary: `按工作区探索、${implementation.length} 个交付物步骤和任务级集成验证推进。`, stepIds: steps.map((step) => step.id), status: "draft", steps,
    risks: ["环境事实可能在执行期间过期", "执行报告可能与真实工作区不一致", ...task.assumptions.filter((item) => item.status === "unconfirmed").map((item) => `未确认假设：${item.description}`)], createdAt: timestamp, updatedAt: timestamp
  };
}

function buildCompetitionPlan(task: TaskSpec, decisions: ArchitectureDecision[], environment: ProjectEnvironmentFacts | null, timestamp: string): WorkPlan {
  const profile = task.competition!, architectureDecisionIds = decisions.filter((item) => item.status === "accepted").map((item) => item.id);
  const basicRequirements = task.requirements.filter((item) => item.id.startsWith("req-basic"));
  const advancedRequirements = task.requirements.filter((item) => item.id.startsWith("req-advanced"));
  const basicAcceptance = task.acceptanceCriteria.filter((item) => item.id.startsWith("ac-basic"));
  const metricAcceptance = task.acceptanceCriteria.filter((item) => item.id.startsWith("ac-metric"));
  const basicRubrics = task.rubricItems.filter((item) => item.id.startsWith("rubric-basic"));
  const advancedRubrics = task.rubricItems.filter((item) => item.id.startsWith("rubric-advanced"));
  const metricRubrics = task.rubricItems.filter((item) => item.id.startsWith("rubric-metric"));
  const common = { architectureDecisionIds, expectedInputs: ["赛题得分地图", "已确认实现路线"], stopConditions: ["需要猜测板卡引脚、时钟、器件或 IP 参数时停止", "发现赛题原文与当前路线冲突时停止并报告"] };
  const steps: WorkPlan["steps"] = [
    {
      ...common, id: "step-001", title: environment?.status === "confirmed" ? "复核板卡与工具链" : "锁定板卡并跑通工具链", objective: `确认 ${profile.selectedBoard ?? "目标板卡/远程平台"}、器件型号、PDS/编译工具、下载链路和可执行验证命令。`, rationale: "FPGA 竞赛不能在未知器件、约束或工具版本上直接生成实现。", dependencyStepIds: [], requirementIds: [], deliverableIds: [], acceptanceIds: [], rubricItemIds: [], recommendedSkillIds: ["architecture-design", "implementation-handoff"], skillSelections: [{ skillId: "architecture-design", reason: "把板卡、时钟、接口和工具版本固化为可确认环境事实。" }, { skillId: "implementation-handoff", reason: "探索结果必须按结构化环境报告交回。" }], expectedOutputs: ["确认的器件/板卡 Profile", "工具链版本与最小工程结果", "构建、仿真、实现和下载命令"], verificationInstructions: ["至少保存一次空工程或官方示例的编译/下载结果", "所有引脚和时钟来源必须指向官方资料"], status: "ready"
    },
    {
      ...common, id: "step-002", title: "建立最小硬件闭环", objective: "在目标板卡上完成最小可观测链路，例如时钟复位、点灯/UART、视频回环或最小 CPU 程序。", rationale: "先证明板卡、约束、时钟和下载链路可用，再进入复杂算法可以显著降低调试成本。", dependencyStepIds: ["step-001"], requirementIds: basicRequirements.slice(0, 1).map((item) => item.id), deliverableIds: task.deliverables.slice(0, 1).map((item) => item.id), acceptanceIds: basicAcceptance.slice(0, 1).map((item) => item.id), rubricItemIds: basicRubrics.slice(0, 1).map((item) => item.id), recommendedSkillIds: ["implementation-handoff", "test-strategy", "root-cause-debugging"], skillSelections: [{ skillId: "implementation-handoff", reason: "限定本轮只形成最小硬件闭环。" }, { skillId: "test-strategy", reason: "需要保存仿真与上板两类证据。" }, { skillId: "root-cause-debugging", reason: "首次上板最容易暴露时钟、复位、约束和接口问题。" }], expectedOutputs: ["最小闭环工程", "上板现象或可信远程平台证据", "已知问题清单"], verificationInstructions: ["保存一次可重复的编译、实现与下载记录", "使用 LED、UART、ILA 或视频输出提供可观察结果"], status: "pending"
    },
    {
      ...common, id: "step-003", title: "完成基础得分项", objective: `逐项完成赛题基础任务：${profile.basicTasks.join("；") || task.objective}`, rationale: "先形成稳定基础分，再把剩余时间投入高阶功能和性能优化。", dependencyStepIds: ["step-002"], requirementIds: basicRequirements.map((item) => item.id), deliverableIds: task.deliverables.slice(0, 1).map((item) => item.id), acceptanceIds: basicAcceptance.map((item) => item.id), rubricItemIds: basicRubrics.map((item) => item.id), recommendedSkillIds: ["implementation-handoff", "test-strategy", "code-and-result-review"], skillSelections: [{ skillId: "implementation-handoff", reason: "基础任务需要按模块和验收点逐项实现。" }, { skillId: "test-strategy", reason: "每个基础得分项都需要独立证据。" }, { skillId: "code-and-result-review", reason: "避免功能表面可见但时序或工程规范不合格。" }], expectedOutputs: ["基础任务完整工程", "每项基础功能的仿真/上板证据", "模块接口说明"], verificationInstructions: basicAcceptance.map((item) => item.description), status: "pending"
    },
    {
      ...common, id: "step-004", title: "性能与高阶冲刺", objective: `在基础闭环稳定后优化量化指标，并按风险选择高阶任务：${profile.advancedTasks.join("；") || "优化性能、资源和鲁棒性"}`, rationale: "比赛优化必须以已记录基线为起点，一次只改变一个瓶颈并比较收益与资源代价。", dependencyStepIds: ["step-003"], requirementIds: advancedRequirements.map((item) => item.id), deliverableIds: [], acceptanceIds: metricAcceptance.map((item) => item.id), rubricItemIds: [...advancedRubrics, ...metricRubrics].map((item) => item.id), recommendedSkillIds: ["algorithm-analysis", "test-strategy", "root-cause-debugging"], skillSelections: [{ skillId: "algorithm-analysis", reason: "需要解释流水线、定点化、缓存或图像算法的性能/资源权衡。" }, { skillId: "test-strategy", reason: "每次优化必须与同一输入和测试参数下的基线比较。" }, { skillId: "root-cause-debugging", reason: "时序、资源和性能问题需要基于报告定位瓶颈。" }], expectedOutputs: ["可比较的跑分/时序/资源记录", "高阶功能及其风险说明", "优化前后差异"], verificationInstructions: profile.metrics.map((item) => `${item.label}${item.target ? `；目标 ${item.target}` : ""}`), status: "pending"
    },
    {
      ...common, id: "step-005", title: "现场鲁棒性与得分核对", objective: "用未参与开发的输入和现场变化条件验证系统，逐项核对得分地图与证据缺口。", rationale: "固定演示通过不能证明现场换数据、换角度或长时间运行仍然可靠。", dependencyStepIds: ["step-004"], requirementIds: task.requirements.map((item) => item.id), deliverableIds: task.deliverables.slice(0, 1).map((item) => item.id), acceptanceIds: task.acceptanceCriteria.map((item) => item.id), rubricItemIds: task.rubricItems.map((item) => item.id), recommendedSkillIds: ["test-strategy", "code-and-result-review"], skillSelections: [{ skillId: "test-strategy", reason: "需要覆盖现场数据、边界条件和长时间稳定性。" }, { skillId: "code-and-result-review", reason: "用真实证据核对全部得分项。" }], expectedOutputs: ["现场条件测试记录", "完整得分地图", "剩余风险与保底方案"], verificationInstructions: [...profile.demoRequirements, ...task.acceptanceCriteria.map((item) => item.description)], status: "pending"
    },
    {
      ...common, id: "step-006", title: "提交材料与答辩演练", objective: "冻结可演示版本，完成源码、报告、波形、视频和答辩材料，并进行评委追问演练。", rationale: "竞赛交付包含工程、证据和表达，功能完成不等于提交完整。", dependencyStepIds: ["step-005"], requirementIds: task.requirements.filter((item) => item.priority === "must").map((item) => item.id), deliverableIds: task.deliverables.map((item) => item.id), acceptanceIds: task.acceptanceCriteria.map((item) => item.id), rubricItemIds: task.rubricItems.map((item) => item.id), recommendedSkillIds: ["technical-mentor", "code-and-result-review"], skillSelections: [{ skillId: "technical-mentor", reason: "帮助团队解释架构、算法、时序、资源与失败边界。" }, { skillId: "code-and-result-review", reason: "提交前核对源码、报告、视频和指标一致性。" }], expectedOutputs: [...profile.submissionItems, "答辩问题与薄弱项清单", "最终提交检查表"], verificationInstructions: ["所有提交材料可打开且版本一致", "报告中的指标能够回溯到原始证据", "团队成员能够解释关键模块和主要权衡"], status: "pending"
    }
  ];
  return { id: `plan-${task.id}`, version: 1, taskSpecVersion: task.version, summary: `按板卡与工具链、最小闭环、基础得分、性能冲刺、现场核对和提交答辩六阶段推进“${profile.challengeTitle}”。`, stepIds: steps.map((step) => step.id), status: "draft", steps, risks: [...profile.risks, ...task.assumptions.filter((item) => item.status === "unconfirmed").map((item) => `未确认假设：${item.description}`)], createdAt: timestamp, updatedAt: timestamp };
}
