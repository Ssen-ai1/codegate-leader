export const protocolVersion = 2 as const;

// These files are intentionally simple JSON Schemas so external agents can
// validate reports without importing the CodeGate runtime.
export const executionReportJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "codegate://protocols/execution-report-v2",
  title: "CodeGate Execution Report v2",
  type: "object",
  additionalProperties: false,
  required: ["reportId", "stepId", "handoffVersion", "agent", "status", "summary", "filesRead", "filesChanged", "commandsRun", "outputs", "assumptions", "risks", "unresolvedItems", "deviations", "recommendedNextAction", "generatedAt"],
  properties: {
    reportId: { type: "string", minLength: 1 }, stepId: { type: "string", minLength: 1 }, handoffVersion: { type: "integer", minimum: 1 },
    agent: { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1 }, model: { type: "string" }, sessionId: { type: "string" } } },
    status: { enum: ["completed", "partial", "blocked", "failed"] }, summary: { type: "string", minLength: 1 },
    workspaceRevisionBefore: { type: "string" }, workspaceRevisionAfter: { type: "string" },
    filesRead: { type: "array", items: { type: "string" } }, filesChanged: { type: "array", items: { type: "string" } },
    commandsRun: { type: "array", items: { type: "object", additionalProperties: false, required: ["command", "exitCode", "status"], properties: { command: { type: "string", minLength: 1 }, exitCode: { type: ["integer", "null"] }, status: { enum: ["passed", "failed", "timed-out", "not-run"] }, outputArtifact: { type: "string" }, outputHash: { type: "string" }, coversAcceptanceIds: { type: "array", items: { type: "string" } } } } },
    outputs: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "description"], properties: { type: { type: "string", minLength: 1 }, path: { type: "string" }, description: { type: "string", minLength: 1 }, contentHash: { type: "string" }, coversRequirementIds: { type: "array", items: { type: "string" } }, coversAcceptanceIds: { type: "array", items: { type: "string" } }, coversRubricItemIds: { type: "array", items: { type: "string" } } } } },
    decisionsMade: { type: "array", items: { type: "object", additionalProperties: false, required: ["description", "reason", "requiresLeaderReview"], properties: { description: { type: "string" }, reason: { type: "string" }, requiresLeaderReview: { type: "boolean" } } } },
    assumptions: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, unresolvedItems: { type: "array", items: { type: "string" } },
    deviations: { type: "array", items: { type: "object", additionalProperties: false, required: ["description", "reason"], properties: { description: { type: "string" }, reason: { type: "string" } } } },
    recommendedNextAction: { type: "string", minLength: 1 }, environmentFacts: { type: "object" }, generatedAt: { type: "string", format: "date-time" }
  }
};

export const protocolIndex = {
  protocolVersion,
  schemas: {
    executionReport: "execution-report.schema.json",
    ownership: "ownership.json"
  }
};

export const ownershipProtocol = {
  codegateWrite: ["task", "architecture", "plan", "skills", "handoffs", "reviews", "corrections", "learning", "environment", "decisions", "protocols"],
  agentWrite: ["agent-reports"],
  agentReadOnly: ["task", "architecture", "plan", "skills", "handoffs", "reviews", "corrections", "protocols"],
  protectedPatterns: [".codegate/task/**", ".codegate/architecture/**", ".codegate/plan/**", ".codegate/reviews/**"]
};
