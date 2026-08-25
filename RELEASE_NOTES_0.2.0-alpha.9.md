# CodeGate Leader 0.2.0-alpha.9 — 首个公开 Alpha

CodeGate Leader 是一个位于用户与 Coding Agent 之间的本地技术负责人工作台。它帮助你先澄清产品或赛题、比较架构、制定动态计划，再把当前一步交给 Codex、Claude Code 或其他 Agent，并依据真实工作区变化与验证证据独立审查结果。

## 这一版值得体验什么

- 从一句产品想法开始，逐步建立产品蓝图、TaskSpec、架构和开发计划。
- 导入 FPGA/嵌入式竞赛 PDF，选择具体赛题并提取基础分、高阶项、板卡和性能指标。
- 一次只生成当前步骤的 Agent Prompt，避免长任务范围失控。
- Agent 的“完成”声明不会直接通过；CodeGate 对照基线、Diff、输出和自运行验证进行 Review。
- 支持调试快车道、跑分记录、技术导师和比赛答辩演练。
- 所有核心工件本地保存，可恢复、可版本化、可追踪。

## 重要安全修复

旧版本在无法识别 `【赛题一】` 标题时，可能错误地把整本指南当作一道题。alpha.9 已移除该回退：用户没有明确选择题号和完整题名时，架构、计划、模型继续推测和 Agent Prompt 都会被阻止。

## 安装

附件提供 Windows x64 测试安装包：

`CodeGate Leader Setup 0.2.0-alpha.9.exe`

SHA-256：

`367A82D98C1051C6FF336E0CE792AE6F12860941A6C0352375E806B8114A293E`

也可以从源码运行：

```powershell
git clone https://github.com/Ssen-ai1/codegate-leader.git
cd codegate-leader
npm ci
npm run check
npm run desktop
```

## Alpha 风险提示

- 安装包尚未使用正式发行商代码签名，Windows 可能显示“未知发布者”。
- 当前版本适合体验、研究和参与开发，不是已完成法律、签名和生产服务准备的商业正式版。
- 请不要把真实 API Key、私有源码或竞赛保密资料提交到公开 Issue。

本地验证：15 个测试文件、62 项测试全部通过；`npm audit` 为 0；Windows 打包冒烟测试通过。
