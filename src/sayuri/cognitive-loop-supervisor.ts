import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  FileSayuriBackgroundLeaseStore,
  type SayuriBackgroundLeaseStore,
} from "./background-lease";
import { superviseSayuriBackgroundForSession } from "./background-supervisor";
import {
  admitNextSayuriCronIntent,
  FileSayuriCronIntentStore,
  type SayuriCronIntentStore,
} from "./cron-intent";
import { FileSayuriGoalStore, type SayuriGoalStore } from "./goal-manager";
import {
  FileSayuriGoalEvidenceStore,
  type SayuriGoalEvidenceStore,
} from "./goal-success";
import type { ConfigureSayuriModelRuntimeInput } from "./model-runtime";
import type { SayuriPlanStep } from "./planner";
import type { SayuriPrimarySession } from "./session";
import {
  FileSayuriBrainStateStore,
  type SayuriBrainStateStore,
} from "./state-store";
import {
  finalizeSayuriSessionTask,
  type SayuriTaskFinalizationResult,
} from "./task-finalizer";
import { isUnfinishedSayuriTaskStatus } from "./task-lifecycle";
import {
  FileSayuriTaskRegistry,
  type SayuriProjectTaskEntry,
  type SayuriTaskRegistry,
} from "./task-registry";
import {
  orchestrateSayuriProjectWork,
  type SayuriProjectWorkOrchestrationResult,
} from "./work-orchestrator";

export type SayuriCognitiveLoopDecision =
  | {
      kind: "continue";
      session: SayuriPrimarySession;
      taskId: string;
      step: SayuriPlanStep;
    }
  | {
      kind: "finalized";
      result: SayuriTaskFinalizationResult;
    }
  | {
      kind: "waiting-user" | "waiting-external";
      task: SayuriProjectTaskEntry;
    }
  | {
      kind: "background-running";
      taskId: string;
      leaseId: string;
    }
  | {
      kind: "background-blocked";
      taskId: string;
      leaseId: string;
      reason: string;
    }
  | {
      kind: "blocked-plan";
      taskId: string;
      reasons: readonly string[];
    }
  | {
      kind: "conflict";
      taskIds: readonly string[];
    }
  | { kind: "idle"; reason: string };

function activePlanStep(session: SayuriPrimarySession): SayuriPlanStep | null {
  return (
    session.controller.plan.steps.find(
      (step) => step.status === "in-progress",
    ) ?? null
  );
}

function planIsTerminal(session: SayuriPrimarySession): boolean {
  return session.controller.plan.steps.every(
    (step) => step.status === "completed" || step.status === "cancelled",
  );
}

