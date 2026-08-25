import { LeaderStore } from "./store.js";
import type { CompetitionDebugSession, CompetitionDefenseSession, CompetitionMetricRecord, CompetitionProfile, SourcePointer, TaskSpec, WorkPlan } from "./schemas.js";

const clean = (value: string) => value.replace(/^\s*(?:[-*+●⚫•]\s*|\d+[.)、]\s*)/, "").replace(/\s+/g, " ").trim();
const unique = (values: string[]) => [...new Set(values.map(clean).filter((value) => value.length >= 2))];
const numbered = (value: string) => unique(value.split(/\r?\n/).filter((line) => /^\s*\d+[.)、]/.test(line)).map(clean));
const section = (value: string, start: RegExp, ends: RegExp[]) => {
  const match = start.exec(value);
  if (!match) return "";
  const rest = value.slice(match.index + match[0].length);
  const offsets = ends.map((pattern) => pattern.exec(rest)?.index).filter((offset): offset is number => offset !== undefined);
  return rest.slice(0, offsets.length ? Math.min(...offsets) : rest.length);
};

export type CompetitionGuideAnalysis = { contestName: string; track: string; challenges: Array<{ id: string; title: string; category: CompetitionProfile["category"] }>; boards: string[]; toolchains: string[] };

function categoryFor(title: string): CompetitionProfile["category"] {
  if (/2D\s*图形|图形渲染|渲染加速|Blitter|Sprite/i.test(title)) return "fpga-accelerator";
  if (/RISC.?V|指令集|CPU/i.test(title)) return "fpga-cpu";
  if (/畸变|图像|视觉|视频/i.test(title)) return "fpga-vision";
  if (/车牌|识别|AI/i.test(title)) return "fpga-ai";
  if (/SOPC|开放选题/i.test(title)) return "sopc-open";
  if (/嵌入式|FPGA/i.test(title)) return "embedded";
  if (/算法/i.test(title)) return "algorithm";
  return "other";
}

function challengeMatches(text: string) {
  const fixed = /(?:^|\n)\s*[●⚫•]?\s*(?:【\s*)?(?:赛题|选题)\s*([一二三四五六七八九十\d]+)\s*(?:】)?\s*[：:]?\s*([^\n]+)/g;
  const free = /(?:^|\n)\s*[●⚫•]?\s*【\s*自由选题\s*】\s*([^\n]+)/g;
  const candidates = [
    ...[...text.matchAll(fixed)].map((match) => ({ key: `fixed-${match[1]}`, title: clean(match[2]!), index: match.index ?? 0 })),
    ...[...text.matchAll(free)].map((match) => ({ key: "free", title: clean(match[1]!), index: match.index ?? 0 }))
  ].filter((item) => item.title.length >= 4 && !/\.{3,}|…{3,}/.test(item.title));
  const latest = new Map<string, { key: string; title: string; index: number }>();
  for (const item of candidates) latest.set(item.key, item);
  return [...latest.values()].sort((left, right) => left.index - right.index).map((item, index) => ({ id: `challenge-${index + 1}`, title: item.title, category: item.key === "free" ? "sopc-open" as const : categoryFor(item.title), index: item.index }));
}

const knownBoards = ["RK3568_MES2L100H", "MES2L676-100HP", "MES2L676-200HP", "MES2L676-100HP-MINI", "MES2L676-200HP-MINI", "盘古 676", "盘古 50", "MES50HP", "SOPC 开发平板", "PG2L100H", "PG2L200H", "PGL50H", "PG2K100", "Ti60F225 开发板", "VF-Ti60F225 开发板", "Ti60F225I3"];
const knownTools = ["Pango Design Suite", "PDS", "Efinity", "riscv32-unknown-elf-gcc", "CoreMark v1.0", "CoreMark", "OpenCV", "ILA", "Linux", "RTOS", "Verilog", "SystemVerilog"];

export function analyzeCompetitionGuide(text: string): CompetitionGuideAnalysis {
  const challenges = challengeMatches(text);
  const firstTitle = text.split(/\r?\n/).map(clean).find((line) => /竞赛|大赛|比赛/.test(line)) ?? "竞赛项目";
  const track = text.split(/\r?\n/).map(clean).find((line) => /赛道|选题指南/.test(line)) ?? "竞赛赛道";
  return {
    contestName: firstTitle,
    track,
    challenges: challenges.map(({ id, title, category }) => ({ id, title, category })),
    boards: knownBoards.filter((item) => text.toLowerCase().includes(item.toLowerCase())),
    toolchains: knownTools.filter((item) => text.toLowerCase().includes(item.toLowerCase()))
  };
}

