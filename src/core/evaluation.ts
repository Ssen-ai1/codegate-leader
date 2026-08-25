import { z } from "zod";

export const evaluationRunSchema = z.object({
  caseId: z.string().min(1), mode: z.enum(["direct", "codegate"]), completed: z.boolean(), completionMinutes: z.number().nonnegative(), managementMinutes: z.number().nonnegative(),
  missedRequirements: z.number().int().nonnegative(), missedRubricItems: z.number().int().nonnegative(), driftCount: z.number().int().nonnegative(), recoveryMinutes: z.number().nonnegative(), mentorScore: z.number().min(1).max(5).optional(), notes: z.string().optional()
}).strict();
export const evaluationInputSchema = z.array(evaluationRunSchema).min(2);

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const improvement = (direct: number, codegate: number) => direct === 0 ? (codegate === 0 ? 0 : -1) : (direct - codegate) / direct;

export function evaluateComparativeRuns(input: unknown) {
  const runs = evaluationInputSchema.parse(input);
  const caseIds = [...new Set(runs.map((run) => run.caseId))];
  const pairs = caseIds.map((caseId) => ({ caseId, direct: runs.find((run) => run.caseId === caseId && run.mode === "direct"), codegate: runs.find((run) => run.caseId === caseId && run.mode === "codegate") }));
  const incomplete = pairs.filter((pair) => !pair.direct || !pair.codegate).map((pair) => pair.caseId);
  if (incomplete.length) throw new Error("以下 Golden Case 缺少 direct/codegate 对照：" + incomplete.join(", "));
  const direct = pairs.map((pair) => pair.direct!); const codegate = pairs.map((pair) => pair.codegate!);
  const directOmissions = sum(direct.map((run) => run.missedRequirements + run.missedRubricItems));
  const codegateOmissions = sum(codegate.map((run) => run.missedRequirements + run.missedRubricItems));
  const metrics = {
    completionRateDelta: sum(codegate.map((run) => Number(run.completed))) / pairs.length - sum(direct.map((run) => Number(run.completed))) / pairs.length,
    omissionReduction: improvement(directOmissions, codegateOmissions),
    driftReduction: improvement(sum(direct.map((run) => run.driftCount)), sum(codegate.map((run) => run.driftCount))),
    recoveryTimeReduction: improvement(sum(direct.map((run) => run.recoveryMinutes)), sum(codegate.map((run) => run.recoveryMinutes))),
    managementTimeReduction: improvement(sum(direct.map((run) => run.managementMinutes)), sum(codegate.map((run) => run.managementMinutes))),
    codegateOverheadRatio: sum(codegate.map((run) => run.managementMinutes)) / Math.max(1, sum(codegate.map((run) => run.completionMinutes)))
  };
  const advantages = [metrics.omissionReduction >= .5, metrics.driftReduction >= .3, metrics.recoveryTimeReduction >= .5, metrics.managementTimeReduction >= .25, metrics.completionRateDelta > 0];
  return { cases: pairs.length, metrics, go: advantages.some(Boolean) && metrics.codegateOverheadRatio <= .15, thresholds: { omissionReduction: .5, driftReduction: .3, recoveryTimeReduction: .5, managementTimeReduction: .25, maximumOverheadRatio: .15 } };
}
