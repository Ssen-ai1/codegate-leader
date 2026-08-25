import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { LeaderWorkflow } from "../dist/core/workflow.js";

const outputDirectory = path.resolve(process.argv[2] ?? path.join(os.tmpdir(), "codegate-visual-qa"));
await mkdir(outputDirectory, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), "codegate-visual-project-"));
const userData = await mkdtemp(path.join(os.tmpdir(), "codegate-visual-user-"));
const flow = new LeaderWorkflow(root);
await flow.openProject();
await flow.startFromIdea({ projectName: "InventoryPilot", idea: "为小型餐饮店开发一个可以管理库存、记录消耗和低库存提醒的 Windows 桌面产品。", targetUsers: "没有专业 IT 能力的小型餐饮店店主", platform: "Windows 11 桌面端", constraints: "离线可用，首版六周内交付" });
for (const [questionId, answer] of [
  ["discovery-mvp", "录入库存、记录进货与消耗、低库存提醒；首版不做商城和复杂供应链"],
  ["discovery-data", "数据只保存在本地，不需要账号、支付或第三方服务"],
  ["discovery-success", "新用户五分钟内建立第一个商品并看到低库存提醒"]
]) await flow.clarify(questionId, answer);
await flow.approveTask();
await flow.consult("为什么推荐本地优先架构？");

const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); });
});
const child = spawn(electron, [path.join(process.cwd(), "desktop", "main.cjs"), `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { cwd: process.cwd(), windowsHide: true, env: { ...process.env, CODEGATE_E2E_PROJECT_ROOT: root, CODEGATE_LEADER_API_KEY: "" }, stdio: "ignore" });

async function target() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const page = pages.find((item) => item.type === "page"); if (page) return page; } catch { /* Electron is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Visual QA renderer did not start.");
}

let requestId = 0;
async function cdp(webSocketDebuggerUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl), id = ++requestId;
    const timeout = setTimeout(() => { socket.close(); reject(new Error(`${method} timed out`)); }, 15_000);
    socket.onopen = () => socket.send(JSON.stringify({ id, method, params }));
    socket.onerror = () => { clearTimeout(timeout); reject(new Error(`${method} failed`)); };
    socket.onmessage = (event) => {
      const response = JSON.parse(String(event.data));
      if (response.id !== id) return;
      clearTimeout(timeout); socket.close();
      if (response.error) reject(new Error(response.error.message)); else resolve(response.result);
    };
  });
}

async function evaluate(url, expression) {
  const result = await cdp(url, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function waitFor(url, expression) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await evaluate(url, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function capture(url, name) {
  const result = await cdp(url, "Page.captureScreenshot", { format: "png", captureBeyondViewport: true, fromSurface: true });
  const targetPath = path.join(outputDirectory, name);
  await writeFile(targetPath, Buffer.from(result.data, "base64"));
  return targetPath;
}

try {
  const page = await target(), url = page.webSocketDebuggerUrl;
  await waitFor(url, `Boolean(window.leader && document.querySelector("#open"))`);
  const welcome = await capture(url, "alpha8-welcome.png");
  await evaluate(url, `document.querySelector("#account").click()`);
  await waitFor(url, `document.querySelector("#account-dialog").open && !document.querySelector("#account-title").textContent.includes("正在检查")`);
  const account = await capture(url, "alpha8-account.png");
  await evaluate(url, `document.querySelector("#close-account").click()`);
  await evaluate(url, `document.querySelector("#new-project").click();document.querySelector('[data-template="desktop"]').click()`);
  await waitFor(url, `document.querySelector("#create-dialog").open`);
  const template = await capture(url, "alpha8-project-template.png");
  await evaluate(url, `document.querySelector("#cancel-create").click()`);
  await evaluate(url, `document.querySelector("#open").click()`);
  await waitFor(url, `document.querySelectorAll(".architecture-card").length===3`);
  const architecture = await capture(url, "alpha8-architecture.png");
  await evaluate(url, `document.querySelector("[data-architecture-choice]").click()`);
  await waitFor(url, `document.querySelector("#state").textContent==="架构已确定"`);
  await evaluate(url, `document.querySelector("[data-primary-action='plan']").click()`);
  await waitFor(url, `document.querySelectorAll(".plan-step").length>0`);
  const plan = await capture(url, "alpha8-plan.png");
  await evaluate(url, `document.querySelector("[data-primary-action='approve-plan']").click()`);
  await waitFor(url, `document.querySelector("#state").textContent==="准备执行"`);
  await waitFor(url, `!document.querySelector("#agent-preflight").textContent.includes("正在检测")`);
  const execution = await capture(url, "alpha8-execution.png");
  console.log(JSON.stringify({ welcome, account, template, architecture, plan, execution }, null, 2));
} finally {
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.kill();
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  await Promise.all([rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }), rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })]);
}
