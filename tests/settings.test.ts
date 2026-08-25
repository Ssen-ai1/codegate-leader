import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { createSettingsManager } = require("../desktop/settings.cjs") as { createSettingsManager: (root: string, safeStorage: { isEncryptionAvailable(): boolean; encryptString(value: string): Buffer; decryptString(value: Buffer): string }) => { load(): Promise<Record<string, unknown>>; save(value: Record<string, unknown>): Promise<Record<string, unknown>>; recordRecent(value: string): Promise<string[]>; removeRecent(value: string): Promise<string[]>; licenseCredentials(): { serviceUrl: string; token: string; installationId: string } } };
const roots: string[] = [];
afterEach(async () => { delete process.env.CODEGATE_LEADER_API_KEY; await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const secureStorage = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from([...value].reverse().join("")), decryptString: (value: Buffer) => [...value.toString("utf8")].reverse().join("") };

describe("Desktop product settings", () => {
  it("persists API keys encrypted and returns only configuration status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-settings-")); roots.push(root);
    const manager = createSettingsManager(root, secureStorage); await manager.load();
    const saved = await manager.save({ apiKey: "sk-commercial-secret", licenseServiceUrl: "https://license.example.com", licenseToken: "license-commercial-secret", leaderModel: "leader-model", reviewModel: "review-model", baseUrl: "https://example.com/v1", modelTimeoutMs: 5000, verificationTimeoutMs: 6000, modelInputUsdPerMillion: 2.5, modelOutputUsdPerMillion: 10 });

    expect(saved).toMatchObject({ apiKeyConfigured: true, licenseConfigured: true, licenseServiceUrl: "https://license.example.com", leaderModel: "leader-model", reviewModel: "review-model", modelInputUsdPerMillion: 2.5, modelOutputUsdPerMillion: 10 });
    expect(saved).not.toHaveProperty("apiKey");
    const file = await readFile(path.join(root, "settings.json"), "utf8");
    expect(file).not.toContain("sk-commercial-secret");
    expect(file).not.toContain("license-commercial-secret");
    expect(process.env.CODEGATE_LEADER_API_KEY).toBe("sk-commercial-secret");
    expect(process.env.CODEGATE_MODEL_INPUT_USD_PER_MILLION).toBe("2.5");
    expect(manager.licenseCredentials()).toMatchObject({ serviceUrl: "https://license.example.com", token: "license-commercial-secret" });
    const reloaded = createSettingsManager(root, secureStorage); expect(await reloaded.load()).toMatchObject({ apiKeyConfigured: true });
  });

  it("rejects insecure remote model endpoints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-settings-")); roots.push(root);
    const manager = createSettingsManager(root, secureStorage); await manager.load();
    await expect(manager.save({ baseUrl: "http://example.com/v1" })).rejects.toThrow("HTTPS");
  });

  it("normalizes the DeepSeek dashboard URL to the official API endpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-settings-")); roots.push(root);
    const manager = createSettingsManager(root, secureStorage); await manager.load();
    expect(await manager.save({ baseUrl: "https://platform.deepseek.com" })).toMatchObject({ baseUrl: "https://api.deepseek.com" });
    expect(process.env.CODEGATE_LEADER_BASE_URL).toBe("https://api.deepseek.com");
  });

  it("persists a bounded, most-recent-first project history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-settings-")); roots.push(root);
    const manager = createSettingsManager(root, secureStorage); await manager.load();
    const first = path.join(root, "first"), second = path.join(root, "second");
    await manager.recordRecent(first); await manager.recordRecent(second); await manager.recordRecent(first);
    expect((await manager.load()).recentProjects).toEqual([path.resolve(first), path.resolve(second)]);
    expect(await manager.removeRecent(first)).toEqual([path.resolve(second)]);
  });
});
