import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { LeaderWorkflow, architectureOptionsFor } from "../dist/core/workflow.js";

const outputDirectory = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "codegate-competition-visual-qa"));
await mkdir(outputDirectory, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "codegate-competition-visual-"));
const userData = await mkdtemp(path.join(os.tmpdir(), "codegate-competition-user-"));
const guide = `全国大学生嵌入式芯片与系统设计竞赛 2026 FPGA 赛道选题指南
指定平台 MES2L676-200HP，使用 Pango Design Suite（PDS）。
选题一：基于 FPGA 的 RISC-V CPU 设计
基础任务：
1. 完成 RV32I 指令集处理器并通过指令测试。
2. 通过 UART 输出运行结果。
高阶任务：
1. 实现五级流水线与 Cache。
2. 增加 AI 加速扩展指令。
四、性能测评标准
1. CoreMark 分数越高越好。
2. 实现后最高时钟频率 MHz 越高越好。
3. LUT 资源占用越少越好。
五、参赛注意事项
必须提交完整工程源码、波形图和性能分析报告。
现场必须使用硬件实物演示，不得只提供软件仿真。`;
await writeFile(path.join(root, "fpga-guide.md"), guide, "utf8");
const flow = new LeaderWorkflow(root);
await flow.openProject();
await flow.setProjectMode("competition");
await flow.intakeCompetition("fpga-guide.md", "challenge-1");
await flow.clarify("competition-board", "MES2L676-200HP");
await flow.clarify("competition-readiness", "PDS 已安装，空工程可综合，尚未完成下载点灯");
await flow.clarify("competition-strategy", "先保 RV32I 与 UART 基础分，再冲流水线与 Cache");
await flow.approveTask();
const task = await flow.store.task(), recommended = architectureOptionsFor(task).find((item) => item.recommended);
await flow.architecture("竞赛实现路线", `${recommended.name}：${recommended.summary}`);
await flow.createPlan();
await flow.approvePlanWithPatch();
await flow.startCompetitionDebug({ symptom: "实现后出现 setup 时序违例", log: "Worst Negative Slack -2.15ns; setup timing failed" });
const metric = task.competition.metrics.find((item) => /CoreMark/.test(item.label));
await flow.recordCompetitionMetric({ metricId: metric.id, value: 3.27, unit: "CoreMark/MHz", context: "MES2L676-200HP @ 50MHz" });

const port = await new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
const child = spawn(electron, [path.join(process.cwd(), "desktop", "main.cjs"), `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, CODEGATE_E2E_PROJECT_ROOT: root, CODEGATE_LEADER_API_KEY: "" }, stdio: "ignore" });
let requestId = 0;
async function pageTarget() { const deadline = Date.now() + 20_000; while (Date.now() < deadline) { try { const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(), page = pages.find((item) => item.type === "page"); if (page) return page; } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error("Renderer did not start."); }
async function cdp(url, method, params = {}) { return new Promise((resolve, reject) => { const socket = new WebSocket(url), id = ++requestId, timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 15_000); socket.onopen = () => socket.send(JSON.stringify({ id, method, params })); socket.onerror = () => { clearTimeout(timeout); reject(new Error(`${method} failed`)); }; socket.onmessage = (event) => { const response = JSON.parse(String(event.data)); if (response.id !== id) return; clearTimeout(timeout); socket.close(); if (response.error) reject(new Error(response.error.message)); else resolve(response.result); }; }); }
async function evaluate(url, expression) { const result = await cdp(url, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; }
async function waitFor(url, expression) { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if (await evaluate(url, expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}`); }
async function capture(url, name) { const result = await cdp(url, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true }); const target = path.join(outputDirectory, name); await writeFile(target, Buffer.from(result.data, "base64")); return target; }

try {
  const page = await pageTarget(), url = page.webSocketDebuggerUrl;
  await waitFor(url, `Boolean(window.leader && document.querySelector("#new-project"))`);
  await evaluate(url, `document.querySelector("#new-project").click();document.querySelector('[data-template="competition"]').click()`);
  await waitFor(url, `document.querySelector("#create-dialog").open`);
  const template = await capture(url, "alpha8-competition-template.png");
  await evaluate(url, `document.querySelector("#cancel-create").click();document.querySelector("#open").click()`);
  await waitFor(url, `document.querySelector("#state").textContent==="冲刺任务就绪"`);
  const sprint = await capture(url, "alpha8-competition-sprint.png");
  await evaluate(url, `document.querySelector("#debug-symptom").value="实现后时序不过";document.querySelector("#debug-log").value="Worst Negative Slack -2.1ns setup timing failed";document.querySelector("#start-debug").click()`);
  await waitFor(url, `document.querySelector("#prompt-dialog").open`);
  const debug = await capture(url, "alpha8-debug-fast-track.png");
  console.log(JSON.stringify({ template, sprint, debug }, null, 2));
} finally {
  const closed = new Promise((resolve) => child.once("close", resolve)); child.kill(); await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }), rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })]);
}
