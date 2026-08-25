import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd(), packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const exists = async (relative) => access(path.join(root, relative)).then(() => true).catch(() => false);
const releaseConfig = await import(pathToFileURL(path.join(root, "desktop", "release-config.cjs")).href).then((module) => module.default ?? module);
const issues = [];
const requireCondition = (condition, code, description, owner) => { if (!condition) issues.push({ code, description, owner }); };
const isHttps = (value) => { try { return new URL(String(value)).protocol === "https:"; } catch { return false; } };
const legalApproved = process.env.CODEGATE_LEGAL_APPROVED === "1";
const updateFeedUrl = process.env.CODEGATE_UPDATE_FEED_URL || releaseConfig.updateFeedUrl;
const licenseServiceUrl = process.env.CODEGATE_LICENSE_SERVICE_URL || releaseConfig.licenseServiceUrl;
const licensePublicKey = process.env.CODEGATE_LICENSE_PUBLIC_KEY || releaseConfig.licensePublicKeyPem;

requireCondition(!String(packageJson.version).includes("-"), "prerelease-version", "商业发布版本不能使用 alpha/beta 预发布号。", "engineering");
requireCondition(packageJson.author && !/contributors/i.test(String(packageJson.author)), "publisher-identity", "必须配置可核验的发行商法律实体。", "business/legal");
requireCondition(Boolean(packageJson.build?.win?.icon) && await exists(packageJson.build?.win?.icon ?? ""), "windows-icon", "必须提供已授权的 Windows 品牌图标。", "brand");
requireCondition(packageJson.build?.win?.signAndEditExecutable !== false && Boolean(process.env.CSC_LINK || process.env.WIN_CSC_LINK), "code-signing", "必须启用 Windows 代码签名并在发布环境提供证书。", "release");
requireCondition(await exists("EULA.md") && legalApproved, "eula", "必须由法律顾问批准 EULA.md，并由发布流水线显式确认法律审批。", "legal");
requireCondition(await exists("PRIVACY.md") && legalApproved, "privacy", "必须提供与实际数据处理一致的 PRIVACY.md，并由发布流水线显式确认法律审批。", "legal");
requireCondition(isHttps(updateFeedUrl), "update-feed", "发布流水线或内置配置必须提供 HTTPS 更新清单地址。", "operations");
requireCondition(isHttps(licenseServiceUrl) && /BEGIN PUBLIC KEY/.test(String(licensePublicKey)), "license-service", "盈利版本必须内置 HTTPS 授权服务地址和 Ed25519 验签公钥，不能依赖用户环境变量或本地开关。", "business/backend");

const result = { ready: issues.length === 0, product: packageJson.productName ?? packageJson.build?.productName ?? packageJson.name, version: packageJson.version, checkedAt: new Date().toISOString(), issues };
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes("--strict") && issues.length) process.exitCode = 1;