function selectedChallengeText(text: string, selectedId: string) {
  const matches = challengeMatches(text);
  if (!matches.length) return text;
  const selected = matches.find((item) => item.id === selectedId) ?? matches[0]!;
  const next = matches.find((item) => item.index > selected.index);
  return text.slice(selected.index, next?.index ?? text.length);
}

function metricCandidates(text: string) {
  const performance = section(text, /四[、.]\s*性能测评标准[^\n]*/i, [/五[、.]\s*参赛注意事项/i, /(?:^|\n)\s*[●⚫•]?\s*选题/i]);
  const metricSource = performance || text;
  const lines = unique(metricSource.split(/\r?\n/).map(clean).filter((line) => /CoreMark|MHz|\bHz\b|LUT|DSP|BRAM|时钟|频率|资源|带宽|延迟|帧率|fps|加速比|Sprite|分辨率|准确率|识别率|MTF50|SFR|时序|违例|实时|清晰度|直线度/i.test(line)));
  return lines.slice(0, 16);
}

function targetOf(label: string) {
  return label.match(/(?:≥|<=|>=|不低于|小于|低于|达到)\s*([\d.]+\s*%?|\d+P@\d+fps|\d+fps)/i)?.[0]
    ?? label.match(/\d+P@\d+(?:fps)?/i)?.[0]
    ?? label.match(/\d+(?:\.\d+)?\s*(?:MHz|Gbps|fps|秒|%)/i)?.[0];
}

function directionOf(label: string): "higher" | "lower" | "pass" | "range" {
  if (/越低|延迟|误差|资源占用越少/i.test(label)) return "lower";
  if (/越高|CoreMark|频率|帧率|准确率|识别率/i.test(label)) return "higher";
  if (/范围|区间/i.test(label)) return "range";
  return "pass";
}

