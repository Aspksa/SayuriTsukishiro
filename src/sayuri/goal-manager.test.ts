import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseNextEligibleSayuriGoal,
  decideNextSayuriProjectWork,
  FileSayuriGoalStore,
  linkTaskToSayuriGoal,
  transitionSayuriGoal,
} from "./goal-manager";
import { FileSayuriTaskRegistry } from "./task-registry";

describe("Sayuri Goal Manager", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function stores() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-goals-"));
    roots.push(root);
    return {
      goals: new FileSayuriGoalStore(root),
      tasks: new FileSayuriTaskRegistry(root),
    };
  }

  test("unfinished project work always wins over creation of a new goal task", async () => {
    const { goals, tasks } = await stores();
    await goals.createGoal({
      id: "goal-new",
      projectId: "project-a",
      title: "New work",
      objective: "Create something new",
      priority: 100,
      createdAt: "2026-10-06T10:00:00.000Z",
    });
    await tasks.upsertTask({
      projectId: "project-a",
      taskId: "task-existing",
      planId: "plan-existing",
      agentId: "sayuri-primary",
      conversationId: "default",
      goal: "Continue existing work",
      status: "checkpointed",
      revision: 5,
      updatedAt: "2026-10-06T10:01:00.000Z",
      checkpointCount: 1,
      nextAction: "Continue existing task",
    });

    const decision = await decideNextSayuriProjectWork({
      projectId: "project-a",
      goalStore: goals,
      taskRegistry: tasks,
      taskIdFactory: () => "task-new",
    });

    expect(decision.kind).toBe("resume-unfinished-task");
    if (decision.kind !== "resume-unfinished-task") {
      throw new Error("Expected unfinished task");
    }
    expect(decision.task.taskId).toBe("task-existing");
  });

  test("selects the highest-priority active goal whose dependencies are complete", async () => {
    const { goals, tasks } = await stores();
    let prerequisite = await goals.createGoal({
      id: "goal-prerequisite",
      projectId: "project-a",
      title: "Foundation",
      objective: "Finish foundation",
      priority: 20,
      createdAt: "2026-10-06T10:00:00.000Z",
    });
    await goals.createGoal({
      id: "goal-dependent",
      projectId: "project-a",
      title: "Dependent",
      objective: "Build on foundation",
      priority: 100,
      dependsOnGoalIds: ["goal-prerequisite"],
      constraints: ["Do not bypass Action Broker"],
      successCriteria: ["Tests pass"],
      createdAt: "2026-10-06T10:00:01.000Z",
    });
    await goals.createGoal({
      id: "goal-independent",
      projectId: "project-a",
      title: "Independent",
      objective: "Do independent work",
      priority: 50,
      createdAt: "2026-10-06T10:00:02.000Z",
    });

    expect((await chooseNextEligibleSayuriGoal(goals, "project-a"))?.id).toBe(
      "goal-independent",
    );

    prerequisite = transitionSayuriGoal(prerequisite, "completed", {
      now: "2026-10-06T10:01:00.000Z",
    });
    await goals.saveGoal(prerequisite);

    const decision = await decideNextSayuriProjectWork({
      projectId: "project-a",
      goalStore: goals,
      taskRegistry: tasks,
      taskIdFactory: () => "task-from-goal",
    });
    expect(decision.kind).toBe("create-task");
    if (decision.kind !== "create-task") throw new Error("Expected new task");
    expect(decision.goal.id).toBe("goal-dependent");
    expect(decision.plannerSeed).toEqual({
      taskId: "task-from-goal",
      projectId: "project-a",
      goalId: "goal-dependent",
      goal: "Build on foundation",
      constraints: ["Do not bypass Action Broker"],
      successCriteria: ["Tests pass"],
    });
  });

  test("links task ids to a goal without duplicate links", async () => {
    const { goals } = await stores();
    let goal = await goals.createGoal({
      id: "goal-link",
      projectId: "project-a",
      title: "Linked work",
      objective: "Track its tasks",
      createdAt: "2026-10-06T10:00:00.000Z",
    });
    goal = linkTaskToSayuriGoal(goal, "task-1", "2026-10-06T10:00:01.000Z");
    goal = linkTaskToSayuriGoal(goal, "task-1", "2026-10-06T10:00:02.000Z");
    await goals.saveGoal(goal);
    expect((await goals.getGoal("project-a", "goal-link"))?.taskIds).toEqual([
      "task-1",
    ]);
  });
});
