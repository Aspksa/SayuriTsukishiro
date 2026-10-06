import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { SayuriPlan } from "./planner";
import type { SayuriTaskState } from "./task-lifecycle";
import { classifySayuriToolRisk } from "./tool-risk";

export type SayuriSubagentLeaseMode = "read-only" | "scoped-project-mutation";

export interface SayuriSubagentCapabilityLease {
  id: string;
  parentTaskId: string;
  parentPlanId: string;
  parentStepId: string;
  subagentId: string;
  subagentType: string;
  mode: SayuriSubagentLeaseMode;
  allowedTools: readonly string[];
  scopeRoot: string;
  issuedAt: string;
  expiresAt?: string;
}

const SAFE_PROJECT_MUTATION_TOOLS = new Set([
  "ApplyPatch",
  "Edit",
  "Write",
  "write_artifact_file",
]);

export function createSayuriSubagentCapabilityLease(input: {
  parentTaskId: string;
  parentPlanId: string;
  parentStepId: string;
  subagentId: string;
  subagentType: string;
  mode?: SayuriSubagentLeaseMode;
  allowedTools: readonly string[];
  scopeRoot: string;
  issuedAt?: string;
  expiresAt?: string;
  id?: string;
}): SayuriSubagentCapabilityLease {
  const lease: SayuriSubagentCapabilityLease = {
    id: input.id?.trim() || `subagent-lease-${randomUUID()}`,
    parentTaskId: input.parentTaskId.trim(),
    parentPlanId: input.parentPlanId.trim(),
    parentStepId: input.parentStepId.trim(),
    subagentId: input.subagentId.trim(),
    subagentType: input.subagentType.trim(),
    mode: input.mode ?? "read-only",
    allowedTools: [...new Set(input.allowedTools.map((tool) => tool.trim()))],
    scopeRoot: resolve(input.scopeRoot),
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
  };
  validateSayuriSubagentCapabilityLease(lease);
  return lease;
}

export function validateSayuriSubagentCapabilityLease(
  lease: SayuriSubagentCapabilityLease,
  now: string = new Date().toISOString(),
): void {
  for (const [field, value] of [
    ["id", lease.id],
    ["parentTaskId", lease.parentTaskId],
    ["parentPlanId", lease.parentPlanId],
    ["parentStepId", lease.parentStepId],
    ["subagentId", lease.subagentId],
    ["subagentType", lease.subagentType],
    ["scopeRoot", lease.scopeRoot],
  ] as const) {
    if (!value.trim()) throw new Error(`Subagent lease ${field} is required.`);
  }
  if (lease.allowedTools.length === 0) {
    throw new Error("Subagent lease requires at least one explicit tool.");
  }
  if (Number.isNaN(Date.parse(lease.issuedAt))) {
    throw new Error("Subagent lease issuedAt must be ISO-compatible.");
  }
  if (lease.expiresAt) {
    if (Number.isNaN(Date.parse(lease.expiresAt))) {
      throw new Error("Subagent lease expiresAt must be ISO-compatible.");
    }
    if (Date.parse(lease.expiresAt) <= Date.parse(now)) {
      throw new Error("Subagent capability lease has expired.");
    }
  }

  for (const tool of lease.allowedTools) {
    if (!tool) throw new Error("Subagent lease tool names must be non-empty.");
    const risk = classifySayuriToolRisk(tool);
    if (lease.mode === "read-only" && risk !== "read") {
      throw new Error(
        `Read-only subagent lease cannot grant "${tool}" (${risk}).`,
      );
    }
    if (
      lease.mode === "scoped-project-mutation" &&
      risk !== "read" &&
      !SAFE_PROJECT_MUTATION_TOOLS.has(tool)
    ) {
      throw new Error(
        `Scoped subagent lease cannot grant "${tool}" (${risk}).`,
      );
    }
  }
}

export function assertSayuriSubagentLeaseBinding(input: {
  lease: SayuriSubagentCapabilityLease;
  task: SayuriTaskState;
  plan: SayuriPlan;
  now?: string;
}): void {
  validateSayuriSubagentCapabilityLease(
    input.lease,
    input.now ?? new Date().toISOString(),
  );
  if (input.task.id !== input.lease.parentTaskId) {
    throw new Error("Subagent lease parent task does not match.");
  }
  if (input.plan.id !== input.lease.parentPlanId) {
    throw new Error("Subagent lease parent plan does not match.");
  }
  if (input.plan.taskId !== input.task.id) {
    throw new Error("Subagent lease parent plan/task identity does not match.");
  }
  if (!["running", "verifying"].includes(input.task.status)) {
    throw new Error(
      `Subagent lease requires executable parent task, got "${input.task.status}".`,
    );
  }
  const step = input.plan.steps.find(
    (candidate) => candidate.id === input.lease.parentStepId,
  );
  if (!step) throw new Error("Subagent lease parent step does not exist.");
  if (step.status !== "in-progress") {
    throw new Error(
      `Subagent lease parent step must be in-progress, got "${step.status}".`,
    );
  }
}
