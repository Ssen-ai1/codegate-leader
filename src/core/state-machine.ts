import type { LeaderState } from "./schemas.js";

export type LeaderStatus = LeaderState["status"];

const allowed: Record<LeaderStatus, ReadonlySet<LeaderStatus>> = {
  new: new Set(["intake", "clarification-required"]),
  intake: new Set(["intake", "clarification-required", "task-spec-ready"]),
  "clarification-required": new Set(["intake", "clarification-required", "task-spec-ready"]),
  "task-spec-ready": new Set(["architecture-review", "intake"]),
  "architecture-review": new Set(["architecture-review", "plan-ready", "intake"]),
  "plan-ready": new Set(["step-ready", "architecture-review", "intake"]),
  "step-ready": new Set(["handed-off", "blocked", "intake"]),
  "handed-off": new Set(["result-reported", "blocked"]),
  "result-reported": new Set(["under-review", "blocked"]),
  "under-review": new Set(["step-ready", "correction-ready", "user-decision-required", "blocked", "task-completed", "under-review"]),
  "correction-ready": new Set(["handed-off", "user-decision-required", "blocked"]),
  "user-decision-required": new Set(["step-ready", "correction-ready", "architecture-review", "blocked", "task-completed"]),
  blocked: new Set(["intake", "architecture-review", "step-ready", "correction-ready", "blocked"]),
  "task-completed": new Set(["intake"])
};

export function assertStateTransition(from: LeaderStatus, to: LeaderStatus) {
  if (from === to) return;
  // A confirmed scope change can deliberately reopen TaskSpec from any active
  // or completed state; the previous artifacts remain immutable history.
  if (to === "intake" && from !== "new") return;
  // A confirmed architecture revision can invalidate an active plan while
  // preserving immutable TaskSpec, Plan and Handoff history.
  if (to === "architecture-review" && !["new", "intake", "clarification-required"].includes(from)) return;
  if (!allowed[from].has(to)) throw new Error(`非法工作流状态转换：${from} -> ${to}。`);
}

export function availableActions(status: LeaderStatus): string[] {
  const byStatus: Record<LeaderStatus, string[]> = {
    new: ["start-idea", "intake"], intake: ["clarify", "leader-analyze", "approve-task"], "clarification-required": ["clarify", "leader-analyze", "approve-task"],
    "task-spec-ready": ["architecture"], "architecture-review": ["architecture", "plan"], "plan-ready": ["approve-plan"],
    "step-ready": ["next"], "handed-off": ["ingest"], "result-reported": ["review"], "under-review": ["review"],
    "correction-ready": ["correct"], "user-decision-required": ["resolve-decision"], blocked: ["resolve-block"], "task-completed": ["explain"]
  };
  return byStatus[status];
}
