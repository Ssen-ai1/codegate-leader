const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");

async function workflow(root) {
  const mod = await import(path.join(__dirname, "../dist/core/workflow.js"));
  return new mod.LeaderWorkflow(root);
}

async function snapshot(flow) {
  return { state: await flow.store.state(), task: await flow.store.task(), plan: await flow.store.plan(), environment: await flow.store.environment(), learningProfile: await flow.store.learningProfile() };
}

function agent(value) {
  return ["generic", "codex", "claude-code"].includes(value) ? value : "generic";
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  await window.loadFile(path.join(__dirname, "renderer.html"));
}

app.whenReady().then(async () => {
  ipcMain.handle("leader:open", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    if (result.canceled) return null;
    const flow = await workflow(result.filePaths[0]);
    await flow.init();
    return { root: result.filePaths[0], ...(await snapshot(flow)) };
  });

  ipcMain.handle("leader:status", async (_event, root) => {
    const flow = await workflow(root);
    await flow.init();
    return snapshot(flow);
  });

  ipcMain.handle("leader:latest-handoff", async (_event, root) => {
    const flow = await workflow(root);
    await flow.init();
    const state = await flow.store.state();
    return state.currentStepId ? flow.store.latestHandoff(state.currentStepId) : null;
  });

  ipcMain.handle("leader:intake", async (_event, root) => {
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

  ipcMain.handle("leader:action", async (_event, root, action, value) => {
    const flow = await workflow(root);
    if (action === "approve-task") await flow.approveTask();
    else if (action === "set-learning-profile") await flow.setLearningProfile({ level: value?.level ?? "intermediate", preferredDepth: value?.depth ?? "standard", knownTopics: [], learningGoals: [], recurringConfusions: [] });
    else if (action === "leader-analyze") return { analysis: await flow.analyzeWithLeader(String(value?.message ?? "")), ...(await snapshot(flow)) };
    else if (action === "confirm-environment") await flow.confirmEnvironment();
    else if (action === "architecture") await flow.architecture("Desktop decision", String(value?.decision ?? value ?? ""));
    else if (action === "plan") await flow.createPlan();
    else if (action === "approve-plan") await flow.approvePlanWithPatch();
    else if (action === "next") return { handoff: await flow.handoff(agent(value?.agent)), ...(await snapshot(flow)) };
    else if (action === "correct") return { handoff: await flow.correct(agent(value?.agent)), ...(await snapshot(flow)) };
    else if (action === "explain") return { mentor: await flow.explain(), ...(await snapshot(flow)) };
    else if (action === "ask-mentor") return { mentor: await flow.askMentor(String(value?.question ?? "")), ...(await snapshot(flow)) };
    return snapshot(flow);
  });

  ipcMain.handle("leader:report", async (_event, root, mode) => {
    const chosen = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "Execution Report", extensions: ["json"] }]
    });
    if (chosen.canceled) return null;
    const report = JSON.parse(await fs.readFile(chosen.filePaths[0], "utf8"));
    const flow = await workflow(root);
    if (mode === "ingest") await flow.ingest(report);
    else if (mode === "review") return { review: await flow.reviewWithEvidence(report), ...(await snapshot(flow)) };
    return snapshot(flow);
  });

  await createWindow();
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
