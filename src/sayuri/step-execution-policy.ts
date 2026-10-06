import type { SayuriActionRisk } from "./action-broker";
import type { SayuriPlanStep } from "./planner";

export interface SayuriStepAttemptPolicy {
  maxErrors: number;
  requireExactToolBinding: boolean;
}

const MAX_ERRORS_BY_RISK: Readonly<Record<SayuriActionRisk, number>> = {
  read: 3,
  "low-risk-write": 2,
  "project-mutation": 2,
  "external-action": 1,
  "system-mutation": 1,
  destructive: 1,
  "secret-access": 1,
};

export function sayuriStepAttemptPolicy(
  step: Pick<SayuriPlanStep, "risk">,
): SayuriStepAttemptPolicy {
  return {
    maxErrors: MAX_ERRORS_BY_RISK[step.risk],
    requireExactToolBinding: true,
  };
}

export function sayuriStepCanBindTool(
  step: Pick<SayuriPlanStep, "status" | "toolName">,
  toolName: string,
): boolean {
  return (
    step.status === "in-progress" &&
    typeof step.toolName === "string" &&
    step.toolName.length > 0 &&
    step.toolName === toolName
  );
}
