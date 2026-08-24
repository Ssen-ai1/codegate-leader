import { skillManifestSchema, type SkillManifest } from "./schemas.js";

const manifest = (value: SkillManifest) => skillManifestSchema.parse(value);
const standard = (id: string, name: string, description: string, applicableWhen: string[], procedure: Array<[string, string, string]>, qualityGates: string[], antiPatterns: string[] = []): SkillManifest => manifest({
  id, version: "1.0.0", name, description, applicableWhen, incompatibleWhen: [], requiredInputs: ["TaskSpec", "Current PlanStep"], optionalInputs: ["Architecture decisions", "Execution report", "Git Diff"],
  procedure: procedure.map(([stepId, instruction, output]) => ({ id: stepId, instruction, output })), qualityGates, antiPatterns, outputContract: { report: "structured ExecutionReport or ReviewReport" }, promptFragments: {}
});

export const builtInSkills: SkillManifest[] = [
  standard("task-clarification", "任务澄清", "把原始资料中的事实、假设和阻塞问题分开。", ["任务存在歧义或缺少边界"], [["identify", "列出事实、假设和问题，不把推断写成事实。", "可确认的 TaskSpec 修订"], ["block", "标注阻塞问题及其影响。", "待用户回答的问题清单"]], ["每个重要事实有来源", "阻塞问题未回答不得批准"], ["以猜测代替用户确认"]),
  standard("source-and-rubric-analysis", "资料与评分分析", "将资料、需求、交付物和评分项建立可追踪映射。", ["输入含赛题、评分标准或多个资料文件"], [["extract", "提取原文需求和评分项并附 SourcePointer。", "需求/评分项列表"], ["map", "映射到交付物、验收项和计划步骤。", "Rubric Matrix"]], ["有分值评分项均有步骤映射", "建议性内容不升级为硬约束"]),
  standard("architecture-design", "架构设计", "先探索环境事实，再给出可追踪的技术边界与取舍。", ["需要确认模块边界或技术方案"], [["inspect", "探索工作区，记录语言、入口、构建与测试命令。", "环境事实"], ["decide", "比较可行方案，记录已接受决策及后果。", "ArchitectureDecision"]], ["未知事实明确标 Unknown", "不静默改写已批准决策"]),
  standard("algorithm-analysis", "算法分析", "在实现前说明关键算法、复杂度与验证案例。", ["步骤包含算法、性能或正确性风险"], [["model", "说明输入、输出、不变量和边界案例。", "算法模型"], ["validate", "给出复杂度和最小验证集。", "验证计划"]], ["复杂度结论可由输入规模解释"], ["只给代码不给不变量"]),
  standard("implementation-handoff", "实现交接", "将当前唯一步骤编译为可执行、可停止和可报告的交接。", ["向 Coding Agent 交接实现或探索步骤"], [["bound", "只处理当前步骤及相关需求。", "明确 Scope"], ["report", "记录实际文件、命令日志、风险和偏离。", "ExecutionReport"]], ["不扩大范围", "每条成功命令有日志附件"], ["把完整聊天历史当作指令"]),
  standard("test-strategy", "测试策略", "从验收项推导最小而充分的验证命令与证据。", ["步骤需要实现验证"], [["derive", "为每个验收项选择命令、产物或人工检查。", "验证矩阵"], ["execute", "运行相关命令并保留非空日志。", "可审查证据"]], ["失败和未运行必须如实报告"], ["把未运行测试写为通过"]),
  standard("code-and-result-review", "代码与结果审查", "独立交叉检查报告、Git Diff、日志和验收覆盖。", ["导入 ExecutionReport 后"], [["compare", "比较报告文件与实际 Diff。", "不一致发现"], ["accept", "只有证据覆盖时接受，否则生成最小纠偏。", "ReviewReport"]], ["Agent Claim 不等于 Acceptance"], ["只根据报告文本验收"]),
  standard("root-cause-debugging", "根因调试", "以复现、证据和最小修改定位失败根因。", ["Review 需要纠偏或验证失败"], [["reproduce", "确认失败命令、日志和范围。", "可复现症状"], ["correct", "只修改导致问题的最小范围，并重新验证。", "Correction evidence"]], ["保留已接受成果", "连续同类偏航升级用户决策"], ["重写整个计划"]),
  standard("technical-mentor", "技术导师", "向用户解释当前步骤的位置、概念、取舍、验证和常见误区。", ["用户请求解释或步骤审查后"], [["context", "说明此步骤与架构和目标的关系。", "整体位置说明"], ["teach", "解释核心概念、替代方案和调试路径。", "Mentor Brief"]], ["不得改变执行 Scope"], ["把教学内容混入 Agent 指令"])
];

export class SkillRegistry {
  private readonly byId = new Map(builtInSkills.map((item) => [item.id, item]));
  get(id: string) { return this.byId.get(id) ?? null; }
  select(ids: string[]) {
    const manifests = ids.map((id) => this.get(id)).filter((item): item is SkillManifest => item !== null);
    const missing = ids.filter((id) => !this.byId.has(id));
    if (missing.length) throw new Error("Plan 引用了不存在的 Skill：" + missing.join(", "));
    return manifests;
  }
}
