# CodeGate Leader 技术交接

更新日期：2026-08-24  
工作区：D:\codegate-leader

## 产品边界

CodeGate Leader 是与 Coding Agent 解耦的技术 Leader 工作台。它维护任务事实、架构决策、计划、Skills、Handoff、执行报告、审查、纠偏和教学工件；不直接编写业务代码、不控制 Coding Agent、不建设语言 AST/LSP。

## 当前完成范围

- TaskSpec 导入、版本化修订、阻塞澄清与用户审批。
- 三步依赖 Plan、覆盖校验、PlanPatch 和稳定步骤 ID。
- Generic、Codex、Claude Code 的中立 Handoff。
- Execution Report 导入、Git Diff/状态与命令日志交叉审查、Correction Handoff。
- 环境事实的待确认/确认流程。
- 9 个内置 Skills 及其在 Handoff 中的具体方法与质量门槛。
- PDF、DOCX、图片 OCR、Markdown/文本资料导入；评分线索识别为 Rubric 候选项并保留 SourcePointer。
- OpenAI 兼容的 Leader 分析与 Mentor 追问接口。
- Desktop 状态面板、任务地图、Rubric Matrix、学习档案和交接/审查操作。
- Golden Set、Windows NSIS 安装包和 Git 初始历史。

## 架构与目录

~~~
src/
├── cli.ts                    CLI 入口
└── core/
    ├── schemas.ts            Zod 工件协议
    ├── store.ts              .codegate 原子写入、版本历史、事件日志
    ├── workflow.ts           生命周期、审查、纠偏、Mentor 服务
    ├── skills.ts             内置 Skill Registry
    ├── source-material.ts    PDF/DOCX/OCR/文本提取与 Rubric 线索
    └── leader-model.ts       OpenAI 兼容 Provider
desktop/
├── main.cjs                  Electron IPC
├── preload.cjs               受限渲染 API
└── renderer.html             Desktop UI
golden/                       Golden Set 和人工 A/B 评测说明
tests/                        协议、工作流、CLI、模型、资料提取测试
~~~

目标项目中的状态目录：

~~~
.codegate/
├── task/                     TaskSpec 历史与来源
├── architecture/decisions/   ArchitectureDecision
├── plan/                     WorkPlan 与 PlanPatch
├── skills/                   内置 Skill manifests
├── handoffs/                 不可覆盖的 Handoff JSON/Markdown
├── agent-reports/            ExecutionReport 与日志附件
├── environment/              待确认/已确认环境事实
├── reviews/                  ReviewReport
├── corrections/              CorrectionPatch
├── learning/                 学习档案与 Leader 分析
└── events.jsonl              追加事件日志
~~~

## 本地运行

要求：Node.js 22+。

~~~
cd D:\codegate-leader
npm install
npm run check
npm run desktop
~~~

常用 CLI：

~~~
codegate init
codegate intake task.md
codegate leader-analyze "补充背景"
codegate clarify <questionId> <answer>
codegate approve-task
codegate architecture "标题" "已确认决策"
codegate plan
codegate approve-plan
codegate next --agent codex
codegate ingest report.json
codegate confirm-environment
codegate review report.json
codegate correct --agent claude
codegate export-handoff
codegate learning-profile beginner deep --goals "理解审查"
codegate ask "为什么需要独立 Review？"
~~~

## 模型配置

Leader 分析与 Mentor 追问使用 OpenAI Chat Completions 兼容接口：

~~~
$env:CODEGATE_LEADER_API_KEY = "<key>"
$env:CODEGATE_LEADER_BASE_URL = "https://api.openai.com/v1"
$env:CODEGATE_LEADER_MODEL = "gpt-5"
~~~

未配置 Key 时，本地协议、CLI、Desktop、资料解析和审查仍可运行；模型操作会明确报错，不会生成伪造结论。

## 验证与发布

~~~
npm run check
npm run package:win
npm audit --omit=dev --audit-level=high
~~~

当前结果：7 个测试文件、17 项测试通过；生产依赖审计为 0 个高危漏洞。

已生成未签名本地安装包：

release\CodeGate Leader Setup 0.1.0.exe

release/ 已被 Git 忽略。

## Golden Set

golden/cases.json 覆盖清晰任务、澄清、Rubric、现有仓库、多步骤、范围扩大、报告/Diff 不一致、需求变化、Agent 切换和初学者教学。

评测方式：

1. A 组：用户直接使用执行 Agent。
2. B 组：用户通过 CodeGate Leader 管理同一任务。
3. 对比完成时间、需求遗漏、评分项遗漏、偏航次数、跨会话恢复成本与 Mentor 理解评分。

## 已知注意事项

- 图片 OCR 首次运行会下载语言数据；测试生成的根目录缓存不应提交。
- PDF/DOCX/OCR 仅在导入对应格式时动态加载，避免普通 Markdown CLI 启动变慢。
- Handoff、TaskSpec、Plan、Review 等历史版本禁止同版本重写。
- .codegate/ 必须排除在业务 Git Diff 外；审查会读取业务 Diff 与报告声明的差异。
- Windows 安装包使用默认 Electron 图标，后续可补充产品图标与签名证书。
- 模型服务使用 mock 测试覆盖结构和生命周期；生产调用需要部署环境提供凭据。

## Git 历史

~~~
4eebcff test: cover PDF and image source extraction
b5677b6 test: verify DOCX source extraction
d2d235f feat: establish CodeGate Leader MVP
~~~
