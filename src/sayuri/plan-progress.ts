import {
  type SayuriPlan,
  type SayuriPlanStep,
  validateSayuriPlan,
} from "./planner";

export interface SayuriPlanProgression {
  plan: SayuriPlan;
  completedStepId: string;
  nextStep: SayuriPlanStep | null;
  planComplete: boolean;
}

function dependenciesComplete(
  step: SayuriPlanStep,
  completedIds: ReadonlySet<string>,
): boolean {
  return (step.dependsOnStepIds ?? []).every((id) => completedIds.has(id));
}

export function progressSayuriPlanFromVerifiedStep(input: {
  plan: SayuriPlan;
  stepId: string;
  receiptIds: readonly string[];
}): SayuriPlanProgression {
  const validation = validateSayuriPlan(input.plan);
  if (!validation.valid) {
    throw new Error(
      `Cannot progress invalid Sayuri plan: ${validation.errors.join(" ")}`,
    );
  }

  const target = input.plan.steps.find((step) => step.id === input.stepId);
  if (!target) throw new Error(`Plan step "${input.stepId}" does not exist.`);
  if (target.status !== "in-progress") {
    throw new Error(
      `Verified step "${input.stepId}" must be in-progress, got "${target.status}".`,
    );
  }

  const receiptIds = [
    ...new Set(input.receiptIds.map((id) => id.trim())),
  ].filter(Boolean);
  if (target.requiresEvidence && receiptIds.length === 0) {
    throw new Error(
      `Plan step "${input.stepId}" requires verified evidence receipts.`,
    );
  }

  const completedTarget: SayuriPlanStep = {
    ...target,
    status: "completed",
    ...(target.requiresEvidence
      ? {
          receiptIds: [
            ...new Set([...(target.receiptIds ?? []), ...receiptIds]),
          ],
        }
      : target.receiptIds
        ? { receiptIds: [...target.receiptIds] }
        : {}),
  };

  let steps = input.plan.steps.map((step) =>
    step.id === target.id ? completedTarget : { ...step },
  );
  const completedIds = new Set(
    steps.filter((step) => step.status === "completed").map((step) => step.id),
  );

  const nextIndex = steps.findIndex(
    (step) =>
      step.status === "pending" && dependenciesComplete(step, completedIds),
  );
  if (nextIndex >= 0) {
    steps = steps.map((step, index) =>
      index === nextIndex ? { ...step, status: "in-progress" as const } : step,
    );
  }

  const nextPlan: SayuriPlan = { ...input.plan, steps };
  const nextValidation = validateSayuriPlan(nextPlan);
  if (!nextValidation.valid) {
    throw new Error(
      `Progressed Sayuri plan is invalid: ${nextValidation.errors.join(" ")}`,
    );
  }

  return {
    plan: nextPlan,
    completedStepId: target.id,
    nextStep: nextIndex >= 0 ? { ...nextPlan.steps[nextIndex]! } : null,
    planComplete: nextPlan.steps.every(
      (step) => step.status === "completed" || step.status === "cancelled",
    ),
  };
}
