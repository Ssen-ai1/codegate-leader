const { app, BrowserWindow, ipcMain, dialog, safeStorage, clipboard, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const { pathToFileURL } = require("node:url");
const { createSettingsManager } = require("./settings.cjs");
const { createLicenseClient } = require("./license.cjs");
const releaseConfig = require("./release-config.cjs");
const allowedRoots = new Set();
const allowedProjectParents = new Set();
let mainWindow = null, settings = null, license = null;
const execFileAsync = promisify(execFile);

async function agentAvailability() {
  const candidates = [{ id: "codex", label: "Codex", command: "codex" }, { id: "claude-code", label: "Claude Code", command: "claude" }];
  return Promise.all(candidates.map(async (candidate) => {
    try {
      const finder = process.platform === "win32" ? "where.exe" : "which";
      const { stdout } = await execFileAsync(finder, [candidate.command], { timeout: 3_000, windowsHide: true });
      return { ...candidate, installed: true, path: String(stdout).split(/\r?\n/).find(Boolean) ?? candidate.command };
    } catch { return { ...candidate, installed: false, path: null }; }
  }));
}

async function recordError(channel, error) {
  try {
    const logDirectory = path.join(app.getPath("userData"), "logs");
    await fs.mkdir(logDirectory, { recursive: true });
    await fs.appendFile(path.join(logDirectory, "main.log"), JSON.stringify({ at: new Date().toISOString(), channel, message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }) + "\n", "utf8");
  } catch { /* Error reporting must never hide the original product error. */ }
}

function handle(channel, action) {
  ipcMain.handle(channel, async (...args) => {
    try { return await action(...args); }
    catch (error) { await recordError(channel, error); throw new Error(error instanceof Error ? error.message : String(error)); }
  });
}

async function workflow(root) {
  const resolved = path.resolve(String(root ?? ""));
  if (!allowedRoots.has(resolved)) throw new Error("该项目尚未通过项目选择器授权。");
  const moduleUrl = pathToFileURL(path.join(__dirname, "../dist/core/workflow.js")).href;
  const mod = await import(moduleUrl);
  return new mod.LeaderWorkflow(resolved);
}

async function snapshot(flow) {
  return flow.snapshot();
}

async function runSelfTest() {
  const temporaryRoot = await fs.mkdtemp(path.join(app.getPath("temp"), "codegate-self-test-"));
  allowedRoots.add(temporaryRoot);
  try {
    const flow = await workflow(temporaryRoot), result = await flow.openProject();
    return { ok: result.state.status === "new" && ["healthy", "repaired"].includes(result.health.status), state: result.state.status, health: result.health.status, eventLog: result.eventLog };
  } finally {
    allowedRoots.delete(temporaryRoot);
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  }
}

function agent(value) {
  return ["generic", "codex", "claude-code"].includes(value) ? value : "generic";
}

function compareVersions(left, right) {
  const parts = (value) => String(value).split("-")[0].split(".").map((item) => Number(item) || 0);
  const a = parts(left), b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) { if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0); }
  return 0;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function copySourceIntoProject(root, sourceFile, category = "sources") {
  const resolvedRoot = path.resolve(root), resolvedSource = path.resolve(sourceFile);
  const stat = await fs.stat(resolvedSource).catch(() => null);
  if (!stat?.isFile()) throw new Error("没有找到所选资料文件。");
  if (stat.size > 80 * 1024 * 1024) throw new Error("单个资料文件不能超过 80 MB。");
  if (isInside(resolvedRoot, resolvedSource)) return path.relative(resolvedRoot, resolvedSource);
  const safeName = path.basename(resolvedSource).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "source";
  const relativeDirectory = path.join(".codegate", "task", category);
  const targetDirectory = path.join(resolvedRoot, relativeDirectory);
  await fs.mkdir(targetDirectory, { recursive: true });
  const targetName = `${Date.now()}-${safeName}`;
  const target = path.join(targetDirectory, targetName);
  await fs.copyFile(resolvedSource, target);
  return path.join(relativeDirectory, targetName);
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1320,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    icon: path.join(__dirname, "../assets/app-icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault(); });
  await window.loadFile(path.join(__dirname, "renderer.html"));
  mainWindow = window;
  window.on("closed", () => { if (mainWindow === window) mainWindow = null; });
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();
app.on("second-instance", () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  settings = createSettingsManager(app.getPath("userData"), safeStorage);
  await settings.load();
  license = createLicenseClient({
    userData: app.getPath("userData"),
    getCredentials: () => {
      const credentials = settings.licenseCredentials();
      return { ...credentials, serviceUrl: credentials.serviceUrl || releaseConfig.licenseServiceUrl };
    },
    productVersion: app.getVersion(),
    publicKeyPem: process.env.CODEGATE_LICENSE_PUBLIC_KEY || releaseConfig.licensePublicKeyPem
  });
  process.on("uncaughtException", (error) => { void recordError("uncaughtException", error); });
  process.on("unhandledRejection", (error) => { void recordError("unhandledRejection", error); });

  handle("leader:open", async () => {
    const e2eRoot = !app.isPackaged ? process.env.CODEGATE_E2E_PROJECT_ROOT : undefined;
    const result = e2eRoot ? { canceled: false, filePaths: [e2eRoot] } : await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const selectedRoot = path.resolve(result.filePaths[0]);
    allowedRoots.add(selectedRoot);
    const flow = await workflow(selectedRoot);
    const opened = { root: selectedRoot, ...(await flow.openProject()) };
    await settings.recordRecent(selectedRoot);
    return opened;
  });

  handle("leader:recent", async () => settings.get().recentProjects);

  handle("leader:recent-details", async () => Promise.all(settings.get().recentProjects.map(async (projectRoot) => {
    const fallback = { root: projectRoot, name: path.basename(projectRoot), title: path.basename(projectRoot), status: "new", updatedAt: null, exists: false };
    const projectStat = await fs.stat(projectRoot).catch(() => null);
    if (!projectStat?.isDirectory()) return fallback;
    const [stateText, taskText] = await Promise.all([
      fs.readFile(path.join(projectRoot, ".codegate", "state.json"), "utf8").catch(() => ""),
      fs.readFile(path.join(projectRoot, ".codegate", "task", "task-spec.json"), "utf8").catch(() => "")
    ]);
    let state = null, task = null;
    try { state = stateText ? JSON.parse(stateText) : null; } catch { /* A full open will provide a recoverable health error. */ }
    try { task = taskText ? JSON.parse(taskText) : null; } catch { /* A full open will provide a recoverable health error. */ }
    return { ...fallback, title: typeof task?.title === "string" ? task.title : fallback.title, status: typeof state?.status === "string" ? state.status : "new", updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : projectStat.mtime.toISOString(), exists: true };
  })));

  handle("leader:open-recent", async (_event, root) => {
    const selectedRoot = path.resolve(String(root ?? ""));
    if (!settings.get().recentProjects.includes(selectedRoot)) throw new Error("该目录不在最近项目列表中。");
    const stat = await fs.stat(selectedRoot).catch(() => null);
    if (!stat?.isDirectory()) { await settings.removeRecent(selectedRoot); throw new Error("项目目录已经不存在，已从最近项目中移除。"); }
    allowedRoots.add(selectedRoot);
    const flow = await workflow(selectedRoot);
    const opened = { root: selectedRoot, ...(await flow.openProject()) };
    await settings.recordRecent(selectedRoot);
    return opened;
  });

  handle("leader:choose-create-location", async () => {
    const e2eParent = !app.isPackaged ? process.env.CODEGATE_E2E_CREATE_PARENT : undefined;
    const result = e2eParent ? { canceled: false, filePaths: [e2eParent] } : await dialog.showOpenDialog({ defaultPath: app.getPath("documents"), properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const parent = path.resolve(result.filePaths[0]);
    allowedProjectParents.add(parent);
    return parent;
  });

  handle("leader:create", async (_event, value) => {
    const parent = path.resolve(String(value?.parent ?? ""));
    const projectName = String(value?.projectName ?? "").trim();
    if (!allowedProjectParents.has(parent)) throw new Error("请先通过位置选择器选择项目保存位置。");
    if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,63}$/u.test(projectName) || /[. ]$/.test(projectName)) throw new Error("项目名称需为 1～64 个字符，只能包含文字、数字、空格、点、下划线或连字符。");
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(projectName)) throw new Error("该名称是 Windows 保留名称，请更换项目名称。");
    const target = path.resolve(parent, projectName);
    if (path.dirname(target) !== parent) throw new Error("项目路径不安全。");
    try { await fs.mkdir(target, { recursive: false }); }
    catch (error) { if (error?.code === "EEXIST") throw new Error("同名目录已经存在；请更换项目名称或打开已有项目。"); throw error; }
    try {
      allowedRoots.add(target);
      const flow = await workflow(target);
      await flow.openProject();
      const mode = value?.mode === "competition" ? "competition" : "product";
      await flow.setProjectMode(mode);
      if (mode === "product") await flow.startFromIdea({ projectName, idea: String(value?.idea ?? ""), targetUsers: String(value?.targetUsers ?? ""), platform: String(value?.platform ?? ""), constraints: String(value?.constraints ?? "") });
      const introduction = mode === "competition"
        ? "本项目使用 CodeGate Leader 竞赛冲刺模式。请在应用中导入赛题 PDF 或 Markdown，并选择要挑战的具体题目。"
        : String(value?.idea ?? "").trim();
      await fs.writeFile(path.join(target, "README.md"), `# ${projectName}\n\n${introduction}\n\n> Project planning is managed by CodeGate Leader in .codegate/.\n`, { encoding: "utf8", flag: "wx" });
      await settings.recordRecent(target);
      return { root: target, ...(await snapshot(flow)) };
    } catch (error) {
      allowedRoots.delete(target);
      await fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      throw error;
    }
  });

  handle("leader:status", async (_event, root) => {
    const flow = await workflow(root);
    await flow.init();
    return snapshot(flow);
  });

  handle("leader:latest-handoff", async (_event, root) => {
    const flow = await workflow(root);
    await flow.init();
    const state = await flow.store.state();
    return state.currentStepId ? flow.store.latestHandoff(state.currentStepId) : null;
  });

  handle("leader:intake", async (_event, root) => {
    const chosen = await dialog.showOpenDialog({
      defaultPath: root,
      properties: ["openFile"],
      filters: [{ name: "Task source", extensions: ["md", "txt", "pdf", "docx", "png", "jpg", "jpeg", "webp", "bmp", "tiff"] }]
    });
    if (chosen.canceled) return null;
    const taskFile = chosen.filePaths[0];
    if (!isInside(root, taskFile)) throw new Error("任务资料必须位于当前项目目录内。");
    const flow = await workflow(root);
    await flow.intake(path.relative(root, taskFile));
    return snapshot(flow);
  });

  handle("leader:competition:inspect", async (_event, root) => {
    const e2eSource = !app.isPackaged ? process.env.CODEGATE_E2E_COMPETITION_SOURCE : undefined;
    const chosen = e2eSource ? { canceled: false, filePaths: [e2eSource] } : await dialog.showOpenDialog({
      defaultPath: root,
      properties: ["openFile"],
      filters: [{ name: "赛题资料", extensions: ["md", "txt", "pdf", "docx", "png", "jpg", "jpeg", "webp", "bmp", "tiff"] }]
    });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const flow = await workflow(root);
    const relativeSource = await copySourceIntoProject(root, chosen.filePaths[0], "competition-sources");
    return { ...(await flow.inspectCompetitionSource(relativeSource)), ...(await snapshot(flow)) };
  });

  handle("leader:add-source", async (_event, root) => {
    const chosen = await dialog.showOpenDialog({ defaultPath: root, properties: ["openFile"], filters: [{ name: "Task source", extensions: ["md", "txt", "csv", "json", "pdf", "docx", "png", "jpg", "jpeg", "webp", "bmp", "tiff"] }] });
    if (chosen.canceled) return null;
    const sourceFile = chosen.filePaths[0];
    if (!isInside(root, sourceFile)) throw new Error("任务资料必须位于当前项目目录内。");
    const flow = await workflow(root); await flow.addSourceMaterial(path.relative(root, sourceFile)); return snapshot(flow);
  });

  handle("leader:action", async (_event, root, action, value) => {
    const flow = await workflow(root);
    if (action === "start-idea") await flow.startFromIdea({ projectName: String(value?.projectName ?? path.basename(root)), idea: String(value?.idea ?? ""), targetUsers: String(value?.targetUsers ?? ""), platform: String(value?.platform ?? ""), constraints: String(value?.constraints ?? "") });
    else if (action === "approve-task") await flow.approveTask();
    else if (action === "clarify") await flow.clarify(String(value?.questionId ?? ""), String(value?.answer ?? ""));
    else if (action === "revise-task") return { revisedTask: await flow.reviseTaskFromUi(value ?? {}), ...(await snapshot(flow)) };
    else if (action === "revise-plan") return { revisedPlan: await flow.revisePlanFromUi(value ?? {}), ...(await snapshot(flow)) };
    else if (action === "set-learning-profile") await flow.setLearningProfile({ level: value?.level ?? "intermediate", preferredDepth: value?.depth ?? "standard", knownTopics: [], learningGoals: [], recurringConfusions: [] });
    else if (action === "consult") return { consultation: await flow.consult(String(value?.message ?? "")), ...(await snapshot(flow)) };
    else if (action === "leader-analyze") return { analysis: await flow.analyzeWithLeader(String(value?.message ?? "")), ...(await snapshot(flow)) };
    else if (action === "confirm-environment") await flow.confirmEnvironment();
    else if (action === "verify") return { verification: await flow.runVerification(String(value?.command ?? ""), value?.confirmed === true), ...(await snapshot(flow)) };
    else if (action === "architecture") await flow.architecture("Desktop decision", String(value?.decision ?? value ?? ""));
    else if (action === "recommend-architecture") return { architectureRecommendation: await flow.recommendArchitecture(), ...(await snapshot(flow)) };
    else if (action === "plan") await flow.createPlan();
    else if (action === "approve-plan") await flow.approvePlanWithPatch();
    else if (action === "next") return { handoff: await flow.handoff(agent(value?.agent)), ...(await snapshot(flow)) };
    else if (action === "correct") return { handoff: await flow.correct(agent(value?.agent)), ...(await snapshot(flow)) };
    else if (action === "explain") return { mentor: await flow.explain(), ...(await snapshot(flow)) };
    else if (action === "ask-mentor") return { mentor: await flow.askMentor(String(value?.question ?? "")), ...(await snapshot(flow)) };
    else if (action === "resolve-decision") return { resolution: await flow.resolveDecision(String(value?.decisionId ?? ""), String(value?.resolution ?? "request-correction")), ...(await snapshot(flow)) };
    else if (action === "reopen-task") return { task: await flow.reopenTask(String(value?.reason ?? "User requested a task revision.")), ...(await snapshot(flow)) };
    else if (action === "reopen-architecture") return { architectureRevision: await flow.reopenArchitecture(String(value?.reason ?? "User requested an architecture revision.")), ...(await snapshot(flow)) };
    else if (action === "competition-intake") { await flow.intakeCompetition(String(value?.sourceFile ?? ""), String(value?.challengeId ?? "")); return snapshot(flow); }
    else if (action === "competition-debug") return { debugSession: await flow.startCompetitionDebug(value ?? {}), ...(await snapshot(flow)) };
    else if (action === "competition-debug-resolve") return { debugSession: await flow.resolveCompetitionDebug(String(value?.id ?? ""), String(value?.resolution ?? ""), Array.isArray(value?.evidence) ? value.evidence : []), ...(await snapshot(flow)) };
    else if (action === "competition-metric") return { metricRecord: await flow.recordCompetitionMetric(value ?? {}), ...(await snapshot(flow)) };
    else if (action === "competition-defense") return { defenseSession: await flow.createCompetitionDefenseSession(), ...(await snapshot(flow)) };
    return snapshot(flow);
  });

  handle("leader:report", async (_event, root, mode) => {
    const flow = await workflow(root);
    let report = await flow.discoverCurrentReport();
    if (!report) {
      const chosen = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "Execution Report", extensions: ["json"] }] });
      if (chosen.canceled) return null;
      report = JSON.parse(await fs.readFile(chosen.filePaths[0], "utf8"));
    }
    if (mode === "ingest") await flow.ingest(report);
    else if (mode === "review") return { review: await flow.reviewWithEvidence(report), ...(await snapshot(flow)) };
    return snapshot(flow);
  });

  handle("leader:settings:get", async () => settings.get());
  handle("leader:settings:save", async (_event, value) => settings.save(value));
  handle("leader:model:test", async () => {
    const moduleUrl = pathToFileURL(path.join(__dirname, "../dist/core/leader-model.js")).href;
    const mod = await import(moduleUrl);
    return new mod.LeaderModelClient().testConnection();
  });
  handle("leader:license:status", async () => license.status());
  handle("leader:clipboard:write", async (_event, value) => {
    const content = String(value ?? "");
    if (!content.trim()) throw new Error("没有可以复制的 Prompt。");
    if (content.length > 500_000) throw new Error("Prompt 过长，不能复制到剪贴板。");
    clipboard.writeText(content);
    return { ok: true, characters: content.length };
  });
  handle("leader:external:open", async (_event, value) => {
    const target = new URL(String(value ?? ""));
    if (target.protocol !== "https:") throw new Error("只能打开 HTTPS 下载地址。");
    await shell.openExternal(target.toString());
    return { opened: true };
  });
  handle("leader:agents:status", async () => ({ platform: process.platform, agents: await agentAvailability() }));
  handle("leader:agent:launch", async (_event, root, agentId) => {
    const resolved = path.resolve(String(root ?? ""));
    if (!allowedRoots.has(resolved)) throw new Error("该项目尚未通过项目选择器授权。");
    if (process.platform !== "win32") throw new Error("当前版本只支持在 Windows 中自动打开本机 Agent。");
    const candidate = (await agentAvailability()).find((item) => item.id === agentId);
    if (!candidate) throw new Error("不支持该 Agent；请复制 Prompt 后手动打开执行环境。");
    if (!candidate.installed) throw new Error(`${candidate.label} 命令行工具未安装或不在 PATH 中；Prompt 已保留，可复制后手动使用。`);
    const child = spawn("cmd.exe", ["/d", "/k", candidate.command], { cwd: resolved, detached: true, stdio: "ignore", windowsHide: false });
    child.unref();
    return { ok: true, agent: candidate.id, label: candidate.label, cwd: resolved };
  });
  handle("leader:self-test", async () => runSelfTest());
  handle("leader:update:check", async () => {
    const configured = settings.get();
    const feedUrl = configured.updateFeedUrl || releaseConfig.updateFeedUrl;
    if (!feedUrl) throw new Error("尚未配置 HTTPS 更新源。");
    const url = new URL(feedUrl); url.searchParams.set("platform", process.platform); url.searchParams.set("arch", process.arch); url.searchParams.set("currentVersion", app.getVersion());
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`更新检查失败：HTTP ${response.status}`);
    const payload = await response.json();
    if (!payload || typeof payload.version !== "string" || typeof payload.downloadUrl !== "string" || !/^[a-f0-9]{64}$/i.test(String(payload.sha256 ?? ""))) throw new Error("更新源返回了无效或缺少 SHA-256 的清单。");
    const downloadUrl = new URL(payload.downloadUrl);
    if (downloadUrl.protocol !== "https:") throw new Error("更新包地址必须使用 HTTPS。");
    return { currentVersion: app.getVersion(), available: compareVersions(payload.version, app.getVersion()) > 0, version: payload.version, downloadUrl: downloadUrl.toString(), sha256: payload.sha256, notes: String(payload.notes ?? ""), publishedAt: payload.publishedAt ?? null, automaticInstallSupported: false };
  });
  handle("leader:diagnostics", async () => {
    const diagnostics = { generatedAt: new Date().toISOString(), productVersion: app.getVersion(), packaged: app.isPackaged, platform: process.platform, architecture: process.arch, versions: process.versions, settings: settings.get(), settingsPath: settings.path, logPath: path.join(app.getPath("userData"), "logs", "main.log"), authorizedProjectCount: allowedRoots.size, selfTest: await runSelfTest() };
    const chosen = await dialog.showSaveDialog({ defaultPath: path.join(app.getPath("documents"), `codegate-diagnostics-${Date.now()}.json`), filters: [{ name: "JSON", extensions: ["json"] }] });
    if (chosen.canceled || !chosen.filePath) return null;
    await fs.writeFile(chosen.filePath, JSON.stringify(diagnostics, null, 2) + "\n", "utf8");
    return { path: chosen.filePath, diagnostics };
  });

  await createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