export function buildCompetitionTaskSpec(file: string, text: string, sourceType: SourcePointer["sourceType"], createdAt: string, challengeId = "challenge-1", lineLocators?: string[]): TaskSpec {
  const analysis = analyzeCompetitionGuide(text), challenge = analysis.challenges.find((item) => item.id === challengeId);
  if (!challenge) throw new Error("未能从资料中确认具体赛题。必须先明确选择赛题编号和完整题名，禁止根据整本指南猜测实现路线。");
  const selected = selectedChallengeText(text, challenge.id), rawLines = text.split(/\r?\n/), normalizedFile = file.replaceAll("\\", "/");
  const pointerFor = (description: string): SourcePointer => {
    const index = rawLines.findIndex((line) => clean(line).includes(clean(description).slice(0, 24)));
    const line = Math.max(0, index);
    return { sourceId: "competition-source", sourceType, locator: `${normalizedFile}#${lineLocators?.[line] ?? `L${line + 1}`}`, contentHash: LeaderStore.hash(rawLines[line] ?? description) };
  };
  const basicText = section(selected, /(?:基础任务\s*[：:]?|【\s*基础要求\s*】)/i, [/(?:高阶任务\s*[：:]?|【\s*高阶挑战\s*】)/i, /三[、.]\s*测评工具/i]);
  const advancedText = section(selected, /(?:高阶任务\s*[：:]?|【\s*高阶挑战\s*】)/i, [/【\s*赛题/i, /三[、.]\s*测评工具/i, /四[、.]\s*性能测评/i]);
  let basicTasks = numbered(basicText).slice(0, 10), advancedTasks = numbered(advancedText).slice(0, 10);
  if (!basicTasks.length && /【\s*赛题要求\s*】/.test(selected)) {
    const taskHeadings = [...selected.matchAll(/(?:^|\n)\s*任务\s*(\d+)\s*[：:]\s*([^\n]+)/g)]
      .map((match) => ({ number: Number(match[1]), title: clean(match[2]!) }))
      .filter((item) => item.title.length >= 4);
    basicTasks = taskHeadings.filter((item) => item.number <= 2).map((item) => item.title).slice(0, 10);
    advancedTasks = taskHeadings.filter((item) => item.number > 2).map((item) => item.title).slice(0, 10);
  }
  if (challenge.category === "sopc-open" && !basicTasks.length) {
    basicTasks = ["在目标 SOPC 平台形成可运行、可现场演示的创新应用闭环"];
    advancedTasks = ["围绕作品创新性、趣味性与实用性形成明确亮点和可复查证据"];
  }
  const selectedLines = unique(selected.split(/\r?\n/).map(clean));
  const submissions = selectedLines.filter((line) => /需提交|提交详细|提交完整|演示视频|工程源码|硬件实物|分析报告|性能分析文档|波形图/i.test(line)).slice(0, 12);
  const demos = selectedLines.filter((line) => /现场|演示|更换测试|动态改变|U 盘|实物/i.test(line)).slice(0, 10);
  const riskLines = selectedLines.filter((line) => /必须|不得|不可|严格|注意|避免|限制|不提供板卡|自行准备/i.test(line)).slice(0, 16);
  let metricLines = metricCandidates(selected);
  if (challenge.category === "sopc-open" && !metricLines.length) metricLines = ["作品创新性综合评判", "作品趣味性综合评判", "作品实用性综合评判"];
  const boards = analysis.boards.filter((board) => selected.includes(board) || text.slice(0, challengeMatches(text)[0]?.index ?? 0).includes(board));
  const tools = analysis.toolchains.filter((tool) => selected.toLowerCase().includes(tool.toLowerCase()));
  const requirements = [
    ...basicTasks.map((description, index) => ({ id: `req-basic-${index + 1}`, description: `基础得分项：${description}`, priority: "must" as const, sourcePointers: [pointerFor(description)] })),
    ...advancedTasks.map((description, index) => ({ id: `req-advanced-${index + 1}`, description: `高阶冲刺项：${description}`, priority: "should" as const, sourcePointers: [pointerFor(description)] }))
  ];
  if (!requirements.length) requirements.push({ id: "req-challenge", description: `完成赛题：${challenge.title}`, priority: "must", sourcePointers: [pointerFor(challenge.title)] });
  const deliverableDescriptions = unique(["可在目标 FPGA 平台演示的基础任务闭环", ...submissions, ...demos.filter((item) => /演示|实物|视频/.test(item))]).slice(0, 10);
  const deliverables = deliverableDescriptions.map((description, index) => ({ id: `del-${index + 1}`, description, required: index === 0 || /需提交|提交|源码|报告|视频/.test(description), sourcePointers: [pointerFor(description)] }));
  const metrics = metricLines.map((label, index) => ({ id: `metric-${index + 1}`, label, ...(targetOf(label) ? { target: targetOf(label) } : {}), unit: label.match(/MHz|Gbps|fps|%|LUTs?|秒/i)?.[0], direction: directionOf(label), evidence: [/CoreMark/i.test(label) ? "CoreMark 原始输出与运行参数" : /时序|频率/i.test(label) ? "实现后的时序报告" : /资源|LUT|DSP|寄存器/i.test(label) ? "综合/实现资源利用率报告" : "可复查的测试记录"], sourcePointers: [pointerFor(label)] }));
  const acceptanceCriteria = [
    ...basicTasks.map((description, index) => ({ id: `ac-basic-${index + 1}`, title: description.slice(0, 120), description: `在目标平台提供可复查证据：${description}`, required: true, verificationMethod: "artifact-review" as const, expectedEvidence: ["仿真或上板结果", "相关代码与工程文件"], sourcePointers: [pointerFor(description)] })),
    ...metrics.map((metric, index) => ({ id: `ac-metric-${index + 1}`, title: metric.label.slice(0, 120), description: metric.label, required: true, verificationMethod: "artifact-review" as const, expectedEvidence: metric.evidence, sourcePointers: metric.sourcePointers }))
  ];
  if (!acceptanceCriteria.length) acceptanceCriteria.push({ id: "ac-demo", title: "基础赛题闭环可验证", description: "在目标硬件或可信仿真环境完成基础任务演示。", required: true, verificationMethod: "artifact-review", expectedEvidence: ["演示记录", "工程源码"], sourcePointers: [pointerFor(challenge.title)] });
  const rubricItems = [
    ...basicTasks.map((description, index) => ({ id: `rubric-basic-${index + 1}`, description: `基础任务：${description}`, mappedRequirementIds: [`req-basic-${index + 1}`], mappedDeliverableIds: [deliverables[0]!.id], mappedStepIds: [], status: "unmapped" as const, sourcePointers: [pointerFor(description)] })),
    ...advancedTasks.map((description, index) => ({ id: `rubric-advanced-${index + 1}`, description: `高阶任务：${description}`, mappedRequirementIds: [`req-advanced-${index + 1}`], mappedDeliverableIds: [deliverables[0]!.id], mappedStepIds: [], status: "unmapped" as const, sourcePointers: [pointerFor(description)] })),
    ...metrics.map((metric, index) => ({ id: `rubric-metric-${index + 1}`, description: metric.label, mappedRequirementIds: requirements.map((item) => item.id), mappedDeliverableIds: deliverables.map((item) => item.id), mappedStepIds: [], status: "unmapped" as const, sourcePointers: metric.sourcePointers }))
  ];
  const profile: CompetitionProfile = {
    contestName: analysis.contestName, track: analysis.track, sourceFile: normalizedFile, challengeId: challenge.id, challengeTitle: challenge.title, category: challenge.category,
    selectionConfirmed: true,
    availableChallenges: analysis.challenges.map(({ id, title }) => ({ id, title })), boards: unique(boards.length ? boards : analysis.boards), selectedBoard: null,
    toolchains: unique(tools.length ? tools : analysis.toolchains), languages: unique(knownTools.filter((item) => /Verilog|SystemVerilog|Linux|RTOS/.test(item) && selected.includes(item))),
    basicTasks, advancedTasks, metrics, submissionItems: submissions, demoRequirements: demos, risks: riskLines
  };
  const questions: TaskSpec["openQuestions"] = [
    ...(challenge.category === "sopc-open" ? [{ id: "competition-open-concept", question: "你们准备自主命题做什么？请说明应用场景、输入、核心处理、输出和现场演示方式。", impact: "开放选题没有统一功能清单，必须先把自定义作品边界变成可验证目标。", blocking: true, answer: null }] : []),
    { id: "competition-board", question: `你们准备使用哪块板卡或远程平台？候选：${profile.boards.join("、") || "请填写具体型号"}`, impact: "器件、引脚、IP、时钟和外设不同，必须先锁定硬件基线。", blocking: true, answer: null },
    { id: "competition-readiness", question: "目前已经跑通到哪一步？例如工具安装、空工程编译、下载、点灯、UART 或视频回环。", impact: "从真实起点安排最小闭环，避免让 AI 假设环境已经可用。", blocking: true, answer: null },
    { id: "competition-strategy", question: "本轮策略是先保基础分，还是同时挑战高阶项？请结合当前赛题的具体高阶要求回答。", impact: "比赛时间有限，策略决定计划顺序和风险预算；未确认前不能生成冲刺计划。", blocking: true, answer: null }
  ];
  return {
    id: `task-${Date.now()}`, version: 1, title: challenge.title, objective: `完成“${challenge.title}”，形成可上板演示、可量化测评、可提交和可答辩的竞赛作品。`, mode: "competition", competition: profile,
    deliverables, requirements, constraints: riskLines.map((description, index) => ({ id: `constraint-${index + 1}`, description, hard: /必须|不得|不可|严格/.test(description), sourcePointers: [pointerFor(description)] })),
    nonGoals: ["未确认板卡和工具链前不编造引脚、时钟或 IP 配置", "不以仅通过软件仿真替代赛题要求的硬件实物演示"], assumptions: [], openQuestions: questions,
    acceptanceCriteria, rubricItems, sourceMaterialIds: ["competition-source"], createdAt, updatedAt: createdAt
  };
}

