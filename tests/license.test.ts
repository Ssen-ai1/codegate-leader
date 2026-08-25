import { createRequire } from "node:module";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { createLicenseClient, verifyEnvelope } = require("../desktop/license.cjs") as {
  createLicenseClient(input: Record<string, unknown>): { status(): Promise<Record<string, unknown>> };
  verifyEnvelope(envelope: Record<string, string>, publicKey: string, installationId: string, now?: Date): Record<string, unknown>;
};
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function signedEnvelope(installationId: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = Buffer.from(JSON.stringify({ product: "codegate-leader", installationId, status: "active", plan: "pro", accountLabel: "Commercial Test", features: ["leader-model"], issuedAt: "2026-08-24T00:00:00.000Z", expiresAt: "2026-09-24T00:00:00.000Z", offlineUntil: "2026-08-31T00:00:00.000Z" }));
  return { publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(), envelope: { payload: payload.toString("base64url"), signature: sign(null, payload, privateKey).toString("base64url") } };
}

describe("Signed subscription client", () => {
  it("accepts only a signed entitlement bound to the current installation", () => {
    const { publicKey, envelope } = signedEnvelope("install-1");
    expect(verifyEnvelope(envelope, publicKey, "install-1", new Date("2026-08-24T12:00:00Z"))).toMatchObject({ status: "active", plan: "pro", installationId: "install-1" });
    expect(() => verifyEnvelope(envelope, publicKey, "other-install")).toThrow("当前安装实例");
    expect(() => verifyEnvelope({ ...envelope, signature: envelope.signature.slice(0, -2) + "aa" }, publicKey, "install-1")).toThrow("签名无效");
  });

  it("uses a verified server response and only falls back to its signed offline grace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-license-")); roots.push(root);
    const { publicKey, envelope } = signedEnvelope("install-1");
    const credentials = () => ({ serviceUrl: "https://license.example.test", token: "secret", installationId: "install-1" });
    const online = createLicenseClient({ userData: root, getCredentials: credentials, productVersion: "1.0.0", publicKeyPem: publicKey, fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 200 })) });
    expect(await online.status()).toMatchObject({ configured: true, source: "server", status: "active", plan: "pro" });
    const offline = createLicenseClient({ userData: root, getCredentials: credentials, productVersion: "1.0.0", publicKeyPem: publicKey, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) });
    vi.setSystemTime(new Date("2026-08-25T00:00:00Z"));
    try { expect(await offline.status()).toMatchObject({ source: "signed-cache", status: "grace", plan: "pro" }); }
    finally { vi.useRealTimers(); }
  });

  it("does not pretend an unconfigured Alpha has a paid entitlement", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "codegate-license-")); roots.push(root);
    const client = createLicenseClient({ userData: root, getCredentials: () => ({ serviceUrl: "", token: "", installationId: "install-1" }), productVersion: "0.2.0-alpha.7" });
    expect(await client.status()).toMatchObject({ configured: false, status: "unconfigured", source: "none" });
  });
});
