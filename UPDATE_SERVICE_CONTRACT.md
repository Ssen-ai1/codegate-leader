# CodeGate Leader 更新服务协议

本文描述未来可选官方更新服务的接口，不改变仓库源码适用的 Apache-2.0 许可证；自行构建和分发可以采用自己的兼容更新机制。

当前客户端提供显式“检查更新”，不会在用户不知情时安装软件。本合同定义更新清单；正式下载与安装仍必须使用经过 Windows 代码签名的安装包。

## 请求

客户端对配置的 HTTPS 地址发起 GET，并追加：

```text
platform=win32&arch=x64&currentVersion=0.2.0-alpha.9
```

## 响应

```json
{
  "version": "1.0.1",
  "downloadUrl": "https://downloads.example.com/CodeGate-Leader-1.0.1.exe",
  "sha256": "64-character-lowercase-or-uppercase-hex",
  "notes": "修复说明与升级注意事项",
  "publishedAt": "2026-08-24T11:00:00.000Z"
}
```

客户端要求 `downloadUrl` 使用 HTTPS，并要求 `sha256` 是 64 位十六进制值。发现更新后会显示版本、说明与哈希，并由用户明确点击后在系统浏览器打开下载地址；Alpha 版本不自动下载或自动安装。

## 正式发布要求

- 更新清单和安装包由不同权限的发布流程生成并审计。
- 安装包 SHA-256 与清单一致，且 Authenticode 签名有效、发行者与应用一致。
- CDN 禁止降级到 HTTP，清单不可被缓存到超过撤回窗口。
- 提供分阶段发布、紧急撤回、最低兼容版本和回滚说明。
- 自动更新若在后续版本启用，必须在安装前再次校验哈希和代码签名，并向用户展示版本与变更说明。
