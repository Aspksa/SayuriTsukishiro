import {
  createSayuriBackgroundLeaseRecord,
  recoverSayuriBackgroundLeases,
  type SayuriBackgroundLeaseRecord,
  type SayuriBackgroundLeaseStore,
  transitionSayuriBackgroundLease,
} from "./background-lease";
import type { SayuriExecutionController } from "./execution-control";
import type { SayuriPlan } from "./planner";
import type { SayuriSubagentCapabilityLease } from "./subagent-lease";
import { runSayuriLeasedSubagent } from "./subagent-runtime";
import type { SayuriTaskState } from "./task-lifecycle";

const liveControllers = new Map<string, AbortController>();

export function isSayuriBackgroundLeaseLive(leaseId: string): boolean {
  return liveControllers.has(leaseId);
}

export interface SayuriBackgroundRunHandle {
  record: SayuriBackgroundLeaseRecord;
  completion: Promise<SayuriBackgroundLeaseRecord>;
}

export async function startSayuriBackgroundSubagent(input: {
  projectId: string;
  ownerAgentId: string;
  ownerConversationId: string;
  lease: SayuriSubagentCapabilityLease;
  deadlineAt: string;
  task: SayuriTaskState;
  plan: SayuriPlan;
  prompt: string;
  store: SayuriBackgroundLeaseStore;
  maxTurns?: number;
  now?: string;
}): Promise<SayuriBackgroundRunHandle> {
  const now = input.now ?? new Date().toISOString();
  let record = createSayuriBackgroundLeaseRecord({
    projectId: input.projectId,
    ownerAgentId: input.ownerAgentId,
    ownerConversationId: input.ownerConversationId,
    lease: input.lease,
    deadlineAt: input.deadlineAt,
    assignment: input.prompt,
    now,
  });
  await input.store.save(record);
  record = transitionSayuriBackgroundLease(record, "running", { now });
  await input.store.save(record);

  const abort = new AbortController();
  liveControllers.set(input.lease.id, abort);
  const completion = runSayuriLeasedSubagent({
    lease: input.lease,
    task: input.task,
    plan: input.plan,
    prompt: input.prompt,
    parentAgentId: input.ownerAgentId,
    parentConversationId: input.ownerConversationId,
    signal: abort.signal,
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
  })
    .then(async ({ result, receipt }) => {
      const current =
        (await input.store.get(input.projectId, input.lease.id)) ?? record;
      if (current.status === "cancelled" || current.status === "expired") {
        return current;
      }
      const next = result.success
        ? transitionSayuriBackgroundLease(current, "completed", {
            resultReceipt: receipt,
          })
        : transitionSayuriBackgroundLease(current, "failed", {
            error: result.error ?? "Background subagent failed.",
          });
      await input.store.save(next);
      return next;
    })
    .finally(() => {
      liveControllers.delete(input.lease.id);
    });

  return { record, completion };
}

