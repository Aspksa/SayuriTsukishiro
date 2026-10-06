import {
  FileSayuriBackgroundLeaseStore,
  recoverSayuriBackgroundLeases,
  type SayuriBackgroundLeaseRecord,
  type SayuriBackgroundLeaseStore,
} from "./background-lease";
import {
  handoffSayuriBackgroundResult,
  isSayuriBackgroundLeaseLive,
  resumeSayuriOrphanedBackgroundSubagent,
} from "./background-runtime";
import type { SayuriPrimarySession } from "./session";

export type SayuriBackgroundSupervisionDecision =
  | { kind: "none" }
  | {
      kind: "handoff-complete";
      record: SayuriBackgroundLeaseRecord;
    }
  | {
      kind: "background-running";
      record: SayuriBackgroundLeaseRecord;
    }
  | {
      kind: "background-blocked";
      record: SayuriBackgroundLeaseRecord;
      reason: string;
    };

export function canAutoResumeSayuriBackgroundLease(
  record: SayuriBackgroundLeaseRecord,
  now: string = new Date().toISOString(),
): boolean {
  return (
    record.status === "orphaned" &&
    record.lease.mode === "read-only" &&
    Boolean(record.assignment?.trim()) &&
    Date.parse(record.deadlineAt) > Date.parse(now)
  );
}

export async function superviseSayuriBackgroundForSession(input: {
  session: SayuriPrimarySession;
  store?: SayuriBackgroundLeaseStore;
  now?: string;
  resumeSafeReadOnly?: boolean;
}): Promise<SayuriBackgroundSupervisionDecision> {
  const store = input.store ?? new FileSayuriBackgroundLeaseStore();
  const now = input.now ?? new Date().toISOString();
  const recovered = await recoverSayuriBackgroundLeases({
    projectId: input.session.projectId,
    store,
    now,
    isLive: isSayuriBackgroundLeaseLive,
  });
  const taskId = input.session.controller.task.id;
  const records = recovered
    .filter(
      (record) =>
        record.lease.parentTaskId === taskId &&
        record.status !== "handed-off",
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  const completed = records.find((record) => record.status === "completed");
  if (completed) {
    const handedOff = await handoffSayuriBackgroundResult({
      projectId: input.session.projectId,
      leaseId: completed.id,
      store,
      controller: input.session.controller,
      summary: "Background subagent result accepted by parent verifier.",
      nextAction: "Continue with the next deterministic plan step.",
      now,
    });
    return { kind: "handoff-complete", record: handedOff };
  }

  const running = records.find((record) => record.status === "running");
  if (running) return { kind: "background-running", record: running };

  const orphaned = records.find((record) => record.status === "orphaned");
  if (orphaned) {
    if (
      (input.resumeSafeReadOnly ?? true) &&
      canAutoResumeSayuriBackgroundLease(orphaned, now)
    ) {
      const resumed = await resumeSayuriOrphanedBackgroundSubagent({
        projectId: input.session.projectId,
        leaseId: orphaned.id,
        task: input.session.controller.task,
        plan: input.session.controller.plan,
        store,
        now,
      });
      void resumed.completion;
      return { kind: "background-running", record: resumed.record };
    }
    return {
      kind: "background-blocked",
      record: orphaned,
      reason:
        orphaned.lease.mode === "read-only"
          ? "Orphaned read-only background lease is not safe to auto-resume."
          : "Orphaned mutation lease requires explicit cancellation or a new approved lease.",
    };
  }

  const blocking = records.find((record) =>
    ["failed", "expired", "cancelled"].includes(record.status),
  );
  if (blocking) {
    return {
      kind: "background-blocked",
      record: blocking,
      reason: `Background lease is ${blocking.status}; parent plan step remains unresolved.`,
    };
  }

  return { kind: "none" };
}