export async function superviseSayuriSession(input: {
  session: SayuriPrimarySession;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  goalStore?: SayuriGoalStore;
  goalEvidenceStore?: SayuriGoalEvidenceStore;
  backgroundLeaseStore?: SayuriBackgroundLeaseStore;
  modelsRuntime?: LocalPiModelsRuntime;
  now?: string;
}): Promise<SayuriCognitiveLoopDecision> {
  let task = input.session.controller.task;

  const background = await superviseSayuriBackgroundForSession({
    session: input.session,
    ...(input.backgroundLeaseStore
      ? { store: input.backgroundLeaseStore }
      : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  if (background.kind === "background-running") {
    return {
      kind: "background-running",
      taskId: task.id,
      leaseId: background.record.id,
    };
  }
  if (background.kind === "background-blocked") {
    return {
      kind: "background-blocked",
      taskId: task.id,
      leaseId: background.record.id,
      reason: background.reason,
    };
  }
  if (background.kind === "handoff-complete") {
    task = input.session.controller.task;
  }

  if (
    (task.status === "checkpointed" || task.status === "verifying") &&
    planIsTerminal(input.session)
  ) {
    return {
      kind: "finalized",
      result: await finalizeSayuriSessionTask({
        session: input.session,
        modelGateway: input.modelGateway,
        ...(input.goalStore ? { goalStore: input.goalStore } : {}),
        ...(input.goalEvidenceStore
          ? { goalEvidenceStore: input.goalEvidenceStore }
          : {}),
        ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
        ...(input.now ? { now: input.now } : {}),
      }),
    };
  }

  const step = activePlanStep(input.session);
  if (task.status === "checkpointed" && step) {
    await input.session.controller.transitionTask(
      "running",
      input.now ?? new Date().toISOString(),
    );
    return {
      kind: "continue",
      session: input.session,
      taskId: task.id,
      step,
    };
  }
  if (task.status === "running" && step) {
    return {
      kind: "continue",
      session: input.session,
      taskId: task.id,
      step,
    };
  }

  const unfinishedSteps = input.session.controller.plan.steps.filter(
    (candidate) =>
      candidate.status !== "completed" && candidate.status !== "cancelled",
  );
  return {
    kind: "blocked-plan",
    taskId: task.id,
    reasons:
      unfinishedSteps.length === 0
        ? [`Task status "${task.status}" is not ready for finalization.`]
        : unfinishedSteps.map(
            (candidate) =>
              `Plan step "${candidate.id}" is "${candidate.status}" and no executable in-progress step is available.`,
          ),
  };
}

function orchestrationDecision(
  result: SayuriProjectWorkOrchestrationResult,
): SayuriCognitiveLoopDecision | null {
  if (result.kind === "waiting-user" || result.kind === "waiting-external") {
    return { kind: result.kind, task: result.task };
  }
  if (result.kind === "idle") return result;
  return null;
}

export async function superviseSayuriProject(input: {
  projectId: string;
  agentId: string;
  conversationId: string;
  scopeRoot: string;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  stateStore?: SayuriBrainStateStore;
  taskRegistry?: SayuriTaskRegistry;
  goalStore?: SayuriGoalStore;
  goalEvidenceStore?: SayuriGoalEvidenceStore;
  backgroundLeaseStore?: SayuriBackgroundLeaseStore;
  cronIntentStore?: SayuriCronIntentStore;
  modelsRuntime?: LocalPiModelsRuntime;
  now?: string;
  taskIdFactory?: () => string;
}): Promise<SayuriCognitiveLoopDecision> {
  const stateStore = input.stateStore ?? new FileSayuriBrainStateStore();
  const taskRegistry = input.taskRegistry ?? new FileSayuriTaskRegistry();
  const goalStore = input.goalStore ?? new FileSayuriGoalStore();
  const goalEvidenceStore =
    input.goalEvidenceStore ?? new FileSayuriGoalEvidenceStore();
  const backgroundLeaseStore =
    input.backgroundLeaseStore ?? new FileSayuriBackgroundLeaseStore();
  const cronIntentStore =
    input.cronIntentStore ?? new FileSayuriCronIntentStore();

  await admitNextSayuriCronIntent({
    projectId: input.projectId,
    intentStore: cronIntentStore,
    goalStore,
    taskRegistry,
    ...(input.now ? { now: input.now } : {}),
  });

  const unfinished = (
    await taskRegistry.listProjectTasks(input.projectId)
  ).filter((task) => isUnfinishedSayuriTaskStatus(task.status));
  if (unfinished.length > 1) {
    return {
      kind: "conflict",
      taskIds: unfinished.map((task) => task.taskId),
    };
  }

  const work = await orchestrateSayuriProjectWork({
    projectId: input.projectId,
    agentId: input.agentId,
    conversationId: input.conversationId,
    scopeRoot: input.scopeRoot,
    modelGateway: input.modelGateway,
    stateStore,
    taskRegistry,
    goalStore,
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.taskIdFactory ? { taskIdFactory: input.taskIdFactory } : {}),
  });
  const terminal = orchestrationDecision(work);
  if (terminal) return terminal;

  if (work.kind !== "session") {
    throw new Error("Unexpected Sayuri work orchestration result.");
  }
  return superviseSayuriSession({
    session: work.session,
    modelGateway: input.modelGateway,
    goalStore,
    goalEvidenceStore,
    backgroundLeaseStore,
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
}