export function competitionScoreMap(task: TaskSpec, plan: WorkPlan | null, metricRecords: CompetitionMetricRecord[]) {
  const mapped = new Set(plan?.steps.flatMap((step) => step.rubricItemIds) ?? []), latest = new Map<string, CompetitionMetricRecord>();
  for (const record of metricRecords) latest.set(record.metricId, record);
  const items = task.rubricItems.map((item) => ({ ...item, status: item.status === "verified" || latest.has(item.id.replace("rubric-", "")) ? "verified" : mapped.has(item.id) ? "planned" : item.status, latestMetric: latest.get(item.id.replace("rubric-", "")) ?? null }));
  return { total: items.length, planned: items.filter((item) => item.status === "planned").length, verified: items.filter((item) => item.status === "verified").length, items, metrics: task.competition?.metrics.map((metric) => ({ ...metric, latest: latest.get(metric.id) ?? null })) ?? [] };
}

export function diagnoseDebugSession(input: { symptom: string; log: string; stepId?: string | null }, createdAt: string): CompetitionDebugSession {
  const value = `${input.symptom}\n${input.log}`.toLowerCase();
  const category: CompetitionDebugSession["category"] = /syntax|parse|undeclared|编译|语法/.test(value) ? "compile" : /testbench|assert|仿真|simulation|x\b|z\b/.test(value) ? "simulation" : /synth|综合/.test(value) ? "synthesis" : /place|route|布局|布线|implementation/.test(value) ? "implementation" : /timing|slack|setup|hold|时序/.test(value) ? "timing" : /constraint|引脚|xdc|sdc|约束/.test(value) ? "constraint" : /program|download|jtag|下载|烧录/.test(value) ? "programming" : /resource|lut|dsp|bram|资源/.test(value) ? "resource" : /coremark|fps|准确率|识别率|延迟|跑分/.test(value) ? "performance" : /硬件|无输出|黑屏|花屏|串口/.test(value) ? "hardware" : "unknown";
  const diagnosisByCategory: Record<CompetitionDebugSession["category"], string> = { compile: "HDL 编译或语法阶段失败，先定位首个根因错误。", simulation: "仿真结果不符合预期，需要缩小到最小 Testbench 和首个错误周期。", synthesis: "综合阶段失败或推断结构异常，需要检查不可综合语句、位宽和 IP 配置。", implementation: "布局布线阶段失败，需要检查资源、物理约束和拥塞。", timing: "存在时序违例，需要先读取最差路径、时钟域和 setup/hold 类型。", constraint: "约束可能缺失或与板卡不匹配，禁止猜测引脚和时钟。", programming: "下载链路或器件连接失败，需要检查 JTAG、器件型号和生成文件。", hardware: "上板现象异常，需要从时钟、复位、接口和最小可观测信号逐层隔离。", resource: "资源利用率异常或超限，需要根据综合报告定位 LUT/DSP/BRAM 热点。", performance: "当前功能可运行但指标不足，需要保留基线并一次只优化一个瓶颈。", unknown: "日志不足以可靠分类，先收集工具阶段、完整首个错误和复现步骤。" };
  const fixPrompt = ["# 调试快车道任务卡", "", `错误类别：${category}`, `初步诊断：${diagnosisByCategory[category]}`, "", "## 症状", input.symptom.trim(), "", "## 原始日志", input.log.trim(), "", "## 本轮边界", "- 只定位并修复当前错误，不改变赛题目标、板卡基线和已确认实现路线。", "- 先解释首个根因，再提出最小修改。", "- 不得编造引脚、时钟、器件型号、IP 参数或测试结果。", "- 修复后给出精确复现步骤，以及仿真/综合/实现/上板中的对应验证证据。", "- 如果日志不足或修复会改变架构，立即停止并列出需要补充的信息。", "", "## 轻量返回格式", "原因 / 修改文件 / 验证结果 / 仍有风险"].join("\n");
  return { id: `debug-${Date.now()}`, category, symptom: input.symptom.trim(), log: input.log.trim(), diagnosis: diagnosisByCategory[category], fixPrompt, status: "open", stepId: input.stepId ?? null, resolution: null, evidence: [], createdAt, resolvedAt: null };
}