export async function resumeSayuriOrphanedBackgroundSubagent(input: {
  projectId: string;
  leaseId: string;
  task: SayuriTaskState;
  plan: SayuriPlan;
  store: SayuriBackgroundLeaseStore;
  maxTurns?: number;
  now?: string;
}): Promise<SayuriBackgroundRunHandle> {
  const now = input.now ?? new Date().toISOString();
  const record = await input.store.get(input.projectId, input.leaseId);
  if (!record)
    throw new Error(`Background lease "${input.leaseId}" was not found.`);
  if (record.status !== "orphaned") {
    throw new Error(
      `Background lease "${record.id}" is not orphaned: ${record.status}.`,
    );
  }
  if (record.lease.mode !== "read-only") {
    throw new Error(
      "Only read-only orphaned background leases may auto-resume.",
    );
  }
  if (!record.assignment?.trim()) {
    throw new Error("Orphaned background lease has no durable assignment.");
  }
  if (Date.parse(record.deadlineAt) <= Date.parse(now)) {
    const expired = transitionSayuriBackgroundLease(record, "expired", { now });
    await input.store.save(expired);
    return { record: expired, completion: Promise.resolve(expired) };
  }

  const running = transitionSayuriBackgroundLease(record, "running", { now });
  await input.store.save(running);
  const abort = new AbortController();
  liveControllers.set(record.id, abort);
  const completion = runSayuriLeasedSubagent({
    lease: record.lease,
    task: input.task,
    plan: input.plan,
    prompt: record.assignment,
    parentAgentId: record.ownerAgentId,
    parentConversationId: record.ownerConversationId,
    signal: abort.signal,
    ...(input.maxTurns ? { maxTurns: input.maxTurns } : {}),
  })
    .then(async ({ result, receipt }) => {
      const current =
        (await input.store.get(input.projectId, record.id)) ?? running;
      if (current.status === "cancelled" || current.status === "expired") {
        return current;
      }
      const next = result.success
        ? transitionSayuriBackgroundLease(current, "completed", {
            resultReceipt: receipt,
          })
        : transitionSayuriBackgroundLease(current, "failed", {
            error: result.error ?? "Background subagent failed.",
          });
      await input.store.save(next);
      return next;
    })
    .finally(() => {
      liveControllers.delete(record.id);
    });

  return { record: running, completion };
}

export async function cancelSayuriBackgroundSubagent(input: {
  projectId: string;
  leaseId: string;
  store: SayuriBackgroundLeaseStore;
  now?: string;
}): Promise<SayuriBackgroundLeaseRecord> {
  const record = await input.store.get(input.projectId, input.leaseId);
  if (!record)
    throw new Error(`Background lease "${input.leaseId}" was not found.`);
  if (!["leased", "running", "orphaned"].includes(record.status)) {
    throw new Error(
      `Background lease cannot be cancelled from "${record.status}".`,
    );
  }
  liveControllers.get(input.leaseId)?.abort();
  const cancelled = transitionSayuriBackgroundLease(record, "cancelled", {
    now: input.now ?? new Date().toISOString(),
  });
  await input.store.save(cancelled);
  return cancelled;
}

export async function handoffSayuriBackgroundResult(input: {
  projectId: string;
  leaseId: string;
  store: SayuriBackgroundLeaseStore;
  controller: SayuriExecutionController;
  summary: string;
  nextAction: string;
  now?: string;
}): Promise<SayuriBackgroundLeaseRecord> {
  const record = await input.store.get(input.projectId, input.leaseId);
  if (!record)
    throw new Error(`Background lease "${input.leaseId}" was not found.`);
  if (record.status === "handed-off") return record;
  if (record.status !== "completed" || !record.resultReceipt) {
    throw new Error(
      `Background lease "${record.id}" is not ready for handoff: ${record.status}.`,
    );
  }

  const receiptAlreadyDurable = input.controller
    .evidenceSnapshot()
    .some((receipt) => receipt.id === record.resultReceipt?.id);
  const step = input.controller.plan.steps.find(
    (candidate) => candidate.id === record.lease.parentStepId,
  );

  if (!(receiptAlreadyDurable && step?.status === "completed")) {
    await input.controller.checkpointSubagentReceipt({
      lease: record.lease,
      receipt: record.resultReceipt,
      summary: input.summary,
      nextAction: input.nextAction,
      ...(input.now ? { createdAt: input.now } : {}),
    });
  }

  const handedOff = transitionSayuriBackgroundLease(record, "handed-off", {
    now: input.now ?? new Date().toISOString(),
  });
  await input.store.save(handedOff);
  return handedOff;
}

export async function inspectSayuriBackgroundRecovery(input: {
  projectId: string;
  store: SayuriBackgroundLeaseStore;
  now?: string;
}): Promise<SayuriBackgroundLeaseRecord[]> {
  return recoverSayuriBackgroundLeases(input);
}
