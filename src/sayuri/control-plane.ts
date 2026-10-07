import type { SayuriPlan } from "./planner";
import {
  FileSayuriBackgroundLeaseStore,
  type SayuriBackgroundLeaseRecord,
  type SayuriBackgroundLeaseStore,
} from "./background-lease";
import { cancelSayuriBackgroundSubagent } from "./background-runtime";
import {
  cancelSayuriCronWorkIntent,
  FileSayuriCronIntentStore,
  type SayuriCronIntentStore,
  type SayuriCronWorkIntent,
} from "./cron-intent";
import {
  FileSayuriBrainStateStore,
  type SayuriBrainStateSnapshot,
  type SayuriBrainStateStore,
} from "./state-store";
import {
  transitionSayuriTask,
  type SayuriTaskState,
} from "./task-lifecycle";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
  type SayuriProjectTaskEntry,
  type SayuriTaskRegistry,
} from "./task-registry";

const ACTIVE_BACKGROUND_STATUSES = new Set([
  "leased",
  "running",
  "orphaned",
] as const);

export type SayuriBackgroundControlSnapshot = Omit<
  SayuriBackgroundLeaseRecord,
  "resultReceipt"
> & {
  resultReceiptId?: string;
};

export interface SayuriSelectedTaskControlSnapshot {
  task: SayuriTaskState;
  plan: SayuriPlan;
  updatedAt: string;
}

export interface SayuriCognitiveControlSnapshot {
  projectId: string;
  tasks: SayuriProjectTaskEntry[];
  selectedTask: SayuriSelectedTaskControlSnapshot | null;
  background: SayuriBackgroundControlSnapshot[];
  cronIntents: SayuriCronWorkIntent[];
}

export interface SayuriCognitiveControlStores {
  stateStore?: SayuriBrainStateStore;
  taskRegistry?: SayuriTaskRegistry;
  backgroundStore?: SayuriBackgroundLeaseStore;
  cronIntentStore?: SayuriCronIntentStore;
}

function stores(input: SayuriCognitiveControlStores = {}) {
  return {
    stateStore: input.stateStore ?? new FileSayuriBrainStateStore(),
    taskRegistry: input.taskRegistry ?? new FileSayuriTaskRegistry(),
    backgroundStore:
      input.backgroundStore ?? new FileSayuriBackgroundLeaseStore(),
    cronIntentStore: input.cronIntentStore ?? new FileSayuriCronIntentStore(),
  };
}

function sanitizeBackground(
  record: SayuriBackgroundLeaseRecord,
): SayuriBackgroundControlSnapshot {
  const { resultReceipt, ...safe } = record;
  return {
    ...safe,
    ...(resultReceipt ? { resultReceiptId: resultReceipt.id } : {}),
  };
}

async function loadIndexedTask(input: {
  projectId: string;
  taskId: string;
  stateStore: SayuriBrainStateStore;
  taskRegistry: SayuriTaskRegistry;
}): Promise<{
  entry: SayuriProjectTaskEntry;
  snapshot: SayuriBrainStateSnapshot;
  indexedStore: ProjectIndexedSayuriBrainStateStore;
}> {
  const entry = await input.taskRegistry.getTask(
    input.projectId,
    input.taskId,
  );
  if (!entry) {
    throw new Error(
      `Sayuri task "${input.taskId}" was not found in project "${input.projectId}".`,
    );
  }
  const snapshot = await input.stateStore.loadSnapshot(input.taskId);
  if (!snapshot) {
    throw new Error(
      `Durable Sayuri state for task "${input.taskId}" was not found.`,
    );
  }
  if (snapshot.task.id !== entry.taskId || snapshot.plan.id !== entry.planId) {
    throw new Error("Sayuri task registry and durable state disagree.");
  }
  return {
    entry,
    snapshot,
    indexedStore: new ProjectIndexedSayuriBrainStateStore({
      inner: input.stateStore,
      registry: input.taskRegistry,
      projectId: input.projectId,
      agentId: entry.agentId,
      conversationId: entry.conversationId,
    }),
  };
}

function assertExpectedRevision(
  task: SayuriTaskState,
  expectedRevision: number,
): void {
  if (task.revision !== expectedRevision) {
    throw new Error(
      `Stale Sayuri task revision: expected ${expectedRevision}, current ${task.revision}.`,
    );
  }
}

