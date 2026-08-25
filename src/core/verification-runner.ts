import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { LeaderStore } from "./store.js";
import { verificationRunSchema, type VerificationRun } from "./schemas.js";

const MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export function parseApprovedCommand(command: string) {
  if (!command.trim() || command.length > 4096) throw new Error("验证命令为空或过长。");
  if (/[&|<>;\r\n\0`$(){}\[\]%!^]/.test(command)) throw new Error("验证命令包含不允许的 Shell 元字符。");
  const tokens: string[] = [];
  let token = "", quote: "'" | '"' | null = null;
  const push = () => { if (token) { tokens.push(token); token = ""; } };
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = null;
      else if (character === "\\" && quote === '"' && command[index + 1]) token += command[++index]!;
      else token += character;
    } else if (character === "'" || character === '"') quote = character;
    else if (/\s/.test(character)) push();
    else token += character;
  }
  if (quote) throw new Error("验证命令包含未闭合引号。");
  push();
  if (!tokens.length || tokens.length > 64 || tokens.some((item) => !item || /["&|<>;\r\n\0`$(){}\[\]%!^]/.test(item))) throw new Error("验证命令参数不安全。");
  return tokens;
}

function appendBounded(chunks: Buffer[], chunk: Buffer, currentBytes: number) {
  if (currentBytes >= MAX_OUTPUT_BYTES) return currentBytes;
  const remaining = MAX_OUTPUT_BYTES - currentBytes;
  chunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
  return currentBytes + Math.min(chunk.length, remaining);
}

export async function executeApprovedCommand(root: string, command: string, stepId: string, handoffVersion: number, coversAcceptanceIds: string[], timeoutMs = 120_000): Promise<{ run: VerificationRun; log: string }> {
  const tokens = parseApprovedCommand(command), started = Date.now(), startedAt = new Date(started).toISOString(), id = `verification-${randomUUID()}`;
  const boundedTimeout = Math.max(1_000, Math.min(timeoutMs, 10 * 60_000));
  const useCommandProcessor = process.platform === "win32" && (/\.(?:cmd|bat)$/i.test(tokens[0]!) || ["npm", "npx", "pnpm", "yarn"].includes(tokens[0]!.toLowerCase()));
  const executable = useCommandProcessor ? (process.env.ComSpec ?? "cmd.exe") : tokens[0]!;
  const safeCommandLine = tokens.map((item) => /^[A-Za-z0-9_@./:\\=+-]+$/.test(item) ? item : `"${item}"`).join(" ");
  const args = useCommandProcessor ? ["/d", "/s", "/c", safeCommandLine] : tokens.slice(1);
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let stdoutBytes = 0, stderrBytes = 0, timedOut = false;
  const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: path.resolve(root), shell: false, windowsHide: true, env: process.env });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, boundedTimeout);
    child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes = appendBounded(stdout, chunk, stdoutBytes); });
    child.stderr?.on("data", (chunk: Buffer) => { stderrBytes = appendBounded(stderr, chunk, stderrBytes); });
    child.once("error", (error) => { clearTimeout(timer); reject(new Error(`无法启动验证命令：${error.message}`)); });
    child.once("close", (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal }); });
  });
  const finished = Date.now(), stdoutText = Buffer.concat(stdout).toString("utf8"), stderrText = Buffer.concat(stderr).toString("utf8");
  const truncated = stdoutBytes >= MAX_OUTPUT_BYTES || stderrBytes >= MAX_OUTPUT_BYTES;
  const log = [`Command: ${command}`, `Started: ${startedAt}`, `Finished: ${new Date(finished).toISOString()}`, `Exit code: ${result.exitCode ?? "null"}`, `Signal: ${result.signal ?? "null"}`, `Timed out: ${timedOut}`, `Output truncated: ${truncated}`, "", "--- STDOUT ---", stdoutText, "", "--- STDERR ---", stderrText].join("\n");
  const outputArtifact = `.codegate/verifications/${id}.log`;
  const run = verificationRunSchema.parse({ id, source: "codegate", stepId, handoffVersion, command, status: timedOut ? "timed-out" : result.exitCode === 0 ? "passed" : "failed", exitCode: result.exitCode, signal: result.signal, outputArtifact, outputHash: LeaderStore.hash(log), coversAcceptanceIds, startedAt, finishedAt: new Date(finished).toISOString(), durationMs: finished - started });
  return { run, log };
}
