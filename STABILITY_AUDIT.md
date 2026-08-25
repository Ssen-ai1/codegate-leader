# CodeGate Leader 产品稳定化审计

审计日期：2026-08-24  
审计版本：0.2.0-alpha.7  
结论：核心工作流和 Windows 打包态已达到可继续内部试用的稳定 Alpha；尚未达到可收费公开发行标准。

## 已关闭的阻断问题

- 新用户必须先准备任务资料且无法从零开始：现在可以从一句想法创建项目，系统通过结构化访谈补齐 TaskSpec，并按阶段只显示一个主要下一步。
- 功能按内部工件平铺导致不可发现：主界面已重构为六阶段用户旅程，原有 TaskSpec、Plan、Handoff、Review、Mentor 与可信验证保留在渐进式高级模式。
- 已完成阶段无法打开或修改：前三阶段现在可回看；产品定义和架构修订会显式废弃受影响计划，未执行 PlanStep 可通过 PlanPatch 修改，历史版本不被覆盖。
- Handoff/Prompt 含义不明确：界面统一称为 Agent Prompt，生成后自动弹出并提供系统剪贴板复制；HTTP 402 等模型错误转换为可操作的中文提示。
- Windows Desktop “打开项目无反应”：根因是用裸 Windows 盘符动态导入 ESM。现使用 `pathToFileURL()`，Renderer 会显示异常且阻止重复操作。
- 工作区损坏或半提交：打开时先恢复事务，再检查 State/Task/Plan/Handoff/Report/事件链；修复前复制到 `.codegate/backups/`。
- 多工件部分提交：Task、Plan、Report、Review、Correction、Decision、Baseline、Handoff 与 State 的关键变更使用暂存清单和可重放事务。
- 崩溃残留锁：事件锁记录 PID，可接管死进程锁；损坏事件链会隔离，原件保留在备份。
- Agent 伪造验证：Agent 日志不再触发 Accepted。CodeGate 只执行用户确认、与环境白名单完全相等且不含 Shell 元字符的命令，并保存输出哈希。
- 命令前缀绕过：`npm test && ...`、管道、重定向、命令替换和附加参数均不能借 `startsWith` 绕过。
- 语义审查证据缺口：未跟踪文本文件加入有界 Diff；敏感键、Token、Bearer、密码和私钥采用结构化脱敏。
- Desktop 产品运行层：单实例、系统安全存储、模型与超时设置、主进程错误日志、诊断导出、更新清单校验、未来协议降级保护均已加入。
- 商业客户端边界：订阅状态使用 Ed25519 签名、安装实例绑定和限时离线缓存；Token 使用系统安全存储，未配置时不伪装付费权益。
- 更新体验：只接受 HTTPS 清单与下载地址，要求 SHA-256；显示说明后由用户明确打开下载页面，不静默安装。
- 发布门禁：除版本、发行商、签名与法务文本外，现在还验证 HTTPS 更新源、HTTPS 授权源、内置公钥与显式法律审批。

## 验收证据

- `npm run check`：14 个测试文件、53 项测试全部通过。
- 故障注入：覆盖 Plan 指针损坏、State/Step 不一致、Handoff 缺失、事件日志损坏、死锁和事务中断恢复。
- Electron E2E：真实点击打开项目、从一句想法启动访谈、新建项目目录、生成 README/TaskSpec、咨询、错误反馈与刷新均通过。
- `npm run package:win`：NSIS 安装包构建成功。
- `npm run smoke:packaged`：真实 `release/win-unpacked/CodeGate Leader.exe` 中 ASAR 工作流自检、事件链和安全存储通过。
- `npm audit --omit=dev`：生产依赖已知漏洞 0。
- 当前安装包：`release/CodeGate Leader Setup 0.2.0-alpha.7.exe`，133,191,117 字节，SHA-256 `F03A402D6FB801F112C256299FD8A46A95F644D205D9EE3DA6F1B5708AF8D2E9`（每次重新打包都会变化）。

## 当前项目恢复记录

`D:\codegate-leader` 原工作区确有 `State=handed-off / step-001=ready` 冲突。已于本次审计中自动修复为一致的 `handed-off`，修复前快照位于：

`D:\codegate-leader\.codegate\backups\2026-08-24T08-22-01-557Z-automatic-repair`

## 仍阻止公开收费发行的问题

运行 `npm run release:check` 会明确失败，直到以下外部条件落实：

- 将 Alpha 版本升级为正式版本，并提供真实发行商法律实体。
- 提供 Windows Authenticode 证书并启用签名；原创品牌图标已经接入窗口、EXE 与安装包。
- 由法律顾问批准 EULA 与隐私政策。
- 部署生产 HTTPS 更新清单/发布服务；客户端协议与显式下载体验已完成，不自动安装。
- 部署生产订阅服务并配置客户端内置 Ed25519 公钥；客户端验签、离线宽限与账号状态体验已完成。
- 完成 direct-vs-CodeGate 的真实成对任务评估，证明节省返工或提高验收率后再制定价格。

模型调用已有 Token/成本仪表盘和用户可配置单价；启发式 Intake/Planner 的商业质量仍需由真实任务数据校准。这不是“打开项目”的稳定性阻断，但会影响定价证据、支持成本和产品承诺。
