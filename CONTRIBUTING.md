# 为 CodeGate Leader 贡献

感谢你愿意一起完善 CodeGate Leader。项目欢迎代码、文档、产品体验、赛题解析器、Agent 适配器、验证器和可复现评估场景。

## 开始之前

1. 阅读 [README](README.md)、[完整工作流](docs/WORKFLOW.md) 和 [技术架构](docs/ARCHITECTURE.md)。
2. 搜索现有 Issue，确认问题没有被重复报告。
3. 大型功能、协议变更或状态机变化请先创建 Feature Request，说明用户问题和安全边界。
4. 安全漏洞不要公开提交 Issue，请按 [SECURITY.md](SECURITY.md) 报告。

## 本地开发

```powershell
git clone https://github.com/ghhdhy/codegate-leader.git
cd codegate-leader
npm ci
npm run check
npm run desktop
```

要求 Node.js 22+。Windows 是当前完整验证平台。

## 分支和提交

- 从最新 `main` 创建短生命周期分支。
- 推荐分支名：`feat/...`、`fix/...`、`docs/...`、`test/...`。
- 每个提交解决一个清晰问题。
- 提交信息建议使用 Conventional Commits，例如 `fix: block planning before challenge selection`。
- 不要提交 `.codegate/`、`release/`、`dist/`、`node_modules/`、真实 Key、Token、私有任务资料或个人日志。

## Pull Request 要求

PR 描述应包含用户问题、解决方案、可信边界、测试结果，以及 UI/协议变化证据。提交前运行：

```powershell
npm run check
```

修改桌面启动、打包、安全存储或发布逻辑时，还应运行：

```powershell
npm run package:win
npm run smoke:packaged
```

## 代码设计约束

- 领域状态变化必须通过 `LeaderWorkflow`，不要让 Renderer 直接改状态文件。
- 外部 JSON、模型返回和旧工件必须先通过 Schema 验证。
- 模型建议不能绕过用户批准或确定性证据规则。
- 文件操作必须限制在用户选择的项目根目录和受控 `.codegate` 路径。
- 新工件需要考虑版本、来源、迁移、恢复和哈希校验。
- 修复局部问题时不要顺带扩大功能范围。
- 新功能至少增加正常路径和拒绝路径测试。

## 新增竞赛解析支持

请提供经过脱敏且允许公开的最小文本 Fixture，不要直接提交受版权或隐私限制的完整赛题 PDF。测试至少覆盖多题标题去重、用户选择一致性、要求和指标边界、解析失败停止及关键词冲突。

## 贡献许可

除非你明确另行声明，提交到本仓库并被接受的贡献将按 Apache License 2.0 授权，参见 [LICENSE](LICENSE)。请只提交你有权贡献的内容。
