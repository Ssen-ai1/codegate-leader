import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    child.kill();
    await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  }));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
});

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close(() => resolve(port)); });
  });
}

async function waitForPage(port: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = pages.find((item) => item.type === "page"); if (page) return page;
    } catch { /* Electron is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Electron DevTools page did not become available.");
}

async function evaluate(webSocketDebuggerUrl: string, expression: string) {
  return new Promise<unknown>((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => { socket.close(); reject(new Error("CDP evaluation timed out.")); }, 5_000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("CDP connection failed.")); };
    socket.onmessage = (event) => {
      const response = JSON.parse(String(event.data)) as { id?: number; result?: { result?: { value?: unknown }; exceptionDetails?: unknown } };
      if (response.id !== 1) return;
      clearTimeout(timeout); socket.close();
      if (response.result?.exceptionDetails) reject(new Error("Renderer evaluation failed: " + JSON.stringify(response.result.exceptionDetails)));
      else resolve(response.result?.result?.value);
    };
  });
}

describe.skipIf(process.platform !== "win32")("Desktop packaged-runtime path", () => {
  it("launches Electron, opens a selected project through IPC, and renders the workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-desktop-e2e-")); roots.push(root); await writeFile(path.join(root, "task.md"), "Build a stable desktop app.\n", "utf8");
    const port = await freePort();
    const child = spawn(electron as unknown as string, [path.join(process.cwd(), "desktop", "main.cjs"), `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(root, ".electron-user-data")}`], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, CODEGATE_E2E_PROJECT_ROOT: root, CODEGATE_E2E_CREATE_PARENT: root }, stdio: "ignore" }); children.push(child);
    const page = await waitForPage(port);
    const renderDeadline = Date.now() + 10_000;
    while (Date.now() < renderDeadline) {
      if (await evaluate(page.webSocketDebuggerUrl, `Boolean(document.querySelector("#open") && window.leader)`)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await evaluate(page.webSocketDebuggerUrl, `Boolean(document.querySelector("#open") && window.leader)`)).toBe(true);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#onboarding-banner").hidden`)).toBe(false);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#dismiss-onboarding").click()`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#onboarding-banner").hidden`)).toBe(true);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#account").click()`);
    const accountDeadline = Date.now() + 5_000;
    while (Date.now() < accountDeadline && String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#account-title").textContent`)).includes("正在检查")) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#account-title").textContent`)).toBe("尚未连接订阅服务");
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#account-message").textContent`))).toContain("不执行付费功能门控");
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#account-installation").textContent`))).toContain("本地开关不能改变签名权益");
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#close-account").click()`);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#open").click()`);
    const deadline = Date.now() + 15_000; let result: { state?: string; project?: string; dashboardHidden?: boolean; notice?: string } = {};
    while (Date.now() < deadline) {
      result = JSON.parse(String(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({state:document.querySelector("#state").textContent,project:document.querySelector("#project").textContent,dashboardHidden:document.querySelector("#dashboard").hidden,notice:document.querySelector("#notice").hidden?"":document.querySelector("#notice").textContent})`))) as typeof result;
      if (result.state === "项目起点" && result.dashboardHidden === false) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(result).toMatchObject({ state: "项目起点", project: root, dashboardHidden: false, notice: "" });
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#model-usage").textContent`))).toContain("尚无模型调用");
    expect(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({refresh:document.querySelector("#refresh").disabled,settings:document.querySelector("#settings").disabled,diagnostics:document.querySelector("#diagnostics").disabled})`)).toBe('{"refresh":false,"settings":false,"diagnostics":false}');
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#refresh").click()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#state").textContent`)).toBe("项目起点");
    expect(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({consult:document.querySelector('[data-a="consult"]').disabled,mentor:document.querySelector('[data-a="ask-mentor"]').disabled,brief:document.querySelector('[data-a="explain"]').disabled})`)).toBe('{"consult":false,"mentor":true,"brief":true}');
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#leader-message").value="下一步怎么做";document.querySelector('[data-a="consult"]').click()`);
    const consultationDeadline = Date.now() + 5_000;
    while (Date.now() < consultationDeadline && !String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#output").textContent`)).includes("描述产品想法")) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#output").textContent`))).toContain("描述产品想法");
    expect(Number(await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll("#output .message").length`))).toBe(2);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#refresh").click()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(Number(await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll("#output .message").length`))).toBe(2);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#inline-idea").value="开发一个帮助小商店管理库存和低库存提醒的 Windows 桌面应用";document.querySelector("#start-idea").click()`);
    const interviewDeadline = Date.now() + 5_000;
    while (Date.now() < interviewDeadline && String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#state").textContent`)) !== "需求访谈") await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#state").textContent`)).toBe("需求访谈");
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#focus-title").textContent`))).toContain("需求");
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#discovery-answer").value="小型商店店主";document.querySelector("#discovery-answer").dispatchEvent(new Event("input",{bubbles:true}));document.querySelector("#refresh").click()`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#discovery-answer").value`)).toBe("小型商店店主");
    await evaluate(page.webSocketDebuggerUrl, `invoke(() => window.leader.action(root, "explain", {}))`);
    expect(await evaluate(page.webSocketDebuggerUrl, `JSON.stringify({hidden:document.querySelector("#notice").hidden,text:document.querySelector("#notice").textContent})`)).toContain('"hidden":false');
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#notice").textContent`))).toContain("缺少");

    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#home").click();document.querySelector("#new-project").click()`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#create-dialog").open`)).toBe(true);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[data-template="desktop"]').click()`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#create-platform").value`)).toBe("Windows 桌面");
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#create-constraints").value`))).toContain("离线");
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#choose-location").click()`);
    const locationDeadline = Date.now() + 5_000;
    while (Date.now() < locationDeadline && !String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#create-location").value`))) await new Promise((resolve) => setTimeout(resolve, 100));
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#create-name").value="InventoryPilot";document.querySelector("#create-idea").value="为小型餐饮店开发一个可以管理库存和低库存提醒的 Windows 桌面应用";document.querySelector("#create-users").value="小型餐饮店店主";document.querySelector("#create-platform").value="Windows 桌面";document.querySelector("#confirm-create").click()`);
    const createdDeadline = Date.now() + 8_000;
    while (Date.now() < createdDeadline && !String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#project").textContent`)).endsWith("InventoryPilot")) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#project").textContent`))).toBe(path.join(root, "InventoryPilot"));
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#state").textContent`)).toBe("需求访谈");
    await access(path.join(root, "InventoryPilot", "README.md"));
    await access(path.join(root, "InventoryPilot", ".codegate", "task", "task-spec.json"));
    await evaluate(page.webSocketDebuggerUrl, `invoke(()=>window.leader.action(root,"clarify",{questionId:"discovery-mvp",answer:"录入库存、记录消耗并提供低库存提醒；首版不做商城"}))`);
    await evaluate(page.webSocketDebuggerUrl, `invoke(()=>window.leader.action(root,"clarify",{questionId:"discovery-data",answer:"本地保存库存，不需要账号、支付或第三方服务"}))`);
    await evaluate(page.webSocketDebuggerUrl, `invoke(()=>window.leader.action(root,"clarify",{questionId:"discovery-success",answer:"新用户五分钟内建立商品并看到低库存提醒"}))`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#state").textContent`)).toBe("需求待确认");
    await evaluate(page.webSocketDebuggerUrl, `invoke(()=>window.leader.action(root,"approve-task",{}))`);
    expect(Number(await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".architecture-card").length`))).toBe(3);
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector(".architecture-card.recommended").textContent`))).toContain("Leader 推荐");
    await evaluate(page.webSocketDebuggerUrl, `invoke(()=>window.leader.action(root,"recommend-architecture",{}))`);
    await evaluate(page.webSocketDebuggerUrl, `invoke(()=>window.leader.action(root,"plan",{}))`);
    expect(Number(await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".plan-step").length`))).toBeGreaterThan(0);
    await evaluate(page.webSocketDebuggerUrl, `invoke(()=>window.leader.action(root,"approve-plan",{}))`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#state").textContent`)).toBe("准备执行");
    expect(Number(await evaluate(page.webSocketDebuggerUrl, `document.querySelectorAll(".execution-status").length`))).toBe(3);
    const agentDeadline = Date.now() + 5_000;
    while (Date.now() < agentDeadline && String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#agent-preflight").textContent`)).includes("正在检测")) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#agent-preflight").textContent`))).toContain("Codex");
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[data-primary-action="next"]').click()`);
    const promptDeadline = Date.now() + 5_000;
    while (Date.now() < promptDeadline && !(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#prompt-dialog").open`))) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#prompt-dialog").open`)).toBe(true);
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#prompt-output").textContent`))).toContain("Execution Report Contract");
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#copy-prompt").click()`);
    const copyDeadline = Date.now() + 3_000;
    while (Date.now() < copyDeadline && !String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#prompt-status").textContent`)).includes("已复制")) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#prompt-status").textContent`))).toContain("已复制");
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#close-prompt").click();document.querySelector('[data-stage-index="0"]').click()`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#focus-title").textContent`)).toBe("产品定义");
    expect(await evaluate(page.webSocketDebuggerUrl, `Boolean(document.querySelector("#reopen-product"))`)).toBe(true);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#reopen-product").click()`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#impact-dialog").open`)).toBe(true);
    expect(String(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#impact-list").textContent`))).toContain("旧 Plan");
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#cancel-impact").click()`);
    await evaluate(page.webSocketDebuggerUrl, `document.querySelector('[data-stage-index="2"]').click()`);
    expect(await evaluate(page.webSocketDebuggerUrl, `document.querySelector("#focus-title").textContent`)).toBe("开发计划");
    expect(await evaluate(page.webSocketDebuggerUrl, `Boolean(document.querySelector("[data-save-stage-plan]"))`)).toBe(true);
  }, 30_000);

  it("creates a competition project and completes the score-driven desktop flow", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "codegate-competition-desktop-")); roots.push(parent);
    const source = path.join(parent, "fpga-guide.md");
    await writeFile(source, `全国大学生嵌入式芯片与系统设计竞赛 2026 FPGA 赛道选题指南
指定平台 MES2L676-200HP，使用 Pango Design Suite（PDS）。
选题一：基于 FPGA 的 RISC-V CPU 设计
基础任务：
1. 完成 RV32I 指令集处理器。
2. 通过 UART 输出测试结果。
高阶任务：
1. 实现五级流水线与 Cache。
四、性能测评标准
1. CoreMark 分数越高越好。
2. 实现后最高时钟频率 MHz 越高越好。
五、参赛注意事项
必须提交完整工程源码、波形图和性能分析报告。
选题二：实时图像畸变校正
基础任务：
1. 完成 1080P@30fps 视频闭环。
`, "utf8");
    const port = await freePort();
    const child = spawn(electron as unknown as string, [path.join(process.cwd(), "desktop", "main.cjs"), `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(parent, ".electron-user-data")}`], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, CODEGATE_E2E_CREATE_PARENT: parent, CODEGATE_E2E_COMPETITION_SOURCE: source }, stdio: "ignore" }); children.push(child);
    const page = await waitForPage(port), ws = page.webSocketDebuggerUrl;
    const waitUntil = async (expression: string, timeout = 8_000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await evaluate(ws, expression)) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${expression}`); };
    await waitUntil(`Boolean(document.querySelector("#new-project") && window.leader)`);
    await evaluate(ws, `document.querySelector("#new-project").click();document.querySelector('[data-template="competition"]').click()`);
    expect(await evaluate(ws, `document.querySelector("#create-title").textContent`)).toBe("创建竞赛冲刺项目");
    expect(await evaluate(ws, `document.querySelector("#create-idea-label").hidden`)).toBe(true);
    await evaluate(ws, `document.querySelector("#choose-location").click()`);
    await waitUntil(`Boolean(document.querySelector("#create-location").value)`);
    await evaluate(ws, `document.querySelector("#create-name").value="FpgaSprint";document.querySelector("#confirm-create").click()`);
    await waitUntil(`document.querySelector("#state").textContent==="导入赛题"`);
    expect(await evaluate(ws, `document.querySelector("#focus-title").textContent`)).toBe("先导入赛题，再决定怎么做");
    await access(path.join(parent, "FpgaSprint", ".codegate", "project.json"));

    await evaluate(ws, `document.querySelector("#competition-intake").click()`);
    await waitUntil(`document.querySelector("#competition-dialog").open`);
    expect(Number(await evaluate(ws, `document.querySelectorAll("#competition-challenges .challenge-button").length`))).toBe(2);
    await evaluate(ws, `document.querySelector("#confirm-competition").click()`);
    await waitUntil(`document.querySelector("#state").textContent==="确认参赛起点"`);
    expect(String(await evaluate(ws, `document.querySelector("#focus-body").textContent`))).toContain("竞赛得分地图");
    await evaluate(ws, `invoke(()=>window.leader.action(root,"clarify",{questionId:"competition-board",answer:"MES2L676-200HP"}))`);
    await evaluate(ws, `invoke(()=>window.leader.action(root,"clarify",{questionId:"competition-readiness",answer:"PDS 已安装，空工程可综合，尚未下载点灯"}))`);
    await evaluate(ws, `invoke(()=>window.leader.action(root,"clarify",{questionId:"competition-strategy",answer:"先保 RV32I 与 UART，再冲流水线和 Cache"}))`);
    await waitUntil(`document.querySelector("#state").textContent==="确认得分地图"`);
    await evaluate(ws, `document.querySelector('[data-primary-action="approve-task"]').click()`);
    await waitUntil(`document.querySelector("#state").textContent==="选择实现路线"`);
    expect(Number(await evaluate(ws, `document.querySelectorAll(".architecture-card").length`))).toBe(3);
    await evaluate(ws, `document.querySelector(".architecture-card.recommended button").click()`);
    await waitUntil(`document.querySelector("#state").textContent==="路线已确定"`);
    await evaluate(ws, `document.querySelector('[data-primary-action="plan"]').click()`);
    await waitUntil(`document.querySelector("#state").textContent==="冲刺计划待确认"`);
    expect(Number(await evaluate(ws, `document.querySelectorAll(".plan-step").length`))).toBe(6);
    await evaluate(ws, `document.querySelector('[data-primary-action="approve-plan"]').click()`);
    await waitUntil(`document.querySelector("#state").textContent==="冲刺任务就绪"`);
    expect(await evaluate(ws, `Boolean(document.querySelector("#start-debug") && document.querySelector("#record-metric"))`)).toBe(true);

    await evaluate(ws, `document.querySelector("#debug-symptom").value="实现后时序不过";document.querySelector("#debug-log").value="Worst Negative Slack -2.1ns setup timing failed";document.querySelector("#start-debug").click()`);
    await waitUntil(`document.querySelector("#prompt-dialog").open`);
    expect(String(await evaluate(ws, `document.querySelector("#prompt-output").textContent`))).toContain("错误类别：timing");
    await evaluate(ws, `document.querySelector("#close-prompt").click();document.querySelector("#metric-value").value="3.27";document.querySelector("#metric-unit").value="CoreMark/MHz";document.querySelector("#metric-context").value="MES2L676-200HP @ 50MHz";document.querySelector("#record-metric").click()`);
    await waitUntil(`document.querySelectorAll(".score-item.verified").length>0`);
    const defense = await evaluate(ws, `window.leader.action(root,"competition-defense",{}).then(x=>x.defenseSession.questions.length)`);
    expect(defense).toBe(6);
  }, 30_000);
});
