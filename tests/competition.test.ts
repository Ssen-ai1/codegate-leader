import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { analyzeCompetitionGuide, buildCompetitionTaskSpec, diagnoseDebugSession } from "../src/core/competition.js";
import { architectureOptionsFor, competitionIdentityIssue, LeaderWorkflow } from "../src/core/workflow.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const guide = `
全国大学生嵌入式芯片与系统设计竞赛 2026 FPGA 赛道选题指南
指定平台：MES2L676-200HP，开发工具 Pango Design Suite（PDS）

选题一：基于 FPGA 的 RISC-V CPU 设计
基础任务：
1. 完成 RV32I 指令集处理器，能够运行官方测试程序。
2. 在 MES2L676-200HP 上通过 UART 输出结果。
高阶任务：
1. 实现五级流水线和 Cache。
2. 增加 AI 加速扩展指令。
三、测评工具
riscv32-unknown-elf-gcc 和 CoreMark v1.0
四、性能测评标准
1. CoreMark 分数越高越好。
2. 实现后最高时钟频率 MHz 越高越好。
3. LUT 资源占用越少越好。
五、参赛注意事项
必须提交完整工程源码、波形图和性能分析报告。
现场必须使用硬件实物演示，不得只提供软件仿真。

选题二：任意角度图像畸变实时校正
基础任务：
1. 完成 1080P@30fps 视频畸变校正。
高阶任务：
1. 支持动态角度输入。
四、性能测评标准
1. 帧率 fps 越高越好。
`;

describe("competition sprint mode", () => {
  it("recognizes bracketed Efinix problem headings and never classifies a graphics accelerator as a CPU", () => {
    const efinixGuide = `全国大学生嵌入式芯片与系统设计竞赛 2026 FPGA 赛道选题指南
【赛题一】AI 赋能的「实时绘画」——风格化视频渲染系统 ........ 4
【赛题二】基于 RISC-V 与 FPGA 异构架构的 2D 图形渲染加速引擎 ........ 7
【赛题一】AI 赋能的「实时绘画」——风格化视频渲染系统
【基础要求】
1. 完成实时视频输入和风格化输出。
【高阶挑战】
1. 提升输出帧率。
【赛题二】基于 RISC-V 与 FPGA 异构架构的 2D 图形渲染加速引擎
指定平台：Ti60F225I3，开发工具 Efinity
【基础要求】
1. 实现矩形填充和块搬运。
2. 建立 RISC-V 到 FPGA 的命令接口。
【高阶挑战】
1. 支持 Sprite 与多图层混合。
性能要求：记录 FPS、加速比、DSP 和 BRAM 占用。`;
    const analysis = analyzeCompetitionGuide(efinixGuide);
    expect(analysis.challenges).toHaveLength(2);
    expect(analysis.challenges[1]).toMatchObject({ title: "基于 RISC-V 与 FPGA 异构架构的 2D 图形渲染加速引擎", category: "fpga-accelerator" });
    const task = buildCompetitionTaskSpec("efinix.md", efinixGuide, "markdown", new Date().toISOString(), "challenge-2");
    expect(task.competition).toMatchObject({ selectionConfirmed: true, category: "fpga-accelerator", challengeId: "challenge-2" });
    expect(task.competition?.basicTasks).toHaveLength(2);
    expect(task.competition?.advancedTasks).toHaveLength(1);
    expect(task.openQuestions.find((item) => item.id === "competition-strategy")?.blocking).toBe(true);
    expect(competitionIdentityIssue(task)).toBeNull();
    const options = architectureOptionsFor(task);
    expect(options[0]?.name).toContain("Blitter");
    expect(options.map((item) => item.name).join(" ")).not.toContain("CPU");
  });

  it("blocks unrecognized or unselected contest documents instead of inventing challenge-1", () => {
    const unstructured = "全国大学生嵌入式芯片与系统设计竞赛 2026 FPGA 赛道指南\n请根据现场资料完成作品。";
    expect(analyzeCompetitionGuide(unstructured).challenges).toEqual([]);
    expect(() => buildCompetitionTaskSpec("unknown.md", unstructured, "markdown", new Date().toISOString(), "challenge-1")).toThrow(/禁止根据整本指南猜测/);
    expect(() => buildCompetitionTaskSpec("guide.md", guide, "markdown", new Date().toISOString(), "challenge-99")).toThrow(/禁止根据整本指南猜测/);
  });

  it("extracts task-based competition requirements without pretending the whole guide is one task", () => {
    const taskGuide = `全国大学生嵌入式芯片与系统设计竞赛 2026 FPGA 赛道选题指南
