# CodeGate Leader 0.2 Alpha 技术交接

更新日期：2026-08-24  
版本：0.2.0-alpha.7
Workspace Protocol：v2

## 阶段结论

0.2 Alpha 已将 0.1 的固定流程骨架升级为任务驱动、证据驱动的可信闭环。CodeGate 仍不编写业务代码或控制 Coding Agent；它负责事实、计划、交接、工作区基线、证据审查、用户决策、纠偏和教学。

## 已完成能力

- 新首页区分“新建产品”“打开已有工程”和“最近项目”；新建项目会安全创建目录、README 和 CodeGate 工作区。
- 无任务资料也可从一句产品想法开始；引导访谈补齐目标用户、MVP、平台、数据/账号/支付边界、成功标准与限制，并将答案写入可追踪 TaskSpec 事实。
- Desktop 改为产品定义、技术架构、开发计划、Agent 执行、验证审查、完成交付六阶段旅程，每个状态只突出一个下一步；底层工件和专业操作保留在高级模式。
- 提供基于已确认需求和平台的初始架构推荐、表单草稿自动保存、最近项目恢复，以及持续的长操作和错误反馈。
- 已完成阶段可点击回看：产品定义可显式重新打开并版本化修订，架构可使旧计划失效后重新决策，开发计划仅允许修改未执行步骤。
- Handoff 在产品界面中明确呈现为 Agent Prompt；生成后自动打开，可一键复制给 Codex、Claude Code 或其他编程 Agent。
- 产品定义显示七类实时蓝图和明确缺口；架构阶段提供三个方案的速度、成本、风险与取舍比较；计划阶段使用步骤地图；执行中心显示 Prompt、Agent 与证据报告三段状态。
- Leader 对话以项目为边界持久化并恢复，普通模式不再输出原始 JSON；未配置模型时提供可离线的状态感知解释，配置状态在界面明确显示。
- 修改产品定义或架构前展示依赖影响；最近项目显示项目名、阶段、最后活动日期和目录可用性。
- 首次使用提供可关闭的三步说明；新建项目提供空白、桌面商业 App、订阅 SaaS、内部效率工具四种起步模板。
- 执行中心检测本机 Codex/Claude Code；已安装时可由用户显式复制 Prompt 并在当前项目目录打开交互式 Agent，未安装时提供可操作说明。
- 模型调用记录 Token、操作类型与用户配置价格后的估算成本；项目侧边栏展示只在本地聚合的讨论、审查和验收进度。
- 新增原创 `assets/app-icon.png` 与多尺寸 `assets/app-icon.ico`，Desktop 窗口与 Windows 打包统一使用产品图标。
- 新增“账号与订阅”入口；授权状态使用 Ed25519 签名、安装实例绑定和限时离线缓存，本地开关不能激活权益。
- 正式构建可内置授权公钥、授权服务和更新源；发布门强制检查 HTTPS、公钥、法务批准和签名条件。
- 更新检查显示版本、说明与 SHA-256，由用户明确选择后才在系统浏览器打开 HTTPS 下载地址。
- 新增授权/更新服务合同、隐私数据地图和商业发布 Runbook，为后端、法务和运营提供真实实现边界。
- 从文本、Markdown、CSV、JSON、PDF、DOCX 和图片中提取多个需求、交付物、约束、假设、问题、验收项与 Rubric。
- SourcePointer 保留文件行位置；PDF 保留页码与页内行号；Desktop 修订记录为 user-message 来源。
- 支持在 TaskSpec 批准前添加多份资料、回答阻塞问题和保存可追踪修订。
- 根据交付物、需求、验收、Rubric、环境和架构决策生成 3～8 步动态 Plan。
- Plan 批准前检查循环依赖、无效引用、必需映射和 Skill；PlanPatch 支持增量目标、依赖、验收、风险、步骤与状态变更。
- Handoff 编入相关需求、已接受 ADR、Skill 选择理由、环境事实、风险、上次 Review、工作区基线和 v2 Report Contract。
- 每个 Handoff 保存 Git/文件基线；Review 只观察交接后产生的修改，并保留交接前脏文件。
- Execution Report 的命令和输出可显式映射 Requirement、Acceptance 与 Rubric；日志限定在附件目录并校验非空与哈希。
- 实现逐项 requirementCoverage、acceptanceCoverage、rubricCoverage，以及架构、实现、验证和漂移 Findings。
- 已确认环境命令作为实现步骤的验证命令白名单；任意 `echo passed` 不能构成验收证据。
- 配置模型时启用独立语义 Reviewer；模型只生成风险 Findings，不能直接给出 Accepted。
- 范围扩大、架构变化、证据冲突和重复偏航生成 UserDecisionRequest，可选择最小纠偏、接受风险、重规划或阻塞。
- Workspace Protocol v1 状态自动迁移并备份；事件日志使用串行写入和 SHA-256 哈希链。
- Desktop 根据状态启用合法操作，支持 TaskSpec 编辑、补充资料、澄清、任务地图、Rubric、PlanPatch 历史、Review、决策和 Mentor。
- Golden Set 的九类任务实际运行 Intake 和动态 Planner；对照评估器计算遗漏、偏航、恢复时间、管理时间和操作开销。

## 核心新增模块

```text
src/core/
├── protocols.ts             v2 外部协议文件
├── state-machine.ts         合法状态转换与可用操作
├── task-intake.ts           确定性、可追踪的语义提取
├── planner.ts               3～8 步动态计划与 Skill 理由
├── workspace-observer.ts    Git/非 Git 基线与本轮 Diff
└── evaluation.ts            Golden A/B 指标与 Go/No-Go
```

原有 `schemas.ts`、`store.ts`、`workflow.ts`、`leader-model.ts`、CLI 和 Desktop 已升级到 v2 协议。

## 验证命令

```powershell
npm install
npm run check
npm audit --omit=dev --audit-level=high
npm run package:win
```

## 产品验证边界

自动化测试证明协议和预设漂移场景按设计工作，但不能证明真实用户的认知负担已经下降。真实 Go/No-Go 仍需要为每个 Golden Case 收集 direct 和 codegate 两组运行数据，然后执行：

```text
codegate evaluate golden-results.json
```

没有真实对照数据时，不应宣称产品价值已经验证，也不应优先扩大到云端调度、Agent 自动控制、Skill 市场、多人协作或知识图谱。

## 已知限制

- 确定性 Intake 使用结构与关键词启发式；复杂隐含语义仍建议运行 Leader 模型并由用户批准。
- DOCX 和 OCR 目前保留提取后行位置，无法稳定恢复原始页面坐标；OCR 结果必须人工核对。
- 语义 Review 依赖可选外部模型；未配置时只使用工作区、映射、哈希和已确认命令进行保守验收。
- Desktop 提供结构化 TaskSpec 编辑和未开始步骤目标/风险的 PlanPatch 编辑；添加步骤和调整依赖等高级补丁仍使用 CLI 文件协议。
- 安装包仍未签名；原创产品图标已接入，但正式发行需要真实发行商与 Authenticode 证书。
