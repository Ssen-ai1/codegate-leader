# CodeGate Leader 完整工作流

## 设计原则

CodeGate Leader 的核心不是“多一个聊天窗口”，而是把复杂 AI 开发变成有状态、有边界、有证据的工程流程。

四条原则贯穿全部状态：

1. **事实先于计划**：来源不明、用户未确认或环境未知的内容不能被当作架构事实。
2. **用户批准先于执行**：推荐、模型输出和自动分析都不等于决策。
3. **单步交接**：每次只把当前依赖已满足的 PlanStep 交给 Agent。
4. **证据先于验收**：Agent 声明、日志文本和真实验证结果具有不同信任等级。

## 主状态序列

```text
new
  └─ intake / clarification-required
       └─ task-spec-ready
            └─ architecture-review
                 └─ plan-ready
                      └─ step-ready
                           └─ handed-off
                                └─ result-reported
                                     └─ under-review
                                          ├─ step-ready（下一步）
                                          ├─ correction-ready
                                          ├─ user-decision-required
                                          ├─ blocked
                                          └─ task-completed
```

状态转换由领域工作流控制，不由界面按钮文字或模型自由决定。所有重要转换写入哈希链事件日志。

## 阶段一：Intake 与 Clarification

### 输入

- 产品想法；
- 已有项目目录；
- Markdown、TXT、PDF、DOCX 或图片资料；
- 竞赛官方指南；
- 用户对阻塞问题的明确回答。

### 输出

`TaskSpec` 至少包含：

- Objective；
- Requirements；
- Deliverables；
- Constraints / Non-goals；
- Acceptance Criteria；
- Rubric Items；
- Open Questions；
- Source Pointers。

阻塞问题没有回答时不能批准 TaskSpec。竞赛模式还必须确认具体赛题、板卡、实际环境进度和冲刺策略。

## 阶段二：Architecture Decision

系统从已批准 TaskSpec 和环境事实生成可比较方案。用户选择后形成不可覆盖的 ADR 版本，记录：

- 决策背景；
- 选择结果；
- 替代方案；
- 优势和代价；
- 影响的 PlanStep；
- 来源事实。

修改已确认架构需要显式展示影响。旧计划和旧 Prompt 不会被静默篡改。

## 阶段三：Dynamic WorkPlan

Planner 将需求和交付物映射为依赖图。每个步骤包含：

- `requirementIds`、`deliverableIds`、`acceptanceIds`、`rubricItemIds`；
- 目标、理由、输入、输出；
- 推荐 Skill 与方法；
- 验证说明；
- 风险、非目标、停止条件；
- 状态与依赖关系。

批准前会检查无效引用、循环依赖、必需验收覆盖和可执行起点。计划变化通过 `PlanPatch` 表达，保留触发原因和用户批准要求。

## 阶段四：Handoff / Agent Prompt

交接前捕获工作区基线：Git HEAD、工作树状态、文件哈希和当前步骤。随后将计划编译成中立协议：

```text
唯一目标
相关需求和交付物
已批准架构
已知环境事实
范围与非目标
推荐方法
预期输出
验证要求
停止条件
Execution Report Contract
```

Codex、Claude Code 和 Generic 适配器只改变少量执行说明，不改变任务事实。

## 阶段五：Execution Report

执行 Agent 返回的报告必须绑定 Handoff 版本，并声明：

- 修改文件；
- 输出工件；
- 运行命令与结果；
- 需求、验收和评分映射；
- 遇到的风险；
- 仍未完成的内容。

报告是待验证声明，不是验收结果。报告附件复制到受控目录并记录哈希。

## 阶段六：可信验证与独立 Review

证据强度从低到高：

1. Agent 文本声明；
2. Agent 提交的日志或报告；
3. CodeGate 观察到的真实文件变化；
4. 与 Handoff 基线绑定的 Git Diff；
5. CodeGate 自己运行并记录哈希、退出码和时间的验证命令；
6. 真实用户、硬件或外部系统确认。

确定性检查先判断范围、引用、输出和验证记录。配置独立 Reviewer 模型时，模型负责语义审查，但不能越过证据规则自行给出 Accepted。

## 阶段七：纠偏与决策

局部缺陷进入 `correction-ready`，Correction Handoff 只能修改 Review 指定范围。以下情况升级到用户决策：

- 修改目标或总体架构；
- 扩大任务范围；
- 发现 TaskSpec 与环境事实冲突；
- 多次出现同类偏航；
- 无法在当前权限或证据下继续。

## 竞赛调试快车道

编译、仿真、综合、实现、时序、约束、下载、硬件、资源和性能问题可以创建轻量调试会话。它生成专注当前错误的 Prompt，不改变正式 WorkPlan。若修复需要改变板卡、接口或总体路线，快车道必须停止并返回 Architecture/Plan 决策。

## 恢复与协议安全

工作区协议使用版本号。打开项目时会：

- 恢复未完成事务；
- 验证 State/Task/Plan/Handoff/Report 一致性；
- 检查事件哈希链；
- 备份可修复的损坏工件；
- 拒绝对未来协议执行降级写入。

这使 CodeGate 能在应用重启、模型切换和 Agent 交接后继续工作，而不依赖聊天上下文记忆。
