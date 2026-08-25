import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { WorkspaceBaseline } from "./schemas.js";

const execFile = promisify(execFileCallback);
const normalize = (value: string) => value.replaceAll("\\", "/").replace(/^\.\//, "");
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");

export type WorkspaceEvidence = {
  headRevision: string | null;
  changedFiles: string[];
  diff: string;
  baselineDirtyFiles: string[];
  currentFileHashes: Record<string, string>;
};

async function git(root: string, args: string[]) {
  try { return (await execFile("git", args, { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })).stdout.trim(); }
  catch { return ""; }
}

async function fileHash(root: string, relative: string) {
  try { return hash(await readFile(path.resolve(root, relative))); }
  catch { return "<missing>"; }
}

async function dirtyFiles(root: string) {
  const output = await git(root, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).codegate"]);
  return [...new Set(output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1)).filter((value): value is string => Boolean(value)).map(normalize))];
}

async function workspaceFiles(root: string, relative = "", result: string[] = []): Promise<string[]> {
  if (result.length >= 10_000) return result;
  const directory = path.resolve(root, relative);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    const target = normalize(path.join(relative, entry.name));
    if (entry.isDirectory()) {
      if ([".git", ".codegate", "node_modules", "release"].includes(entry.name)) continue;
      await workspaceFiles(root, target, result);
    } else if (entry.isFile()) result.push(target);
    if (result.length >= 10_000) break;
  }
  return result;
}

async function changedFileContent(root: string, files: string[]) {
  const sections: string[] = [];
  let remaining = 100_000;
  for (const file of files) {
    if (remaining <= 0) break;
    try {
      const content = await readFile(path.resolve(root, file));
      if (content.includes(0)) continue;
      const text = content.toString("utf8").slice(0, Math.min(20_000, remaining));
      sections.push(`--- /dev/null\n+++ b/${file}\n@@ untracked-or-non-git file content @@\n${text}`);
      remaining -= text.length;
    } catch { /* Missing or unreadable files remain represented by the file list and hash. */ }
  }
  return sections.join("\n");
}

export async function captureBaseline(root: string, stepId: string, handoffVersion: number, timestamp: string): Promise<WorkspaceBaseline> {
  const headRevision = await git(root, ["rev-parse", "HEAD"]) || null;
  const changedFiles = await dirtyFiles(root);
  const filesToHash = headRevision ? changedFiles : await workspaceFiles(root);
  const hashes = Object.fromEntries(await Promise.all(filesToHash.map(async (file) => [file, await fileHash(root, file)] as const)));
  return { id: `baseline-${stepId}-v${handoffVersion}`, stepId, handoffVersion, headRevision, changedFiles, fileHashes: hashes, createdAt: timestamp };
}

export async function observeSince(root: string, baseline: WorkspaceBaseline): Promise<WorkspaceEvidence> {
  const headRevision = await git(root, ["rev-parse", "HEAD"]) || null;
  const currentDirty = headRevision || baseline.headRevision ? await dirtyFiles(root) : await workspaceFiles(root);
  const currentHashes = Object.fromEntries(await Promise.all(currentDirty.map(async (file) => [file, await fileHash(root, file)] as const)));
  const changedAfterBaseline = currentDirty.filter((file) => baseline.fileHashes[file] !== currentHashes[file]);
  if (!baseline.headRevision && !headRevision) changedAfterBaseline.push(...Object.keys(baseline.fileHashes).filter((file) => !(file in currentHashes)));
  const committed = baseline.headRevision && headRevision && baseline.headRevision !== headRevision
    ? (await git(root, ["diff", "--name-only", baseline.headRevision, headRevision, "--", ".", ":(exclude).codegate"])).split(/\r?\n/).filter(Boolean).map(normalize)
    : [];
  const changedFiles = [...new Set([...committed, ...changedAfterBaseline])];
  const committedDiff = baseline.headRevision && headRevision && baseline.headRevision !== headRevision ? await git(root, ["diff", "--no-ext-diff", "--unified=3", baseline.headRevision, headRevision, "--", ".", ":(exclude).codegate"]) : "";
  const workingDiff = await git(root, ["diff", "--no-ext-diff", "--unified=3", "HEAD", "--", ".", ":(exclude).codegate"]);
  const untracked = new Set((await git(root, ["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).codegate"])).split(/\r?\n/).filter(Boolean).map(normalize));
  const supplementalContent = await changedFileContent(root, changedFiles.filter((file) => untracked.has(file) || !headRevision));
  const diff = [committedDiff, workingDiff, supplementalContent].filter(Boolean).join("\n").slice(0, 200_000);
  return { headRevision, changedFiles, diff, baselineDirtyFiles: baseline.changedFiles, currentFileHashes: currentHashes };
}

export function isSafeWorkspacePath(root: string, value: string) {
  const absolute = path.resolve(root, value);
  const relative = path.relative(path.resolve(root), absolute);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative) && normalize(relative) !== ".codegate" && !normalize(relative).startsWith(".codegate/");
}