export function buildDefenseSession(task: TaskSpec, plan: WorkPlan | null, metrics: CompetitionMetricRecord[], createdAt: string): CompetitionDefenseSession {
  const challenge = task.competition?.challengeTitle ?? task.title, metricSummary = metrics.slice(-6).map((item) => `${item.label}=${item.value}${item.unit}`).join("、") || "尚无跑分记录";
  const questions: CompetitionDefenseSession["questions"] = [
    { id: "defense-architecture", question: `请用两分钟说明“${challenge}”的整体数据流、模块边界以及为什么选择当前实现路线。`, rationale: "评委需要确认团队真正理解系统，而不是只拼接模块。", focus: "architecture", answer: null, assessment: null },
    { id: "defense-timing", question: "当前最差时序路径在哪里？目标时钟、实际裕量和修复方法分别是什么？", rationale: "FPGA 作品必须能够解释时序闭合。", focus: "timing", answer: null, assessment: null },
    { id: "defense-resource", question: `当前关键指标为：${metricSummary}。主要 LUT、DSP、BRAM 或存储带宽消耗在哪里，为什么值得？`, rationale: "性能必须与资源代价一起解释。", focus: "resource", answer: null, assessment: null },
    { id: "defense-verification", question: "哪些结论来自仿真，哪些来自上板或现场测量？如何保证测试参数和数据没有被挑选？", rationale: "区分软件仿真、自报结果和真实硬件证据。", focus: "verification", answer: null, assessment: null },
    { id: "defense-robustness", question: "如果现场更换输入数据、相机角度、时钟条件或把数据量扩大十倍，系统最可能先在哪里失效？", rationale: "现场答辩通常会检查鲁棒性和真实理解。", focus: "robustness", answer: null, assessment: null },
    { id: "defense-delivery", question: `提交前还缺少哪些源码、报告、波形、视频或硬件演示证据？当前 Plan 状态为 ${plan?.status ?? "未生成"}。`, rationale: "功能完成不等于竞赛交付完整。", focus: "delivery", answer: null, assessment: null }
  ];
  return { id: `defense-${Date.now()}`, questions, createdAt };
}