【赛题三】多模态 AI 智能终端
【赛题要求】
任务 1：多传感器数据采集与 FPGA 预处理
目标：完成图像和音频采集。
任务 2：多模态 AI 处理与感知决策
目标：完成融合识别。
任务 3：系统优化与智能拓展
至少实现 2 项优化。`;
    const task = buildCompetitionTaskSpec("tasks.md", taskGuide, "markdown", new Date().toISOString(), "challenge-1");
    expect(task.competition?.basicTasks).toEqual(["多传感器数据采集与 FPGA 预处理", "多模态 AI 处理与感知决策"]);
    expect(task.competition?.advancedTasks).toEqual(["系统优化与智能拓展"]);
    expect(competitionIdentityIssue(task)).toBeNull();
  });

  it("removes architecture choices when a legacy project has no explicit user selection", () => {
    const task = buildCompetitionTaskSpec("guide.md", guide, "markdown", new Date().toISOString(), "challenge-1");
    const legacy = { ...task, competition: { ...task.competition!, selectionConfirmed: false } };
    expect(competitionIdentityIssue(legacy)).toMatch(/尚未由用户明确选择/);
    expect(architectureOptionsFor(legacy)).toEqual([]);
  });

  it("extracts multiple FPGA challenges and creates a traceable score-driven TaskSpec", () => {
    const analysis = analyzeCompetitionGuide(guide);
    expect(analysis.challenges).toHaveLength(2);
    expect(analysis.challenges[0]).toMatchObject({ category: "fpga-cpu" });
    expect(analysis.boards).toContain("MES2L676-200HP");
    expect(analysis.toolchains).toEqual(expect.arrayContaining(["Pango Design Suite", "PDS", "CoreMark v1.0"]));

    const task = buildCompetitionTaskSpec("guide.md", guide, "markdown", new Date().toISOString(), "challenge-1");
    expect(task.mode).toBe("competition");
    expect(task.competition).toMatchObject({ challengeTitle: "基于 FPGA 的 RISC-V CPU 设计", category: "fpga-cpu" });
    expect(task.competition?.basicTasks).toHaveLength(2);
    expect(task.competition?.advancedTasks).toHaveLength(2);
    expect(task.competition?.metrics.some((item) => /CoreMark/.test(item.label))).toBe(true);
    expect(task.rubricItems.length).toBeGreaterThan(4);
    expect(task.requirements[0]?.sourcePointers[0]?.locator).toContain("guide.md#L");
    expect(task.openQuestions.map((item) => item.id)).toEqual(["competition-board", "competition-readiness", "competition-strategy"]);
  });

  it("runs from imported contest guide through sprint planning, debug, metrics and defense", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-competition-")); roots.push(root);
    await writeFile(path.join(root, "guide.md"), guide, "utf8");
    const flow = new LeaderWorkflow(root);
    await flow.openProject();
    await flow.setProjectMode("competition");
    const inspection = await flow.inspectCompetitionSource("guide.md");
    expect(inspection.analysis.challenges).toHaveLength(2);
    await flow.intakeCompetition("guide.md", "challenge-1");
    await flow.clarify("competition-board", "MES2L676-200HP");
    await flow.clarify("competition-readiness", "PDS 已安装，空工程可综合，尚未完成下载点灯");
    await flow.clarify("competition-strategy", "先保 RV32I 与 UART 基础分，再冲五级流水和 Cache");
    await flow.approveTask();
    const options = architectureOptionsFor((await flow.store.task())!);
    expect(options).toHaveLength(3);
    expect(options.some((item) => item.recommended && /五级|三阶段|流水/.test(item.name))).toBe(true);
    await flow.architecture("竞赛实现路线", options.find((item) => item.recommended)!.summary);
    const plan = await flow.createPlan();
    expect(plan.steps).toHaveLength(6);
    expect(plan.steps.map((item) => item.title).join(" ")).toMatch(/板卡|最小硬件闭环|基础得分|答辩/);
    await flow.approvePlanWithPatch();

    const beforeDebug = await flow.store.state();
    const debug = await flow.startCompetitionDebug({ symptom: "实现后时序不过", log: "Worst Negative Slack -2.15ns, setup timing failed" });
    expect(debug).toMatchObject({ category: "timing", status: "open" });
    expect(debug.fixPrompt).toContain("不得编造引脚");
    expect(await flow.store.state()).toEqual(beforeDebug);
    await flow.resolveCompetitionDebug(debug.id, "增加流水寄存器后 WNS 变为 0.12ns", ["reports/timing.rpt"]);

    const metricId = (await flow.store.task())!.competition!.metrics.find((item) => /CoreMark/.test(item.label))!.id;
    await flow.recordCompetitionMetric({ metricId, value: 3.27, unit: "CoreMark/MHz", context: "MES2L676-200HP @ 50MHz" });
    const defense = await flow.createCompetitionDefenseSession();
    expect(defense.questions).toHaveLength(6);
    expect(defense.questions.map((item) => item.focus)).toEqual(expect.arrayContaining(["architecture", "timing", "verification", "delivery"]));

    const snapshot = await flow.snapshot();
    expect(snapshot.projectMode).toBe("competition");
    expect(snapshot.competition?.debugSessions[0]).toMatchObject({ status: "resolved" });
    expect(snapshot.competition?.metricRecords[0]).toMatchObject({ value: 3.27 });
    expect(snapshot.competition?.scoreMap.verified).toBeGreaterThan(0);
    expect(snapshot.competition?.latestDefense?.questions).toHaveLength(6);
  });

  it("classifies common tool failures without mutating the formal plan", () => {
    expect(diagnoseDebugSession({ symptom: "下载失败", log: "JTAG device not found" }, new Date().toISOString()).category).toBe("programming");
    expect(diagnoseDebugSession({ symptom: "仿真波形错误", log: "testbench assertion failed" }, new Date().toISOString()).category).toBe("simulation");
    expect(diagnoseDebugSession({ symptom: "资源超限", log: "DSP utilization 112%" }, new Date().toISOString()).category).toBe("resource");
  });

  it("turns an open SOPC challenge into a verifiable self-defined project", () => {
    const openGuide = `全国大学生嵌入式芯片与系统设计竞赛 2026 FPGA 赛道选题指南
选题四：开放选题：基于紫光同创 SOPC 的创新应用开发
参赛者基于 SOPC 开发平板自主命题，在平台上实现 AI 识别、图像处理或者其他创意开发，以作品创新性、趣味性、实用性进行综合评判。`;
    const task = buildCompetitionTaskSpec("open.md", openGuide, "markdown", new Date().toISOString(), "challenge-1");
    expect(task.competition).toMatchObject({ category: "sopc-open" });
    expect(task.competition?.basicTasks).toHaveLength(1);
    expect(task.competition?.advancedTasks).toHaveLength(1);
    expect(task.competition?.metrics.map((item) => item.label)).toEqual(expect.arrayContaining(["作品创新性综合评判", "作品趣味性综合评判", "作品实用性综合评判"]));
    expect(task.openQuestions[0]).toMatchObject({ id: "competition-open-concept", blocking: true });
  });
});
