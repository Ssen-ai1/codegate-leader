# CodeGate Leader 授权服务协议（客户端已实现）

本文定义桌面客户端 `0.2.0-alpha.9` 所接受的最小授权协议。它是未来可选托管服务或官方商业发行的后端实现合同，不代表线上授权服务已经部署，也不限制或改变仓库源码适用的 Apache-2.0 许可证。

## 信任模型

- 订阅权益只由服务端签名载荷决定，本地设置和本地文件不能激活权益。
- 客户端内置 Ed25519 公钥；私钥只能存在于授权服务的密钥管理系统中。
- 载荷绑定 `product=codegate-leader` 和当前 `installationId`，不能复制到另一台安装实例。
- 服务不可用时，客户端只接受仍在 `offlineUntil` 期限内的已签名缓存，并降级显示为 `grace`。
- Token 使用 Windows `safeStorage` 加密；诊断导出不包含 Token 或签名缓存。

## 请求

`GET {serviceUrl}/v1/license/status?product=codegate-leader&version={appVersion}`

请求头：

```text
Accept: application/json
Authorization: Bearer <opaque-access-token>
X-CodeGate-Installation: <installation-uuid>
```

正式环境必须使用 HTTPS。Token 应可吊销、短期有效且不得承载可由客户端自行修改的权益声明。

## 响应信封

```json
{
  "payload": "<base64url(UTF-8 JSON)>",
  "signature": "<base64url(Ed25519 signature over exact payload bytes)>"
}
```

解码后的载荷：

```json
{
  "product": "codegate-leader",
  "installationId": "7c73557f-...",
  "status": "active",
  "plan": "pro",
  "accountLabel": "user@example.com",
  "features": ["commercial-workspaces"],
  "issuedAt": "2026-08-24T11:00:00.000Z",
  "expiresAt": "2026-09-24T11:00:00.000Z",
  "offlineUntil": "2026-08-31T11:00:00.000Z"
}
```

`status` 只能是 `trial | active | grace | expired | revoked`。时间字段使用 ISO 8601 UTC；`offlineUntil` 必须短于订阅有效期，并由服务端按风险策略决定。

## 客户端判定

1. 验证响应结构、Base64URL 和 Ed25519 签名。
2. 验证产品、安装实例、状态枚举和时间字段。
3. 拒绝签发时间超过本机当前时间 5 分钟的载荷。
4. 在线有效响应以原始签名信封原子写入本机缓存。
5. 在线失败时重新验签缓存；仅 `active/trial/grace` 且未超过 `offlineUntil` 时进入离线宽限。
6. 签名错误、实例不匹配、缓存过期或已撤销均不得授予权益。

## 发布配置

正式构建必须在 `desktop/release-config.cjs` 内置授权服务 URL 和公钥，或由受控构建环境注入同等值。`npm run release:check` 会拒绝没有 HTTPS 地址或 PEM 公钥的商业构建。

## 后端上线验收

- 私钥轮换、吊销、审计日志、速率限制和异常检测已经部署。
- 服务端测试覆盖错误实例、篡改载荷、过期宽限、吊销和时钟偏差。
- 客户端与生产公钥完成一次真实端到端验收。
- 登录/购买/退款/取消订阅流程与最终 EULA、隐私政策一致。