export async function getSayuriCognitiveControlSnapshot(
  input: {
    projectId: string;
    taskId?: string;
  } & SayuriCognitiveControlStores,
): Promise<SayuriCognitiveControlSnapshot> {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("Sayuri projectId is required.");
  const resolved = stores(input);
  const [tasks, background, cronIntents] = await Promise.all([
    resolved.taskRegistry.listProjectTasks(projectId),
    resolved.backgroundStore.list(projectId),
    resolved.cronIntentStore.list(projectId),
  ]);
  const requestedTaskId = input.taskId?.trim();
  const selectedEntry = requestedTaskId
    ? tasks.find((task) => task.taskId === requestedTaskId)
    : tasks.find((task) => !["completed", "failed", "cancelled"].includes(task.status)) ??
      tasks[0];

  if (requestedTaskId && !selectedEntry) {
    throw new Error(
      `Sayuri task "${requestedTaskId}" was not found in project "${projectId}".`,
    );
  }
  const selectedSnapshot = selectedEntry
    ? await resolved.stateStore.loadSnapshot(selectedEntry.taskId)
    : null;
  if (selectedEntry && !selectedSnapshot) {
    throw new Error(
      `Durable Sayuri state for task "${selectedEntry.taskId}" was not found.`,
    );
  }

  return {
    projectId,
    tasks,
    selectedTask: selectedSnapshot
      ? {
          task: selectedSnapshot.task,
          plan: selectedSnapshot.plan,
          updatedAt: selectedSnapshot.updatedAt,
        }
      : null,
    background: background.map(sanitizeBackground),
    cronIntents,
  };
}

export async function confirmSayuriWaitingTask(
  input: {
    projectId: string;
    taskId: string;
    expectedRevision: number;
    now?: string;
  } & SayuriCognitiveControlStores,
): Promise<SayuriTaskState> {
  const resolved = stores(input);
  const context = await loadIndexedTask({
    projectId: input.projectId,
    taskId: input.taskId,
    stateStore: resolved.stateStore,
    taskRegistry: resolved.taskRegistry,
  });
  assertExpectedRevision(context.snapshot.task, input.expectedRevision);
  if (context.snapshot.task.status !== "waiting-user") {
    throw new Error(
      `Sayuri task confirmation requires waiting-user state, got "${context.snapshot.task.status}".`,
    );
  }

  const resumeStatus = context.snapshot.plan.steps.some(
    (step) => step.status === "in-progress",
  )
    ? "running"
    : "planning";
  const next = transitionSayuriTask(
    context.snapshot.task,
    resumeStatus,
    input.now ?? new Date().toISOString(),
  );
  await context.indexedStore.saveSnapshot(next, context.snapshot.plan);
  return next;
}

export async function cancelSayuriTaskFromControlPlane(
  input: {
    projectId: string;
    taskId: string;
    expectedRevision: number;
    now?: string;
  } & SayuriCognitiveControlStores,
): Promise<SayuriTaskState> {
  const resolved = stores(input);
  const context = await loadIndexedTask({
    projectId: input.projectId,
    taskId: input.taskId,
    stateStore: resolved.stateStore,
    taskRegistry: resolved.taskRegistry,
  });
  assertExpectedRevision(context.snapshot.task, input.expectedRevision);
  const now = input.now ?? new Date().toISOString();

  // Validate the lifecycle transition before cancelling child work so an
  // invalid/stale task request cannot create partial side effects.
  const cancelled = transitionSayuriTask(
    context.snapshot.task,
    "cancelled",
    now,
  );

  const related = (await resolved.backgroundStore.list(input.projectId)).filter(
    (record) =>
      record.lease.parentTaskId === input.taskId &&
      ACTIVE_BACKGROUND_STATUSES.has(
        record.status as "leased" | "running" | "orphaned",
      ),
  );
  for (const record of related) {
    await cancelSayuriBackgroundSubagent({
      projectId: input.projectId,
      leaseId: record.id,
      store: resolved.backgroundStore,
      now,
    });
  }
  await context.indexedStore.saveSnapshot(cancelled, context.snapshot.plan);
  return cancelled;
}

export async function cancelSayuriControlTarget(
  input:
    | ({
        kind: "task";
        projectId: string;
        taskId: string;
        expectedRevision: number;
        now?: string;
      } & SayuriCognitiveControlStores)
    | ({
        kind: "background";
        projectId: string;
        leaseId: string;
        now?: string;
      } & SayuriCognitiveControlStores)
    | ({
        kind: "cron-intent";
        projectId: string;
        intentId: string;
        now?: string;
      } & SayuriCognitiveControlStores),
): Promise<
  | { kind: "task"; task: SayuriTaskState }
  | { kind: "background"; background: SayuriBackgroundControlSnapshot }
  | { kind: "cron-intent"; cronIntent: SayuriCronWorkIntent }
> {
  if (input.kind === "task") {
    return {
      kind: "task",
      task: await cancelSayuriTaskFromControlPlane(input),
    };
  }
  const resolved = stores(input);
  if (input.kind === "background") {
    const background = await cancelSayuriBackgroundSubagent({
      projectId: input.projectId,
      leaseId: input.leaseId,
      store: resolved.backgroundStore,
      ...(input.now ? { now: input.now } : {}),
    });
    return { kind: "background", background: sanitizeBackground(background) };
  }
  return {
    kind: "cron-intent",
    cronIntent: await cancelSayuriCronWorkIntent({
      projectId: input.projectId,
      intentId: input.intentId,
      store: resolved.cronIntentStore,
      ...(input.now ? { now: input.now } : {}),
    }),
  };
}
