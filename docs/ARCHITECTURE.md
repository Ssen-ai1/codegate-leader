# CodeGate Leader 技术架构

## 总览

CodeGate Leader 是一个本地优先的 Electron + TypeScript 桌面应用。界面、桌面系统能力和领域工作流分层，核心逻辑可以独立于 Electron 运行和测试。

```text
┌──────────────────────────────────────────────────────────┐
│ Electron Renderer                                        │
│ 阶段界面 / 工件查看 / Leader 对话 / 设置 / 诊断          │
└───────────────────────┬──────────────────────────────────┘
                        │ contextBridge IPC
┌───────────────────────▼──────────────────────────────────┐
│ Electron Main / Preload                                  │
│ 文件选择 / 安全存储 / Agent 检测 / 更新与许可证边界      │
└───────────────────────┬──────────────────────────────────┘
                        │ application calls
┌───────────────────────▼──────────────────────────────────┐
│ Core Domain                                               │
│ Workflow / Schemas / Planner / Protocols / Review         │
│ Competition / Source Intake / Verification / Health       │
└───────────────────────┬──────────────────────────────────┘
                        │ transactional artifacts
┌───────────────────────▼──────────────────────────────────┐
│ Local Workspace Store                                     │
│ .codegate JSON/JSONL / immutable versions / hash chain     │
└──────────────────────────────────────────────────────────┘
```

## 关键目录

```text
src/
├─ cli.ts                         # CLI 命令入口
└─ core/
   ├─ workflow.ts                 # 领域工作流与状态门禁
   ├─ schemas.ts                  # Zod 协议模型
   ├─ store.ts                    # 事务式本地工件存储
   ├─ planner.ts                  # 动态计划生成
   ├─ protocols.ts                # Handoff/Report 协议辅助
   ├─ task-intake.ts              # 产品任务资料解析
   ├─ competition.ts              # 竞赛赛题、得分与调试
   ├─ source-material.ts          # PDF/DOCX/图片/文本提取
   ├─ verification-runner.ts      # 可信命令执行
   ├─ workspace-observer.ts       # Git/文件基线与变化
   ├─ workspace-health.ts         # 恢复与一致性检查
   ├─ leader-model.ts             # 可替换模型客户端与脱敏
   ├─ evaluation.ts               # Golden/对照评估
   └─ state-machine.ts            # 状态转换规则

desktop/
├─ main.cjs                       # Electron 主进程与 IPC
├─ preload.cjs                    # 最小权限桥接
├─ renderer.html                  # 当前桌面交互层
├─ settings.cjs                   # 安全模型配置
├─ license.cjs                    # 签名许可证验证边界
└─ release-config.cjs             # 更新源配置边界
```

## 为什么领域核心不依赖 UI

`LeaderWorkflow` 负责所有状态变化和门禁。Renderer 只能请求操作，不能自行把状态从 `intake` 改成 `plan-ready`。这带来三个好处：

- CLI 与 Desktop 共享同一套规则；
- 工作流可以使用 Vitest 直接做端到端测试；
- UI 改版不会改变可信协议。

## 存储与事务

Store 以 `.codegate/` 为项目级数据库。关键工件同时保存当前版本和不可覆盖历史版本。多文件状态变化通过事务提交，应用异常退出后可以恢复。`events.jsonl` 使用前向哈希链，检测删除、重排或篡改。

## 协议模型

Zod Schema 是运行时边界，不只用于 TypeScript 类型提示。外部报告、旧工作区和模型返回在进入领域逻辑前都必须解析。Workspace Protocol v2 支持迁移和未来版本拒绝降级写入。

## 模型隔离

Leader 模型用于解释、分析和语义建议；Reviewer 模型用于独立语义审查；Coding Agent 负责执行。三者没有共享“默认可信”关系。

模型调用前会：

- 只选择必要字段；
- 删除 Key、Token、Authorization、私钥等敏感内容；
- 将仓库文本、Diff 和 Report 作为不可信数据包裹；
- 记录 Token 使用，不记录秘密配置。

模型不可绕过 `assertTaskReady`、计划完整性和证据规则。

## Electron 安全边界

- Renderer 不直接获得 Node.js 文件系统权限；
- Preload 只暴露白名单 IPC；
- 文件导入经过项目根目录边界检查；
- 外部链接只允许 HTTPS；
- API Key 和 License Token 使用 `safeStorage`；
- 诊断导出和日志进行秘密脱敏；
- Agent 启动使用明确工作目录和用户操作。

## 扩展方向

最适合贡献的扩展点包括：

- 新 Source Material 提取器；
- 新竞赛题型和评分解析器；
- 新 Coding Agent 适配器；
- 新验证器和证据类型；
- 领域核心之外的新 UI；
- 多语言文档和首次使用模板；
- 可复现的 Direct-vs-CodeGate 评估场景。
