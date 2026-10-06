import type { SayuriActionRisk } from "./action-broker";

export type SayuriPlanStepStatus =
  | "pending"
  | "in-progress"
  | "completed"
  | "blocked"
  | "cancelled";

export interface SayuriPlanStep {
  id: string;
  title: string;
  status: SayuriPlanStepStatus;
  risk: SayuriActionRisk;
  requiresEvidence: boolean;
  /** Deterministic planner-selected tool family; never an approval grant. */
  toolName?: string;
  /** Human/model-readable intent without executable arguments. */
  intent?: string;
  /** Dependencies may only reference earlier plan steps. */
  dependsOnStepIds?: readonly string[];
  receiptIds?: readonly string[];
}

export interface SayuriPlan {
  id: string;
  taskId: string;
  goal: string;
  createdAt: string;
  steps: readonly SayuriPlanStep[];
}

export interface SayuriPlanValidation {
  valid: boolean;
  errors: readonly string[];
}

function stepNeedsEvidence(step: SayuriPlanStep): boolean {
  return step.risk !== "read";
}

/**
 * Validate planner output before the Action Broker may execute it.
 *
 * A plan is data, not authority: non-read actions must declare evidence
 * requirements, and completed evidence-bearing steps must reference receipts.
 */
export function validateSayuriPlan(plan: SayuriPlan): SayuriPlanValidation {
  const errors: string[] = [];
  if (!plan.id.trim()) errors.push("Plan id is required.");
  if (!plan.taskId.trim()) errors.push("Plan taskId is required.");
  if (!plan.goal.trim()) errors.push("Plan goal is required.");
  if (Number.isNaN(Date.parse(plan.createdAt))) {
    errors.push("Plan createdAt must be ISO-compatible.");
  }
  if (plan.steps.length === 0)
    errors.push("Plan must contain at least one step.");

  const ids = new Set<string>();
  let inProgress = 0;
  for (const step of plan.steps) {
    if (!step.id.trim()) errors.push("Every plan step requires an id.");
    if (!step.title.trim()) {
      errors.push(`Plan step "${step.id || "<unknown>"}" requires a title.`);
    }
    if (ids.has(step.id)) errors.push(`Duplicate plan step id "${step.id}".`);
    for (const dependency of step.dependsOnStepIds ?? []) {
      if (!ids.has(dependency)) {
        errors.push(
          `Plan step "${step.id}" depends on missing or later step "${dependency}".`,
        );
      }
    }
    if (
      step.dependsOnStepIds &&
      new Set(step.dependsOnStepIds).size !== step.dependsOnStepIds.length
    ) {
      errors.push(`Plan step "${step.id}" has duplicate dependencies.`);
    }
    ids.add(step.id);
    if (step.status === "in-progress") inProgress++;

    if (stepNeedsEvidence(step) && !step.requiresEvidence) {
      errors.push(
        `Mutating plan step "${step.id}" must require execution evidence.`,
      );
    }
    if (
      step.status === "completed" &&
      step.requiresEvidence &&
      (!step.receiptIds || step.receiptIds.length === 0)
    ) {
      errors.push(
        `Completed plan step "${step.id}" is missing evidence receipts.`,
      );
    }
  }

  if (inProgress > 1) {
    errors.push("At most one plan step may be in progress.");
  }

  return { valid: errors.length === 0, errors };
}

export function getNextSayuriPlanStep(plan: SayuriPlan): SayuriPlanStep | null {
  const active = plan.steps.find((step) => step.status === "in-progress");
  if (active) return { ...active };
  const pending = plan.steps.find((step) => step.status === "pending");
  return pending ? { ...pending } : null;
}
