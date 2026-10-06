import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  completeSayuriGoalIfVerified,
  evaluateSayuriGoalSuccess,
  FileSayuriGoalEvidenceStore,
  type SayuriGoalEvidenceStore,
} from "./goal-success";
import {
  FileSayuriGoalStore,
  transitionSayuriGoal,
  type SayuriGoalStore,
  type SayuriProjectGoal,
} from "./goal-manager";
import type { ConfigureSayuriModelRuntimeInput } from "./model-runtime";
import type { SayuriPrimarySession } from "./session";
import {
  orchestrateSayuriProjectWork,
  type SayuriProjectWorkOrchestrationResult,
} from "./work-orchestrator";

export type SayuriTaskFinalizationResult =
  | {
      kind: "finalized";
      taskId: string;
      goal: "completed" | "none";
      goalId?: string;
      nextWork?: SayuriProjectWorkOrchestrationResult;
    }
  | {
      kind: "waiting-goal-evidence";
      taskId: string;
      goalId: string;
      reasons: readonly string[];
    }
  | {
      kind: "goal-still-active";
      taskId: string;
      goalId: string;
      reasons: readonly string[];
      nextWork?: SayuriProjectWorkOrchestrationResult;
    };

async function linkedGoalForTask(input: {
  projectId: string;
  taskId: string;
  goalStore: SayuriGoalStore;
}): Promise<SayuriProjectGoal | null> {
  const matches = (await input.goalStore.listGoals(input.projectId)).filter(
    (goal) => goal.taskIds.includes(input.taskId),
  );
  if (matches.length > 1) {
    throw new Error(
      `Task "${input.taskId}" is linked to multiple long-term goals.`,
    );
  }
  return matches[0] ?? null;
}

function onlyCriterionReasons(reasons: readonly string[]): boolean {
  return (
    reasons.length > 0 &&
    reasons.every((reason) => reason.startsWith("Success criterion is not confirmed:"))
  );
}

export async function finalizeSayuriSessionTask(input: {
  session: SayuriPrimarySession;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  goalStore?: SayuriGoalStore;
  goalEvidenceStore?: SayuriGoalEvidenceStore;
  modelsRuntime?: LocalPiModelsRuntime;
  continueWork?: boolean;
  now?: string;
}): Promise<SayuriTaskFinalizationResult> {
  const completedTask = await input.session.controller.completeTaskIfReady(
    input.now,
  );
  const taskId = completedTask.id;

  const registryEntry = await input.session.taskRegistry.getTask(
    input.session.projectId,
    taskId,
  );
  if (!registryEntry || registryEntry.status !== "completed") {
    throw new Error(
      "Completed Sayuri task was not durably reflected in the project registry.",
    );
  }

  const goalStore = input.goalStore ?? new FileSayuriGoalStore();
  const goalEvidenceStore =
    input.goalEvidenceStore ?? new FileSayuriGoalEvidenceStore();
  const goal = await linkedGoalForTask({
    projectId: input.session.projectId,
    taskId,
    goalStore,
  });

  let goalState: "completed" | "none" | "active" = "none";
  let goalId: string | undefined;
  let pendingReasons: readonly string[] = [];

  if (goal) {
    goalId = goal.id;
    const evaluation = await evaluateSayuriGoalSuccess({
      goal,
      taskRegistry: input.session.taskRegistry,
      evidenceStore: goalEvidenceStore,
    });
    if (evaluation.ready) {
      await completeSayuriGoalIfVerified({
        projectId: input.session.projectId,
        goalId: goal.id,
        goalStore,
        taskRegistry: input.session.taskRegistry,
        evidenceStore: goalEvidenceStore,
        now: input.now,
      });
      goalState = "completed";
    } else if (onlyCriterionReasons(evaluation.reasons)) {
      if (goal.status === "active") {
        const blocked = transitionSayuriGoal(goal, "blocked", {
          now: input.now,
          blockedReason: `Awaiting success-criteria evidence: ${evaluation.reasons.join(" ")}`,
        });
        await goalStore.saveGoal(blocked);
      }
      return {
        kind: "waiting-goal-evidence",
        taskId,
        goalId: goal.id,
        reasons: evaluation.reasons,
      };
    } else {
      goalState = "active";
      pendingReasons = evaluation.reasons;
    }
  }

  const shouldContinue = input.continueWork ?? true;
  const nextWork = shouldContinue
    ? await orchestrateSayuriProjectWork({
        projectId: input.session.projectId,
        agentId: input.session.agentId,
        conversationId: input.session.conversationId,
        scopeRoot: input.session.controller.scopeRoot,
        modelGateway: input.modelGateway,
        stateStore: input.session.stateStore,
        taskRegistry: input.session.taskRegistry,
        goalStore,
        ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
        ...(input.now ? { now: input.now } : {}),
      })
    : undefined;

  if (goalState === "active" && goalId) {
    return {
      kind: "goal-still-active",
      taskId,
      goalId,
      reasons: pendingReasons,
      ...(nextWork ? { nextWork } : {}),
    };
  }

  return {
    kind: "finalized",
    taskId,
    goal: goalState,
    ...(goalId ? { goalId } : {}),
    ...(nextWork ? { nextWork } : {}),
  };
}
