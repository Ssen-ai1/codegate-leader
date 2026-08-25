const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const allowedStatuses = new Set(["trial", "active", "grace", "expired", "revoked"]);
const decode = (value) => Buffer.from(String(value), "base64url");

function verifyEnvelope(envelope, publicKeyPem, installationId, now = new Date()) {
  if (!envelope || typeof envelope.payload !== "string" || typeof envelope.signature !== "string") throw new Error("授权服务响应缺少签名载荷。");
  if (!publicKeyPem) throw new Error("应用未配置授权签名公钥，不能信任订阅状态。");
  const payloadBytes = decode(envelope.payload), signature = decode(envelope.signature);
  if (!crypto.verify(null, payloadBytes, publicKeyPem, signature)) throw new Error("订阅状态签名无效，已拒绝使用。");
  let payload;
  try { payload = JSON.parse(payloadBytes.toString("utf8")); } catch { throw new Error("授权载荷不是有效 JSON。"); }
  if (!allowedStatuses.has(payload.status)) throw new Error("授权载荷包含未知状态。");
  if (payload.product !== "codegate-leader") throw new Error("授权载荷不属于 CodeGate Leader。");
  if (payload.installationId !== installationId) throw new Error("授权载荷不属于当前安装实例。");
  for (const field of ["issuedAt", "expiresAt", "offlineUntil"]) if (payload[field] !== null && payload[field] !== undefined && !Number.isFinite(Date.parse(payload[field]))) throw new Error(`授权载荷字段 ${field} 不是有效时间。`);
  if (payload.issuedAt && Date.parse(payload.issuedAt) > now.getTime() + 5 * 60_000) throw new Error("授权载荷签发时间来自未来。");
  return { status: payload.status, plan: String(payload.plan ?? "unknown"), accountLabel: String(payload.accountLabel ?? ""), expiresAt: payload.expiresAt ?? null, offlineUntil: payload.offlineUntil ?? null, features: Array.isArray(payload.features) ? payload.features.filter((item) => typeof item === "string") : [], installationId: payload.installationId, product: payload.product, issuedAt: payload.issuedAt ?? null };
}

function createLicenseClient({ userData, getCredentials, productVersion, fetchImpl = fetch, publicKeyPem = process.env.CODEGATE_LICENSE_PUBLIC_KEY ?? "" }) {
  const cachePath = path.join(userData, "license-cache.json");
  const saveCache = async (envelope) => { const temporary = cachePath + ".tmp"; await fs.mkdir(userData, { recursive: true }); await fs.writeFile(temporary, JSON.stringify(envelope, null, 2) + "\n", "utf8"); await fs.rename(temporary, cachePath); };
  const cached = async () => { try { return JSON.parse(await fs.readFile(cachePath, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw new Error("本地授权缓存损坏：" + error.message); } };
  return {
    async status() {
      const credentials = getCredentials();
      if (!credentials.serviceUrl || !credentials.token) return { configured: false, source: "none", status: "unconfigured", plan: null, accountLabel: "", expiresAt: null, offlineUntil: null, features: [], message: "尚未连接订阅服务；当前 Alpha 不执行付费功能门控。" };
      const endpoint = new URL(credentials.serviceUrl + "/v1/license/status"); endpoint.searchParams.set("product", "codegate-leader"); endpoint.searchParams.set("version", productVersion);
      try {
        const response = await fetchImpl(endpoint, { headers: { Accept: "application/json", Authorization: "Bearer " + credentials.token, "X-CodeGate-Installation": credentials.installationId }, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`授权服务 HTTP ${response.status}`);
        const envelope = await response.json(), verified = verifyEnvelope(envelope, publicKeyPem, credentials.installationId);
        await saveCache(envelope);
        return { configured: true, source: "server", ...verified, message: verified.status === "active" || verified.status === "trial" ? "订阅状态已由服务端签名确认。" : "订阅状态需要处理。" };
      } catch (error) {
        const envelope = await cached().catch(() => null);
        if (envelope) {
          try {
            const verified = verifyEnvelope(envelope, publicKeyPem, credentials.installationId);
            if (verified.offlineUntil && Date.parse(verified.offlineUntil) >= Date.now() && ["active", "trial", "grace"].includes(verified.status)) return { configured: true, source: "signed-cache", ...verified, status: "grace", message: "授权服务暂时不可用，正在使用仍处于离线宽限期的签名状态。" };
          } catch { /* The original online error is more actionable than an invalid cache. */ }
        }
        return { configured: true, source: "error", status: "unavailable", plan: null, accountLabel: "", expiresAt: null, offlineUntil: null, features: [], message: error instanceof Error ? error.message : String(error) };
      }
    },
    cachePath
  };
}

module.exports = { createLicenseClient, verifyEnvelope };
