import path from "node:path";
import { LeaderStore } from "./store.js";
import type { SourcePointer, TaskSpec } from "./schemas.js";

type SourceType = SourcePointer["sourceType"];
type Candidate = { text: string; line: number; section: string };

const clean = (value: string) => value.replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s*|#{1,6}\s*)/, "").trim();
const unique = (items: Candidate[]) => [...new Map(items.filter((item) => item.text).map((item) => [item.text.toLowerCase(), item])).values()];
const matches = (value: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(value));

export function buildTaskSpec(file: string, text: string, sourceType: SourceType, now: string, lineLocators?: string[], sourceId = "task-file"): TaskSpec {
  const rawLines = text.split(/\r?\n/);
  const candidates: Candidate[] = [];
  let section = "overview";
  rawLines.forEach((raw, index) => {
    const value = clean(raw);
    if (!value) return;
    if (/^#{1,6}\s+/.test(raw) || /[:：]$/.test(value)) { section = value.replace(/[:：]$/, "").toLowerCase(); return; }
    candidates.push({ text: value, line: index + 1, section });
  });
  if (!candidates.length) throw new Error("任务资料没有可提取的文本内容。");

  const deliverablePatterns = [/交付|产出|deliverable|output|提交|构建|创建|实现|build|create|implement/i];
  const requirementPatterns = [/需求|要求|功能|目标|必须|应当|需要|requirement|must|should|feature/i];
  const constraintPatterns = [/约束|限制|不得|禁止|只能|不允许|constraint|must not|without/i];
  const acceptancePatterns = [/验收|验证|测试|通过|完成标准|acceptance|verify|test|pass/i];
  const assumptionPatterns = [/假设|假定|预计|assume|assuming/i];
  const questionPatterns = [/\?$|？$|待确认|不确定|unknown|tbd|which |what |whether /i];

  const inSection = (candidate: Candidate, patterns: RegExp[]) => matches(candidate.section, patterns);
  const questions = unique(candidates.filter((item) => matches(item.text, questionPatterns)));
  const constraints = unique(candidates.filter((item) => inSection(item, constraintPatterns) || matches(item.text, constraintPatterns)));
  const acceptance = unique(candidates.filter((item) => inSection(item, acceptancePatterns) || matches(item.text, acceptancePatterns)));
  const deliverables = unique(candidates.filter((item) => inSection(item, deliverablePatterns) || matches(item.text, deliverablePatterns)).filter((item) => !constraints.includes(item) && !acceptance.includes(item)));
  const requirements = unique(candidates.filter((item) => inSection(item, requirementPatterns) || matches(item.text, requirementPatterns)).filter((item) => !constraints.includes(item) && !acceptance.includes(item) && !questions.includes(item)));
  const assumptions = unique(candidates.filter((item) => inSection(item, assumptionPatterns) || matches(item.text, assumptionPatterns)));

  const objectiveCandidate = candidates.find((item) => !matches(item.text, questionPatterns)) ?? candidates[0]!;
  const objective = objectiveCandidate.text.slice(0, 1000);
  const resolvedDeliverables = deliverables.length ? deliverables.slice(0, 12) : [{ ...objectiveCandidate, text: objective }];
  const resolvedRequirements = requirements.length ? requirements.slice(0, 30) : candidates.filter((item) => !questions.includes(item) && !assumptions.includes(item)).slice(0, 12);
  const locator = file.replaceAll("\\", "/");
  const pointer = (item: Candidate): SourcePointer => ({ sourceId, sourceType, locator: `${locator}#${lineLocators?.[item.line - 1] ?? `L${item.line}`}`, contentHash: LeaderStore.hash(rawLines[item.line - 1] ?? item.text) });
  const requirementRecords = resolvedRequirements.map((item, index) => ({ id: `req-${index + 1}`, description: item.text, priority: matches(item.text, [/必须|must|required|不得|禁止/i]) ? "must" as const : "should" as const, sourcePointers: [pointer(item)] }));
  const deliverableRecords = resolvedDeliverables.map((item, index) => ({ id: `del-${index + 1}`, description: item.text, required: true, sourcePointers: [pointer(item)] }));
  const acceptanceRecords = (acceptance.length ? acceptance.slice(0, 20) : resolvedDeliverables.map((item) => ({ ...item, text: `交付物可被验证：${item.text}` }))).map((item, index) => ({ id: `ac-${index + 1}`, title: item.text.slice(0, 120), description: item.text, required: true, verificationMethod: matches(item.text, [/命令|测试|test|build|lint|编译/i]) ? "command" as const : "artifact-review" as const, expectedEvidence: matches(item.text, [/命令|测试|test|build|lint|编译/i]) ? ["非空命令日志", "退出状态"] : ["交付物", "相关 Git Diff"], sourcePointers: [pointer(item)] }));

  const rubricCandidates = unique(candidates.filter((item) => matches(item.text, [/(?:\d+(?:\.\d+)?\s*(?:分|points?))|评分|rubric|评审标准/i]))).slice(0, 30);
  const scoreOf = (value: string) => Number(value.match(/(\d+(?:\.\d+)?)\s*(?:分|points?)/i)?.[1]);
  const rubricItems = rubricCandidates.map((item, index) => {
    const score = scoreOf(item.text);
    return { id: `rubric-${index + 1}`, description: item.text, ...(Number.isFinite(score) ? { score } : {}), mappedRequirementIds: requirementRecords.map((value) => value.id), mappedDeliverableIds: deliverableRecords.map((value) => value.id), mappedStepIds: [], status: "unmapped" as const, sourcePointers: [pointer(item)] };
  });

  return {
    id: `task-${Date.now()}`, version: 1, title: path.basename(file), objective, mode: "product",
    deliverables: deliverableRecords, requirements: requirementRecords,
    constraints: constraints.slice(0, 20).map((item, index) => ({ id: `constraint-${index + 1}`, description: item.text, hard: matches(item.text, [/不得|禁止|必须|must/i]), sourcePointers: [pointer(item)] })),
    nonGoals: [], assumptions: assumptions.slice(0, 20).map((item, index) => ({ id: `assumption-${index + 1}`, description: item.text, status: "unconfirmed" as const })),
    openQuestions: questions.slice(0, 20).map((item, index) => ({ id: `question-${index + 1}`, question: item.text, impact: "该问题可能改变范围、架构或验收方式。", blocking: matches(item.text, [/待确认|必须|which|whether|不确定/i]), answer: null })),
    acceptanceCriteria: acceptanceRecords, rubricItems, sourceMaterialIds: [sourceId], createdAt: now, updatedAt: now
  };
}

export type ProjectIdeaInput = {
  projectName: string;
  idea: string;
  targetUsers?: string;
  platform?: string;
  constraints?: string;
};

/**
 * Creates a traceable first TaskSpec without requiring a source document.
 * Missing product facts deliberately become blocking discovery questions so
 * an enthusiastic one-line idea cannot be mistaken for an approved scope.
 */
export function buildTaskSpecFromIdea(input: ProjectIdeaInput, createdAt: string): TaskSpec {
  const projectName = input.projectName.trim();
  const idea = input.idea.trim();
  if (!projectName) throw new Error("项目名称不能为空。");
  if (idea.length < 8) throw new Error("请至少用一句完整的话描述产品想法（不少于 8 个字符）。");
  const sourceId = "project-idea";
  const pointer = (field: string, content: string): SourcePointer => ({
    sourceId,
    sourceType: "user-message",
    locator: `onboarding/${field}`,
    contentHash: LeaderStore.hash(content)
  });
  const users = input.targetUsers?.trim();
  const platform = input.platform?.trim();
  const constraints = input.constraints?.trim();
  const questions: TaskSpec["openQuestions"] = [
    ...(!users ? [{ id: "discovery-users", question: "这个产品主要服务谁？请描述最重要的一类用户及其使用场景。", impact: "目标用户决定功能优先级、交互复杂度和验收方式。", blocking: true, answer: null }] : []),
    { id: "discovery-mvp", question: "首个可盈利或可验证的版本必须包含哪些核心功能？哪些功能可以暂缓？", impact: "明确 MVP 边界可以避免范围膨胀，并形成可执行的第一版计划。", blocking: true, answer: null },
    ...(!platform ? [{ id: "discovery-platform", question: "产品需要运行在哪里？例如 Windows 桌面、Web、移动端或服务端。", impact: "运行平台直接影响技术栈、打包方式和验证环境。", blocking: true, answer: null }] : []),
    { id: "discovery-data", question: "产品需要保存哪些数据？是否涉及账号、支付、隐私、联网或第三方服务？", impact: "数据和外部服务决定安全边界、成本及商业化基础设施。", blocking: true, answer: null },
    { id: "discovery-success", question: "第一版达到什么可观察结果才算成功？请给出可以检查的完成标准。", impact: "可观察的成功标准会转换为验收条件和验证证据。", blocking: true, answer: null },
    ...(!constraints ? [{ id: "discovery-constraints", question: "是否有预算、期限、技术栈、兼容性或不能改变的限制？没有可以回答“暂无”。", impact: "限制条件会影响架构取舍和实施顺序。", blocking: false, answer: null }] : [])
  ];
  const requirements: TaskSpec["requirements"] = [
    { id: "req-core-goal", description: `产品必须实现核心目标：${idea}`, priority: "must", sourcePointers: [pointer("idea", idea)] },
    ...(users ? [{ id: "req-target-users", description: `产品主要面向：${users}`, priority: "must" as const, sourcePointers: [pointer("target-users", users)] }] : [])
  ];
  const deliverables: TaskSpec["deliverables"] = [{ id: "del-mvp", description: `${projectName} 的可运行、可验证首个版本`, required: true, sourcePointers: [pointer("idea", idea)] }];
  const acceptanceCriteria: TaskSpec["acceptanceCriteria"] = [{ id: "ac-core-goal", title: "核心产品目标可被验证", description: `存在可运行交付物，并有证据证明其实现：${idea}`, required: true, verificationMethod: "artifact-review", expectedEvidence: ["可运行交付物", "功能验证记录", "相关代码变更"], sourcePointers: [pointer("idea", idea)] }];
  return {
    id: `task-${Date.now()}`,
    version: 1,
    title: projectName,
    mode: "product",
    objective: idea,
    deliverables,
    requirements,
    constraints: [
      ...(platform ? [{ id: "constraint-platform", description: `目标运行平台：${platform}`, hard: true, sourcePointers: [pointer("platform", platform)] }] : []),
      ...(constraints ? [{ id: "constraint-user", description: constraints, hard: true, sourcePointers: [pointer("constraints", constraints)] }] : [])
    ],
    nonGoals: [],
    assumptions: [],
    openQuestions: questions,
    acceptanceCriteria,
    rubricItems: [],
    sourceMaterialIds: [sourceId],
    createdAt,
    updatedAt: createdAt
  };
}
