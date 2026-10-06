import { randomUUID } from "node:crypto";
import { classifySayuriToolRisk } from "./execution-control";
import type { SayuriPlannerSeed } from "./goal-manager";
import {
  type SayuriPlan,
  type SayuriPlanStep,
  validateSayuriPlan,
} from "./planner";

export const SAYURI_PLANNER_V1_MAX_STEPS = 12;

export interface SayuriPlannerV1ProposalStep {
  id: string;
  title: string;
  intent: string;
  toolName?: string;
  dependsOnStepIds?: readonly string[];
}

export interface SayuriPlannerV1Proposal {
  taskId: string;
  goalId: string;
  steps: readonly SayuriPlannerV1ProposalStep[];
}

const TOP_LEVEL_KEYS = new Set(["taskId", "goalId", "steps"]);
const STEP_KEYS = new Set([
  "id",
  "title",
  "intent",
  "toolName",
  "dependsOnStepIds",
]);
const FORBIDDEN_AUTHORITY_KEYS = new Set([
  "risk",
  "requiresEvidence",
  "receiptIds",
  "status",
  "approvalGranted",
  "scopeApproved",
  "permission",
  "permissions",
  "arguments",
  "args",
]);

function assertRecord(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
      throw new Error(`${label} cannot define authority field "${key}".`);
    }
    if (!allowed.has(key)) {
      throw new Error(`${label} contains unsupported field "${key}".`);
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalStringArray(
  value: unknown,
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error(`${label} must contain non-empty strings.`);
  }
  const normalized = value.map((item) => item.trim());
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} must not contain duplicates.`);
  }
  return normalized;
}

export function parseSayuriPlannerV1Proposal(
  value: unknown,
  seed: SayuriPlannerSeed,
): SayuriPlannerV1Proposal {
  assertRecord(value, "Planner proposal");
  assertExactKeys(value, TOP_LEVEL_KEYS, "Planner proposal");

  const taskId = requiredString(value.taskId, "Planner proposal taskId");
  const goalId = requiredString(value.goalId, "Planner proposal goalId");
  if (taskId !== seed.taskId || goalId !== seed.goalId) {
    throw new Error("Planner proposal identity does not match the planner seed.");
  }
  if (
    !Array.isArray(value.steps) ||
    value.steps.length === 0 ||
    value.steps.length > SAYURI_PLANNER_V1_MAX_STEPS
  ) {
    throw new Error(
      `Planner proposal must contain 1-${SAYURI_PLANNER_V1_MAX_STEPS} steps.`,
    );
  }

  const seen = new Set<string>();
  const steps: SayuriPlannerV1ProposalStep[] = value.steps.map(
    (candidate, index) => {
      assertRecord(candidate, `Planner step ${index + 1}`);
      assertExactKeys(candidate, STEP_KEYS, `Planner step ${index + 1}`);
      const id = requiredString(candidate.id, `Planner step ${index + 1} id`);
      if (seen.has(id)) throw new Error(`Duplicate planner step id "${id}".`);
      const dependencies = optionalStringArray(
        candidate.dependsOnStepIds,
        `Planner step "${id}" dependencies`,
      );
      for (const dependency of dependencies ?? []) {
        if (!seen.has(dependency)) {
          throw new Error(
            `Planner step "${id}" may depend only on an earlier step; "${dependency}" is invalid.`,
          );
        }
      }
      seen.add(id);
      const toolName =
        candidate.toolName === undefined
          ? undefined
          : requiredString(candidate.toolName, `Planner step "${id}" toolName`);
      return {
        id,
        title: requiredString(candidate.title, `Planner step "${id}" title`),
        intent: requiredString(candidate.intent, `Planner step "${id}" intent`),
        ...(toolName ? { toolName } : {}),
        ...(dependencies ? { dependsOnStepIds: dependencies } : {}),
      };
    },
  );

  return { taskId, goalId, steps };
}

function compileStep(
  proposal: SayuriPlannerV1ProposalStep,
  index: number,
): SayuriPlanStep {
  const risk = proposal.toolName
    ? classifySayuriToolRisk(proposal.toolName)
    : "read";
  return {
    id: proposal.id,
    title: proposal.title,
    intent: proposal.intent,
    status: index === 0 ? "in-progress" : "pending",
    risk,
    requiresEvidence: risk !== "read",
    ...(proposal.toolName ? { toolName: proposal.toolName } : {}),
    ...(proposal.dependsOnStepIds
      ? { dependsOnStepIds: [...proposal.dependsOnStepIds] }
      : {}),
  };
}

export function compileSayuriPlannerV1Plan(input: {
  seed: SayuriPlannerSeed;
  proposal: SayuriPlannerV1Proposal;
  planId?: string;
  createdAt?: string;
}): SayuriPlan {
  if (
    input.proposal.taskId !== input.seed.taskId ||
    input.proposal.goalId !== input.seed.goalId
  ) {
    throw new Error("Planner proposal identity does not match planner seed.");
  }

  const plan: SayuriPlan = {
    id: input.planId?.trim() || `plan-${randomUUID()}`,
    taskId: input.seed.taskId,
    goal: input.seed.goal,
    createdAt: input.createdAt ?? new Date().toISOString(),
    steps: input.proposal.steps.map(compileStep),
  };
  const validation = validateSayuriPlan(plan);
  if (!validation.valid) {
    throw new Error(
      `Compiled Sayuri plan is invalid: ${validation.errors.join(" ")}`,
    );
  }
  return plan;
}

export function buildSayuriPlannerV1Prompt(seed: SayuriPlannerSeed): string {
  return [
    "You are the proposal component of Sayuri Planner v1.",
    "Return JSON only. You may propose order, intent, and an intended tool name.",
    "Never output permissions, approvals, risk, evidence policy, tool arguments, or execution authority.",
    `Maximum steps: ${SAYURI_PLANNER_V1_MAX_STEPS}.`,
    "Dependencies may reference only earlier step ids.",
    JSON.stringify({
      taskId: seed.taskId,
      projectId: seed.projectId,
      goalId: seed.goalId,
      objective: seed.goal,
      constraints: seed.constraints,
      successCriteria: seed.successCriteria,
      responseShape: {
        taskId: seed.taskId,
        goalId: seed.goalId,
        steps: [
          {
            id: "step-1",
            title: "short title",
            intent: "what this step should accomplish",
            toolName: "optional intended tool",
            dependsOnStepIds: [],
          },
        ],
      },
    }),
  ].join("\n");
}
