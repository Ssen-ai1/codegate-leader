# CodeGate Leader Golden Set

每个场景均应运行两次：

- A：用户直接使用执行 Agent。
- B：用户通过 CodeGate Leader 管理相同任务。

记录完成时间、遗漏的需求/评分项、偏航次数、跨会话恢复时间，以及学习者对 Mentor Brief 的理解评分。只有 B 在至少一项指标上有明显优势，才继续扩大产品。

自动化测试会把每个案例的 `taskText` 实际送入 Intake 与动态 Planner，并另外执行报告/Diff、范围扩大、需求变化、Agent 切换和教学场景。人工或外部 Agent 对照仍用于测量真实模型行为和用户认知成本，不能由合成数据替代。

对照结果使用以下字段组成 JSON 数组：`caseId`、`mode` (`direct`/`codegate`)、`completed`、`completionMinutes`、`managementMinutes`、`missedRequirements`、`missedRubricItems`、`driftCount`、`recoveryMinutes`，可选 `mentorScore` 和 `notes`。

运行：

```text
codegate evaluate golden-results.json
```

评估器会检查每个案例是否同时具有 direct 和 codegate 运行，计算遗漏、偏航、恢复时间、管理时间和操作开销，并按产品规格中的阈值输出 `go`。没有真实运行数据时不得宣称产品价值已经得到证明。
