import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const executable = path.resolve("release", "win-unpacked", "CodeGate Leader.exe");
await access(executable);
const userData = await mkdtemp(path.join(os.tmpdir(), "codegate-packaged-smoke-"));
const port = await new Promise((resolve, reject) => { const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => resolve(address.port)); }); });
const child = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { windowsHide: true, stdio: "ignore" });

async function page() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); const target = pages.find((item) => item.type === "page"); if (target) return target; } catch { /* Packaged Electron is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Packaged Electron renderer did not start.");
}

async function evaluate(webSocketDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl), timeout = setTimeout(() => { socket.close(); reject(new Error("Packaged renderer evaluation timed out.")); }, 15_000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    socket.onerror = () => { clearTimeout(timeout); reject(new Error("Packaged renderer CDP connection failed.")); };
    socket.onmessage = (event) => { const response = JSON.parse(String(event.data)); if (response.id !== 1) return; clearTimeout(timeout); socket.close(); if (response.result?.exceptionDetails) reject(new Error(JSON.stringify(response.result.exceptionDetails))); else resolve(response.result?.result?.value); };
  });
}

try {
  const target = await page();
  const result = await evaluate(target.webSocketDebuggerUrl, `window.leader.selfTest()`);
  if (!result?.ok || result.state !== "new" || result.eventLog?.valid !== true) throw new Error("Packaged workflow self-test failed: " + JSON.stringify(result));
  const settings = await evaluate(target.webSocketDebuggerUrl, `window.leader.settings()`);
  if (!settings?.secureStorageAvailable) throw new Error("Packaged secure storage is unavailable.");
  console.log(JSON.stringify({ packaged: true, workflow: result, secureStorageAvailable: settings.secureStorageAvailable }, null, 2));
} finally {
  const closed = new Promise((resolve) => child.once("close", resolve)); child.kill(); await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 3000))]);
  await rm(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
