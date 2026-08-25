const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const defaults = Object.freeze({
  baseUrl: "https://api.openai.com/v1",
  leaderModel: "gpt-5",
  reviewModel: "gpt-5",
  modelTimeoutMs: 60000,
  verificationTimeoutMs: 120000,
  modelInputUsdPerMillion: 0,
  modelOutputUsdPerMillion: 0,
  updateFeedUrl: "",
  licenseServiceUrl: "",
  recentProjects: []
});

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function validateUrl(value, allowEmpty = false) {
  if (allowEmpty && !String(value ?? "").trim()) return "";
  const url = new URL(String(value));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("服务地址必须使用 HTTPS；仅本机开发允许 HTTP。");
  if (url.hostname.toLowerCase() === "platform.deepseek.com") { url.protocol = "https:"; url.hostname = "api.deepseek.com"; url.pathname = ""; url.search = ""; url.hash = ""; }
  return url.toString().replace(/\/$/, "");
}

function createSettingsManager(userData, safeStorage) {
  const target = path.join(userData, "settings.json");
  let current = { ...defaults, encryptedApiKey: "", encryptedLicenseToken: "", installationId: randomUUID() };
  const publicValue = () => ({ baseUrl: current.baseUrl, leaderModel: current.leaderModel, reviewModel: current.reviewModel, modelTimeoutMs: current.modelTimeoutMs, verificationTimeoutMs: current.verificationTimeoutMs, modelInputUsdPerMillion: current.modelInputUsdPerMillion, modelOutputUsdPerMillion: current.modelOutputUsdPerMillion, updateFeedUrl: current.updateFeedUrl, licenseServiceUrl: current.licenseServiceUrl, licenseConfigured: Boolean(current.licenseServiceUrl && current.encryptedLicenseToken), installationId: current.installationId, recentProjects: [...current.recentProjects], apiKeyConfigured: Boolean(current.encryptedApiKey), secureStorageAvailable: safeStorage.isEncryptionAvailable() });
  const decryptKey = () => current.encryptedApiKey && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(current.encryptedApiKey, "base64")) : "";
  const decryptLicenseToken = () => current.encryptedLicenseToken && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(current.encryptedLicenseToken, "base64")) : "";
  const apply = () => {
    const key = decryptKey();
    if (key) process.env.CODEGATE_LEADER_API_KEY = key; else delete process.env.CODEGATE_LEADER_API_KEY;
    process.env.CODEGATE_LEADER_BASE_URL = current.baseUrl;
    process.env.CODEGATE_LEADER_MODEL = current.leaderModel;
    process.env.CODEGATE_LEADER_REVIEW_MODEL = current.reviewModel;
    process.env.CODEGATE_LEADER_TIMEOUT_MS = String(current.modelTimeoutMs);
    process.env.CODEGATE_VERIFICATION_TIMEOUT_MS = String(current.verificationTimeoutMs);
    process.env.CODEGATE_MODEL_INPUT_USD_PER_MILLION = String(current.modelInputUsdPerMillion);
    process.env.CODEGATE_MODEL_OUTPUT_USD_PER_MILLION = String(current.modelOutputUsdPerMillion);
  };
  const persist = async () => {
    await fs.mkdir(userData, { recursive: true });
    const temporary = target + ".tmp";
    await fs.writeFile(temporary, JSON.stringify(current, null, 2) + "\n", "utf8");
    await fs.rename(temporary, target);
  };
  return {
    async load() {
      let saved = {};
      try { saved = JSON.parse(await fs.readFile(target, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw new Error("设置文件损坏：" + error.message); }
      current = { ...defaults, ...saved, baseUrl: validateUrl(saved.baseUrl ?? defaults.baseUrl), updateFeedUrl: validateUrl(saved.updateFeedUrl ?? "", true), licenseServiceUrl: validateUrl(saved.licenseServiceUrl ?? "", true), modelTimeoutMs: boundedNumber(saved.modelTimeoutMs, defaults.modelTimeoutMs, 1000, 300000), verificationTimeoutMs: boundedNumber(saved.verificationTimeoutMs, defaults.verificationTimeoutMs, 1000, 600000), modelInputUsdPerMillion: boundedNumber(saved.modelInputUsdPerMillion, defaults.modelInputUsdPerMillion, 0, 100000), modelOutputUsdPerMillion: boundedNumber(saved.modelOutputUsdPerMillion, defaults.modelOutputUsdPerMillion, 0, 100000), recentProjects: Array.isArray(saved.recentProjects) ? saved.recentProjects.filter((item) => typeof item === "string" && path.isAbsolute(item)).slice(0, 8) : [], encryptedApiKey: typeof saved.encryptedApiKey === "string" ? saved.encryptedApiKey : "", encryptedLicenseToken: typeof saved.encryptedLicenseToken === "string" ? saved.encryptedLicenseToken : "", installationId: typeof saved.installationId === "string" && saved.installationId ? saved.installationId : randomUUID() };
      await persist(); apply();
      return publicValue();
    },
    get: publicValue,
    async save(input = {}) {
      const next = { ...current, baseUrl: validateUrl(input.baseUrl ?? current.baseUrl), updateFeedUrl: validateUrl(input.updateFeedUrl ?? current.updateFeedUrl, true), licenseServiceUrl: validateUrl(input.licenseServiceUrl ?? current.licenseServiceUrl, true), leaderModel: String(input.leaderModel ?? current.leaderModel).trim(), reviewModel: String(input.reviewModel ?? current.reviewModel).trim(), modelTimeoutMs: boundedNumber(input.modelTimeoutMs, current.modelTimeoutMs, 1000, 300000), verificationTimeoutMs: boundedNumber(input.verificationTimeoutMs, current.verificationTimeoutMs, 1000, 600000), modelInputUsdPerMillion: boundedNumber(input.modelInputUsdPerMillion, current.modelInputUsdPerMillion, 0, 100000), modelOutputUsdPerMillion: boundedNumber(input.modelOutputUsdPerMillion, current.modelOutputUsdPerMillion, 0, 100000) };
      if (!next.leaderModel || !next.reviewModel) throw new Error("模型名称不能为空。");
      if (Object.prototype.hasOwnProperty.call(input, "apiKey")) {
        const apiKey = String(input.apiKey ?? "").trim();
        if (apiKey && !safeStorage.isEncryptionAvailable()) throw new Error("当前系统安全存储不可用，API Key 未保存。");
        next.encryptedApiKey = apiKey ? safeStorage.encryptString(apiKey).toString("base64") : "";
      }
      if (Object.prototype.hasOwnProperty.call(input, "licenseToken")) {
        const token = String(input.licenseToken ?? "").trim();
        if (token && !safeStorage.isEncryptionAvailable()) throw new Error("当前系统安全存储不可用，订阅凭据未保存。");
        next.encryptedLicenseToken = token ? safeStorage.encryptString(token).toString("base64") : "";
      }
      current = next;
      await persist(); apply();
      return publicValue();
    },
    async recordRecent(projectRoot) {
      const resolved = path.resolve(String(projectRoot));
      current.recentProjects = [resolved, ...current.recentProjects.filter((item) => path.resolve(item) !== resolved)].slice(0, 8);
      await persist();
      return [...current.recentProjects];
    },
    async removeRecent(projectRoot) {
      const resolved = path.resolve(String(projectRoot));
      current.recentProjects = current.recentProjects.filter((item) => path.resolve(item) !== resolved);
      await persist();
      return [...current.recentProjects];
    },
    licenseCredentials: () => ({ serviceUrl: current.licenseServiceUrl, token: decryptLicenseToken(), installationId: current.installationId }),
    path: target
  };
}

module.exports = { createSettingsManager, defaults };
