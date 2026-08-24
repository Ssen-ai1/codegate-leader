# CodeGate Leader

一个独立于 Coding Agent 的技术 Leader 工作台。它维护任务事实、架构决策、计划、交接、执行报告、审查、纠偏与教学工件；不承担业务代码生成或 Agent Runtime。

```text
TaskSpec → Architecture → Plan → Handoff → Report + Diff → Review → Correction / Next Step
```

## 开发

```powershell
npm install
npm run check
npm run dev -- init
npm run desktop
```

CLI 将状态保存在目标项目的 `.codegate/`。Desktop 只操作本地文件，不会自动启动 Coding Agent。
