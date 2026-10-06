import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import type { ConfigureSayuriModelRuntimeInput } from "./model-runtime";
import {
  bootstrapSayuriPrimarySession,
  type SayuriPrimarySession,
} from "./session";
import {
  FileSayuriBrainStateStore,
  type SayuriBrainStateSnapshot,
  type SayuriBrainStateStore,
} from "./state-store";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
  type SayuriProjectTaskEntry,
  type SayuriTaskRegistry,
} from "./task-registry";
import {
  isTerminalSayuriTaskStatus,
  transitionSayuriTask,
  type SayuriTaskState,
  type SayuriTaskStatus,
} from "./task-lifecycle";

export type SayuriRecoveryDisposition =
  | "executable"
  | "needs-lifecycle-advance"
  | "waiting-user"
  | "waiting-external"
  | "terminal";

export type SayuriProjectRecoveryResult =
  | { kind: "none" }
  | {
      kind: "waiting-user" | "waiting-external";
      task: SayuriProjectTaskEntry;
    }
  | {
      kind: "session";
      session: SayuriPrimarySession;
      recoveredTaskId: string;
    };

export function classifySayuriTaskRecovery(
  status: SayuriTaskStatus,
): SayuriRecoveryDisposition {
  if (status === "waiting-user") return "waiting-user";
  if (status === "waiting-external") return "waiting-external";
  if (isTerminalSayuriTaskStatus(status)) return "terminal";
  if (status === "created" || status === "planning" || status === "ready") {
    return "needs-lifecycle-advance";
  }
  return "executable";
}

export function advanceSayuriTaskForExecution(
  task: SayuriTaskState,
  now: string = new Date().toISOString(),
): SayuriTaskState {
  let next = task;
  if (next.status === "created") {
    next = transitionSayuriTask(next, "planning", now);
  }
  if (next.status === "planning") {
    next = transitionSayuriTask(next, "ready", now);
  }
  if (next.status === "ready") {
    next = transitionSayuriTask(next, "running", now);
  }
  if (
    next.status === "waiting-user" ||
    next.status === "waiting-external" ||
    isTerminalSayuriTaskStatus(next.status)
  ) {
    throw new Error(
      `Task status "${next.status}" requires an explicit recovery trigger.`,
    );
  }
  return next;
}

export function resumeWaitingSayuriTask(
  task: SayuriTaskState,
  trigger: "user-confirmed" | "external-ready",
  now: string = new Date().toISOString(),
): SayuriTaskState {
  if (task.status === "waiting-user" && trigger !== "user-confirmed") {
    throw new Error("waiting-user requires the user-confirmed trigger.");
  }
  if (task.status === "waiting-external" && trigger !== "external-ready") {
    throw new Error("waiting-external requires the external-ready trigger.");
  }
  if (task.status !== "waiting-user" && task.status !== "waiting-external") {
    throw new Error(
      `Task status "${task.status}" is not a waiting recovery state.`,
    );
  }
  return transitionSayuriTask(task, "running", now);
}

async function indexedStore(input: {
  inner: SayuriBrainStateStore;
  registry: SayuriTaskRegistry;
  projectId: string;
  agentId: string;
  conversationId: string;
}) {
  return new ProjectIndexedSayuriBrainStateStore(input);
}

async function synchronizeSnapshotIndex(input: {
  snapshot: SayuriBrainStateSnapshot;
  inner: SayuriBrainStateStore;
  registry: SayuriTaskRegistry;
  projectId: string;
  agentId: string;
  conversationId: string;
}): Promise<ProjectIndexedSayuriBrainStateStore> {
  const store = await indexedStore({
    inner: input.inner,
    registry: input.registry,
    projectId: input.projectId,
    agentId: input.agentId,
    conversationId: input.conversationId,
  });
  await store.saveSnapshot(input.snapshot.task, input.snapshot.plan);
  return store;
}

