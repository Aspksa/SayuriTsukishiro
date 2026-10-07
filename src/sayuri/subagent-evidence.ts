import type { SayuriEvidenceReceipt } from "./evidence-ledger";
import type { SayuriPlan } from "./planner";
import {
  assertSayuriSubagentLeaseBinding,
  type SayuriSubagentCapabilityLease,
} from "./subagent-lease";
import type { SayuriTaskState } from "./task-lifecycle";

export function validateSayuriSubagentEvidenceReceipt(input: {
  lease: SayuriSubagentCapabilityLease;
  receipt: SayuriEvidenceReceipt;
  task: SayuriTaskState;
  plan: SayuriPlan;
  now?: string;
}): void {
  assertSayuriSubagentLeaseBinding({
    lease: input.lease,
    task: input.task,
    plan: input.plan,
    ...(input.now ? { now: input.now } : {}),
  });

  const expectedExecutionId = `subagent-${input.lease.id}`;
  if (input.receipt.executionId !== expectedExecutionId) {
    throw new Error("Subagent receipt executionId does not match its lease.");
  }
  if (input.receipt.taskId !== input.task.id) {
    throw new Error("Subagent receipt belongs to another parent task.");
  }
  if (input.receipt.stepId !== input.lease.parentStepId) {
    throw new Error("Subagent receipt belongs to another parent plan step.");
  }
  if (input.receipt.trust !== "derived") {
    throw new Error("Subagent receipt must use derived trust.");
  }
  if (input.receipt.source !== `sayuri-subagent:${input.lease.subagentType}`) {
    throw new Error("Subagent receipt source does not match its lease.");
  }
  if (input.receipt.metadata?.leaseId !== input.lease.id) {
    throw new Error("Subagent receipt lease metadata does not match.");
  }
  if (input.receipt.metadata?.subagentId !== input.lease.subagentId) {
    throw new Error("Subagent receipt child identity does not match.");
  }
  if (input.receipt.outcome !== "success") {
    throw new Error(
      `Subagent receipt is not successful: ${input.receipt.outcome}.`,
    );
  }
}
