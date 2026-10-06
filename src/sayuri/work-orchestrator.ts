import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  decideNextSayuriProjectWork,
  FileSayuriGoalStore,
  linkTaskToSayuriGoal,
  type SayuriGoalStore,
} from "./goal-manager";
import type { ConfigureSayuriModelRuntimeInput } from "./model-runtime";
import { planAndPersistSayuriTask } from "./planner-runtime";
import {
  bootstrapSayuriPrimarySession,
  type SayuriPrimarySession,
} from "./session";
import {
  FileSayuriBrainStateStore,
  type SayuriBrainStateStore,
} from "./state-store";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
  type SayuriProjectTaskEntry,
  type SayuriTaskRegistry,
} from "./task-registry";
import {
  recoverLatestSayuriSessionForProject,
  type SayuriProjectRecoveryResult,
} from "./task-recovery";
import { transitionSayuriTask } from "./task-lifecycle";

export type SayuriProjectWorkOrchestrationResult =
  | {
      kind: "session";
      source: "recovered" | "new-goal";
      session: SayuriPrimarySession;
      taskId: string;
      goalId?: string;
    }
  | {
      kind: "waiting-user" | "waiting-external";
      task: SayuriProjectTaskEntry;
    }
  | { kind: "idle"; reason: string };

export interface OrchestrateSayuriProjectWorkInput {
  projectId: string;
  agentId: string;
  conversationId: string;
  scopeRoot: string;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  stateStore?: SayuriBrainStateStore;
  taskRegistry?: SayuriTaskRegistry;
  goalStore?: SayuriGoalStore;
  modelsRuntime?: LocalPiModelsRuntime;
  now?: string;
  taskIdFactory?: () => string;
}

function recoveryResult(
  recovery: SayuriProjectRecoveryResult,
): SayuriProjectWorkOrchestrationResult | null {
  if (recovery.kind === "session") {
    return {
      kind: "session",
      source: "recovered",
      session: recovery.session,
      taskId: recovery.recoveredTaskId,
    };
  }
  if (
    recovery.kind === "waiting-user" ||
    recovery.kind === "waiting-external"
  ) {
    return { kind: recovery.kind, task: recovery.task };
  }
  return null;
}

export async function orchestrateSayuriProjectWork(
  input: OrchestrateSayuriProjectWorkInput,
): Promise<SayuriProjectWorkOrchestrationResult> {
  const stateStore = input.stateStore ?? new FileSayuriBrainStateStore();
  const taskRegistry = input.taskRegistry ?? new FileSayuriTaskRegistry();
  const goalStore = input.goalStore ?? new FileSayuriGoalStore();

  const recovery = await recoverLatestSayuriSessionForProject({
    projectId: input.projectId,
    scopeRoot: input.scopeRoot,
    modelGateway: input.modelGateway,
    stateStore,
    taskRegistry,
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const recovered = recoveryResult(recovery);
  if (recovered) return recovered;

  const decision = await decideNextSayuriProjectWork({
    projectId: input.projectId,
    goalStore,
    taskRegistry,
    ...(input.taskIdFactory ? { taskIdFactory: input.taskIdFactory } : {}),
  });
  if (decision.kind === "resume-unfinished-task") {
    throw new Error(
      "Project recovery and task registry disagree about unfinished work.",
    );
  }
  if (decision.kind === "idle") {
    return decision;
  }

  const indexedStore = new ProjectIndexedSayuriBrainStateStore({
    inner: stateStore,
    registry: taskRegistry,
    projectId: input.projectId,
    agentId: input.agentId,
    conversationId: input.conversationId,
  });

  const planned = await planAndPersistSayuriTask({
    seed: decision.plannerSeed,
    modelGateway: input.modelGateway,
    stateStore: indexedStore,
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  const linkedGoal = linkTaskToSayuriGoal(
    decision.goal,
    planned.task.id,
    input.now,
  );
  await goalStore.saveGoal(linkedGoal);

  const runningTask = transitionSayuriTask(
    planned.task,
    "running",
    input.now,
  );
  await indexedStore.saveSnapshot(runningTask, planned.plan);

  const session = await bootstrapSayuriPrimarySession({
    projectId: input.projectId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    taskId: runningTask.id,
    scopeRoot: input.scopeRoot,
    modelGateway: input.modelGateway,
    stateStore,
    taskRegistry,
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
  });

  return {
    kind: "session",
    source: "new-goal",
    session,
    taskId: runningTask.id,
    goalId: linkedGoal.id,
  };
}
