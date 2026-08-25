# CodeGate Leader 商业发布 Runbook

## 软件侧发布步骤

1. 将版本从预发布号提升为正式 SemVer。
2. 设置可核验的发行商法律实体，并取得 Windows 代码签名证书。
3. 在受控构建中写入 HTTPS 更新源、HTTPS 授权服务和 Ed25519 公钥。
4. 法律顾问批准最终 `EULA.md` 与 `PRIVACY.md`；CI 设置 `CODEGATE_LEGAL_APPROVED=1`。
5. 执行 `npm ci`、`npm run check`、`npm audit --omit=dev --audit-level=high`。
6. 执行 `npm run release:check`，结果必须为 `ready: true`。
7. 构建安装包并在干净 Windows 用户环境执行 `npm run smoke:packaged`。
8. 验证安装包 Authenticode 签名、SHA-256、安装/升级/卸载与回滚路径。
9. 用生产授权服务完成试用、购买、离线宽限、过期、吊销的端到端验收。
10. 分阶段发布并监控授权、更新与崩溃指标；保留紧急撤回权限。

## 当前不能由源码仓库自行完成的事项

- 公司/发行商法律身份及合同主体。
- 代码签名证书和私钥保管。
- 经律师批准的 EULA、隐私政策、退款与订阅条款。
- 生产授权后端、支付渠道、账号恢复与客服流程。
- 正式更新 CDN、域名、监控、告警和运营责任人。

这些条件未满足时只能发布测试版；客户端不得显示“已订阅”或宣称达到公开商业发布条件。

