import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeSayuriGoalIfVerified,
  evaluateSayuriGoalSuccess,
  FileSayuriGoalEvidenceStore,
} from "./goal-success";
import { FileSayuriGoalStore } from "./goal-manager";
import { FileSayuriTaskRegistry } from "./task-registry";

describe("Sayuri Goal Success Verification", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function stores() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-goal-success-"));
    roots.push(root);
    return {
      goals: new FileSayuriGoalStore(root),
      tasks: new FileSayuriTaskRegistry(root),
      evidence: new FileSayuriGoalEvidenceStore(root),
    };
  }

  test("requires all linked tasks completed and every success criterion confirmed", async () => {
    const { goals, tasks, evidence } = await stores();
    let goal = await goals.createGoal({
      id: "goal-success",
      projectId: "project-a",
      title: "Verified goal",
      objective: "Finish verified work",
      successCriteria: ["Tests pass", "User accepts result"],
      createdAt: "2026-10-06T11:00:00.000Z",
    });
    goal = {
      ...goal,
      taskIds: ["task-complete"],
      updatedAt: "2026-10-06T11:00:01.000Z",
    };
    await goals.saveGoal(goal);
    await tasks.upsertTask({
      projectId: "project-a",
      taskId: "task-complete",
      planId: "plan-complete",
      agentId: "sayuri-primary",
      conversationId: "default",
      goal: "Finish verified work",
      status: "completed",
      revision: 10,
      updatedAt: "2026-10-06T11:00:02.000Z",
      checkpointCount: 2,
    });

    let evaluation = await evaluateSayuriGoalSuccess({
      goal,
      taskRegistry: tasks,
      evidenceStore: evidence,
    });
    expect(evaluation.ready).toBe(false);
    expect(evaluation.reasons.join("\n")).toContain("Tests pass");

    await evidence.appendUserConfirmation({
      projectId: "project-a",
      goalId: goal.id,
      criterion: "Tests pass",
      createdAt: "2026-10-06T11:00:03.000Z",
    });
    await evidence.appendUserConfirmation({
      projectId: "project-a",
      goalId: goal.id,
      criterion: "User accepts result",
      createdAt: "2026-10-06T11:00:04.000Z",
    });

    evaluation = await evaluateSayuriGoalSuccess({
      goal,
      taskRegistry: tasks,
      evidenceStore: evidence,
    });
    expect(evaluation.ready).toBe(true);
    expect(evaluation.confirmedCriteria).toEqual([
      "Tests pass",
      "User accepts result",
    ]);

    const completed = await completeSayuriGoalIfVerified({
      projectId: "project-a",
      goalId: goal.id,
      goalStore: goals,
      taskRegistry: tasks,
      evidenceStore: evidence,
      now: "2026-10-06T11:00:05.000Z",
    });
    expect(completed.status).toBe("completed");
  });

  test("never completes a goal while a linked task is not completed", async () => {
    const { goals, tasks, evidence } = await stores();
    let goal = await goals.createGoal({
      id: "goal-blocked-by-task",
      projectId: "project-a",
      title: "Wait for task",
      objective: "Do not finish early",
      createdAt: "2026-10-06T11:01:00.000Z",
    });
    goal = {
      ...goal,
      taskIds: ["task-running"],
      updatedAt: "2026-10-06T11:01:01.000Z",
    };
    await goals.saveGoal(goal);
    await tasks.upsertTask({
      projectId: "project-a",
      taskId: "task-running",
      planId: "plan-running",
      agentId: "sayuri-primary",
      conversationId: "default",
      goal: goal.objective,
      status: "running",
      revision: 3,
      updatedAt: "2026-10-06T11:01:02.000Z",
      checkpointCount: 0,
    });

    await expect(
      completeSayuriGoalIfVerified({
        projectId: "project-a",
        goalId: goal.id,
        goalStore: goals,
        taskRegistry: tasks,
        evidenceStore: evidence,
      }),
    ).rejects.toThrow("Goal Success Gate rejected");
    expect((await goals.getGoal("project-a", goal.id))?.status).toBe("active");
  });

  test("allows a later completed retry to satisfy a goal after a failed attempt", async () => {
    const { goals, tasks, evidence } = await stores();
    let goal = await goals.createGoal({
      id: "goal-retry",
      projectId: "project-a",
      title: "Retry goal",
      objective: "Eventually complete safely",
      createdAt: "2026-10-06T11:01:30.000Z",
    });
    goal = {
      ...goal,
      taskIds: ["task-failed", "task-retry"],
      updatedAt: "2026-10-06T11:01:31.000Z",
    };
    await goals.saveGoal(goal);
    for (const [taskId, status] of [
      ["task-failed", "failed"],
      ["task-retry", "completed"],
    ] as const) {
      await tasks.upsertTask({
        projectId: "project-a",
        taskId,
        planId: `plan-${taskId}`,
        agentId: "sayuri-primary",
        conversationId: "default",
        goal: goal.objective,
        status,
        revision: 4,
        updatedAt: "2026-10-06T11:01:32.000Z",
        checkpointCount: 1,
      });
    }

    const evaluation = await evaluateSayuriGoalSuccess({
      goal,
      taskRegistry: tasks,
      evidenceStore: evidence,
    });
    expect(evaluation.ready).toBe(true);
  });

  test("a goal with no textual criteria still requires a completed linked task", async () => {
    const { goals, tasks, evidence } = await stores();
    let goal = await goals.createGoal({
      id: "goal-task-only",
      projectId: "project-a",
      title: "Task-only goal",
      objective: "Finish the linked task",
      createdAt: "2026-10-06T11:02:00.000Z",
    });
    goal = {
      ...goal,
      taskIds: ["task-done"],
      updatedAt: "2026-10-06T11:02:01.000Z",
    };
    await goals.saveGoal(goal);
    await tasks.upsertTask({
      projectId: "project-a",
      taskId: "task-done",
      planId: "plan-done",
      agentId: "sayuri-primary",
      conversationId: "default",
      goal: goal.objective,
      status: "completed",
      revision: 4,
      updatedAt: "2026-10-06T11:02:02.000Z",
      checkpointCount: 1,
    });

    const completed = await completeSayuriGoalIfVerified({
      projectId: "project-a",
      goalId: goal.id,
      goalStore: goals,
      taskRegistry: tasks,
      evidenceStore: evidence,
    });
    expect(completed.status).toBe("completed");
  });
});
