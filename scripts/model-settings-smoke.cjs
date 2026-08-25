const { app, safeStorage } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createSettingsManager } = require("../desktop/settings.cjs");
const configuredUserData = path.resolve(process.argv[2] ?? app.getPath("userData"));
app.setPath("userData", configuredUserData);

app.whenReady().then(async () => {
  try {
    const settings = createSettingsManager(configuredUserData, safeStorage);
    const configured = await settings.load();
    const moduleUrl = pathToFileURL(path.resolve(__dirname, "../dist/core/leader-model.js")).href;
    const { LeaderModelClient } = await import(moduleUrl);
    const client = new LeaderModelClient(), result = await client.testConnection();
    const consultation = process.argv.includes("--consult") ? await client.consult('{"state":{"status":"new"},"task":null,"plan":null}', "下一步怎么做？", "项目已打开，但尚未导入任务资料；下一步点击导入任务资料。") : undefined;
    console.log(JSON.stringify({ ...result, apiKeyConfigured: configured.apiKeyConfigured, ...(consultation ? { consultation } : {}) }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally { app.quit(); }
});