export async function recoverLatestSayuriSessionForProject(input: {
  projectId: string;
  scopeRoot: string;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  stateStore?: SayuriBrainStateStore;
  taskRegistry?: SayuriTaskRegistry;
  modelsRuntime?: LocalPiModelsRuntime;
  now?: string;
}): Promise<SayuriProjectRecoveryResult> {
  if (!input.projectId.trim()) throw new Error("Recovery projectId is required.");
  const inner = input.stateStore ?? new FileSayuriBrainStateStore();
  const registry = input.taskRegistry ?? new FileSayuriTaskRegistry();
  const entries = await registry.listProjectTasks(input.projectId);
  const unfinishedEntries = entries.filter(
    (entry) => !isTerminalSayuriTaskStatus(entry.status),
  );
  if (unfinishedEntries.length > 1) {
    throw new Error(
      `Project "${input.projectId}" has multiple unfinished Sayuri tasks: ${unfinishedEntries.map((entry) => entry.taskId).join(", ")}.`,
    );
  }

  for (const entry of entries) {
    if (isTerminalSayuriTaskStatus(entry.status)) continue;

    const snapshot = await inner.loadSnapshot(entry.taskId);
    if (!snapshot) {
      throw new Error(
        `Project registry points to missing durable task "${entry.taskId}".`,
      );
    }

    const disposition = classifySayuriTaskRecovery(snapshot.task.status);
    const store = await synchronizeSnapshotIndex({
      snapshot,
      inner,
      registry,
      projectId: input.projectId,
      agentId: entry.agentId,
      conversationId: entry.conversationId,
    });

    if (disposition === "terminal") {
      continue;
    }
    if (disposition === "waiting-user" || disposition === "waiting-external") {
      const synchronized = await registry.getTask(
        input.projectId,
        entry.taskId,
      );
      if (!synchronized) {
        throw new Error("Sayuri recovery index synchronization failed.");
      }
      return { kind: disposition, task: synchronized };
    }

    if (disposition === "needs-lifecycle-advance") {
      const advanced = advanceSayuriTaskForExecution(
        snapshot.task,
        input.now ?? new Date().toISOString(),
      );
      await store.saveSnapshot(advanced, snapshot.plan);
    }

    const session = await bootstrapSayuriPrimarySession({
      projectId: input.projectId,
      agentId: entry.agentId,
      conversationId: entry.conversationId,
      taskId: entry.taskId,
      scopeRoot: input.scopeRoot,
      modelGateway: input.modelGateway,
      stateStore: inner,
      taskRegistry: registry,
      ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
    });
    return {
      kind: "session",
      session,
      recoveredTaskId: entry.taskId,
    };
  }

  return { kind: "none" };
}

export async function releaseWaitingSayuriTask(input: {
  projectId: string;
  taskId: string;
  trigger: "user-confirmed" | "external-ready";
  stateStore?: SayuriBrainStateStore;
  taskRegistry?: SayuriTaskRegistry;
  now?: string;
}): Promise<SayuriProjectTaskEntry> {
  const inner = input.stateStore ?? new FileSayuriBrainStateStore();
  const registry = input.taskRegistry ?? new FileSayuriTaskRegistry();
  const entry = await registry.getTask(input.projectId, input.taskId);
  if (!entry) {
    throw new Error(`Task "${input.taskId}" is not indexed for this project.`);
  }
  const snapshot = await inner.loadSnapshot(input.taskId);
  if (!snapshot) {
    throw new Error(`Durable task "${input.taskId}" was not found.`);
  }
  const nextTask = resumeWaitingSayuriTask(
    snapshot.task,
    input.trigger,
    input.now ?? new Date().toISOString(),
  );
  const store = await indexedStore({
    inner,
    registry,
    projectId: input.projectId,
    agentId: entry.agentId,
    conversationId: entry.conversationId,
  });
  await store.saveSnapshot(nextTask, snapshot.plan);
  const updated = await registry.getTask(input.projectId, input.taskId);
  if (!updated) throw new Error("Updated task registry entry was not found.");
  return updated;
}
