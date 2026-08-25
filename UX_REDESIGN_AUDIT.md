# CodeGate Leader 用户旅程重构验收

版本：0.2.0-alpha.7  
日期：2026-08-24

## 本轮目标

把产品从“直接暴露内部工件和状态机的工程控制台”重构为普通用户可以理解的产品旅程，并允许没有任务资料的用户从一句产品想法开始。

## 已实现的用户旅程

```text
新建产品 / 打开工程 / 最近项目
  → 描述想法或导入资料
  → 结构化需求访谈
  → 确认 TaskSpec
  → 推荐并确认技术架构
  → 生成和批准 WorkPlan
  → 生成 Agent Handoff
  → 导入报告、可信验证、独立 Review
  → 接受 / 最小纠偏 / 用户决策 / 完成交付
```

## 验收映射

| 要求 | 当前证据 |
| --- | --- |
| 没有任务资料也能开始 | `LeaderWorkflow.startFromIdea()` 从用户消息建立 TaskSpec；Desktop 空工作区提供“开始需求访谈”。 |
| 引导建立全面任务资料 | 固定覆盖目标用户、MVP、平台、数据/账号/支付/第三方、成功标准、限制；答案写入 Requirement、Deliverable、Constraint 或 AcceptanceCriterion。 |
| 先确定技术框架和 Plan | TaskSpec 批准后提供平台感知的架构推荐；架构确认后才生成映射完整的动态 WorkPlan。 |
| 新建工程是产品一级入口 | 首页提供新建、打开、最近项目；新建流程安全创建目录、README 与 `.codegate` 工作区。 |
| 用户随时知道下一步 | 六阶段导航配合状态专用焦点卡，每个阶段只突出一个主要 CTA。 |
| 专业能力仍然可用 | TaskSpec 编辑、补充资料、自定义架构、Handoff、报告、验证、Review、Correction 和 Mentor 收入“高级模式”。 |
| 已完成阶段可以回看修改 | 产品定义、技术架构和开发计划可点击；影响执行的修改必须显式重新打开并保留旧工件，计划只修改未执行步骤。 |
| Prompt 清晰可发现 | Handoff 明确标记为 Agent Prompt，生成后自动弹窗，支持一键复制并说明应交给哪个 Agent。 |
| 操作有反馈且可恢复 | 全局忙碌态、持续错误提示、创建/想法草稿自动保存、最近项目和 `.codegate` 状态恢复。 |
| 常见窗口可用 | 默认窗口调整为 1320×820，窄窗口将 Assistant 移至主内容下方；移动宽度转为单列。 |

## 自动化与运行证据

- `npm run check`：14 个测试文件、53 项测试通过。
- Workflow 测试覆盖一句想法、五类核心访谈答案、TaskSpec 事实写入和 Windows 架构推荐。
- Electron E2E 覆盖打开空工作区、咨询下一步、从想法开始访谈、新建目录、README 与 TaskSpec 落盘、错误持续可见。
- `npm audit --omit=dev --audit-level=high`：0 个已知生产依赖漏洞。
- `npm run package:win`：成功生成 `CodeGate Leader Setup 0.2.0-alpha.7.exe`。
- `npm run smoke:packaged`：打包态 Workflow、事件链与系统安全存储通过。

## 商业发行边界

本轮完成的是可用性和产品主路径，不伪造外部商业条件。品牌图标、客户端订阅验签和服务协议已经完成；严格发布门仍会阻止公开收费发行，直到法律实体、代码签名、法务批准文本、生产更新服务和生产订阅来源真实落实。
