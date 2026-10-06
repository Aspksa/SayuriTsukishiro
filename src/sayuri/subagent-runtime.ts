import {
  spawnRestrictedSubagent,
} from "@/agent/subagents/manager";
import type { SubagentResult } from "@/agent/subagents";
import { SAYURI_RUNTIME_MODEL_HANDLE } from "./model-gateway";
import type { SayuriEvidenceReceipt } from "./evidence-ledger";
import type { SayuriPlan } from "./planner";
import {
  assertSayuriSubagentLeaseBinding,
  type SayuriSubagentCapabilityLease,
} from "./subagent-lease";
import type { SayuriTaskState } from "./task-lifecycle";

export interface SayuriLeasedSubagentResult {
  result: SubagentResult;
  receipt: SayuriEvidenceReceipt;
}

export async function runSayuriLeasedSubagent(input: {
  lease: SayuriSubagentCapabilityLease;
  task: SayuriTaskState;
  plan: SayuriPlan;
  prompt: string;
  parentAgentId?: string;
  parentConversationId?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  now?: string;
}): Promise<SayuriLeasedSubagentResult> {
  const now = input.now ?? new Date().toISOString();
  assertSayuriSubagentLeaseBinding({
    lease: input.lease,
    task: input.task,
    plan: input.plan,
    now,
  });

  const result = await spawnRestrictedSubagent({
    type: input.lease.subagentType,
    prompt: input.prompt,
    subagentId: input.lease.subagentId,
    allowedTools: input.lease.allowedTools,
    model: SAYURI_RUNTIME_MODEL_HANDLE,
    ...(input.parentAgentId ? { parentAgentId: input.parentAgentId } : {}),
    ...(input.parentConversationId
      ? { parentConversationId: input.parentConversationId }
      : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
  });

  const receipt: SayuriEvidenceReceipt = {
    id: `receipt-${input.lease.id}`,
    executionId: `subagent-${input.lease.id}`,
    taskId: input.task.id,
    stepId: input.lease.parentStepId,
    kind: "tool-result",
    trust: "derived",
    outcome: result.success ? "success" : "error",
    source: `sayuri-subagent:${input.lease.subagentType}`,
    summary: result.success
      ? `Leased subagent "${input.lease.subagentType}" completed successfully.`
      : `Leased subagent "${input.lease.subagentType}" failed: ${result.error ?? "unknown error"}`,
    createdAt: now,
    metadata: {
      leaseId: input.lease.id,
      subagentId: input.lease.subagentId,
      toolCount: input.lease.allowedTools.length,
    },
  };

  return { result, receipt };
}
