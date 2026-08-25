# CodeGate Leader 快速上手

本指南带你从源码启动桌面端，并完整走通一次“定义任务 → 选择架构 → 生成计划 → 交给 Agent → 验证结果”的流程。

## 1. 准备环境

- Windows 10/11
- Node.js 22+
- npm
- 一个可读写的测试项目目录

验证环境：

```powershell
node --version
npm --version
```

## 2. 下载并启动

```powershell
git clone https://github.com/ghhdhy/codegate-leader.git
cd codegate-leader
npm ci
npm run check
npm run desktop
```

第一次构建会花费一些时间。`npm run check` 成功后再启动桌面端，可以排除依赖或本地环境问题。

## 3. 跑通产品开发模式

1. 在首页点击“新建项目”。
2. 选择一个空目录作为被管理的工程。
3. 选择产品开发模式。
4. 输入一句具体想法，例如：“做一个帮助学生整理 FPGA 实验记录的 Windows 桌面应用。”
5. 逐项回答目标用户、MVP、平台、数据、成功标准和限制。
6. 在产品定义页检查七类蓝图是否完整。
7. 比较三个架构方案，阅读速度、成本、风险与代价，然后明确选择。
8. 生成开发计划，检查依赖、验收映射和风险。
9. 批准计划后生成当前步骤的 Agent Prompt。

此时目标项目会新增 `.codegate/`，其中保存所有 Leader 工件。它不会被 CodeGate Leader 仓库自身提交，因为 `.gitignore` 已排除该目录。

## 4. 跑通竞赛模式

1. 新建项目并选择“FPGA / 嵌入式竞赛”。
2. 导入官方 PDF、DOCX、Markdown、文本或图片。
3. 如果指南包含多道题，必须点击选择具体赛题。
4. 检查解析出的基础要求、高阶挑战、板卡、工具链、指标和提交物。
5. 如实填写目标板卡、工具链已跑通进度和保分/冲刺策略。
6. 比较实现路线，确认后生成六阶段冲刺计划。

如果 CodeGate 没有识别出具体题号或题名，它会停止，而不是猜测。请检查资料标题格式或改用文字更清晰的官方文件。

## 5. 把 Prompt 交给 Coding Agent

计划批准后：

1. 选择 Codex、Claude Code 或 Generic Agent。
2. 点击生成 Agent Prompt。
3. 阅读唯一目标、范围、非目标、验证要求与停止条件。
4. 复制 Prompt，或让桌面端在当前项目目录打开已安装的 Agent。
5. Agent 完成后，让它按照 Prompt 末尾的 Execution Report Contract 写报告。
6. 回到 CodeGate 导入报告。

CodeGate 会重新读取工作区变化。交接前已有修改不会自动算作本轮成果。

## 6. 验证与 Review

如果项目已经确认了测试命令，可由 CodeGate 运行可信验证。随后执行 Review：

- `Accepted`：需求、范围和证据满足当前步骤；
- `Correction Ready`：生成最小纠偏 Prompt；
- `User Decision Required`：架构、范围或事实发生重大变化，需要用户决定；
- `Blocked`：缺少环境事实或证据，不能可靠继续。

## 7. 可选模型

未配置模型时，本地工作流仍可运行。需要语义分析和独立模型 Review 时，可在桌面端设置供应商地址、模型和 API Key。Key 使用操作系统安全存储，不写入 `.codegate/`。

遇到问题请先查看 [FAQ](FAQ.md)，仍无法解决时使用 GitHub Bug Report 模板，并附上去除敏感信息后的诊断导出。
