import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSayuriBackgroundLeaseStore } from "./background-lease";
import {
  cancelSayuriControlTarget,
  confirmSayuriWaitingTask,
  getSayuriCognitiveControlSnapshot,
} from "./control-plane";
import {
  FileSayuriCronIntentStore,
  type SayuriCronWorkIntent,
} from "./cron-intent";
import type { SayuriPlan } from "./planner";
import { FileSayuriBrainStateStore } from "./state-store";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
} from "./task-registry";

let root = "";

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "sayuri-control-plane-"));
  const stateStore = new FileSayuriBrainStateStore(root);
  const taskRegistry = new FileSayuriTaskRegistry(root);
  const backgroundStore = new FileSayuriBackgroundLeaseStore(root);
  const cronIntentStore = new FileSayuriCronIntentStore(root);
  const indexed = new ProjectIndexedSayuriBrainStateStore({
    inner: stateStore,
    registry: taskRegistry,
    projectId: "project-1",
    agentId: "agent-1",
    conversationId: "conversation-1",
  });
  const now = "2026-10-07T00:00:00.000Z";
  let task = createSayuriTask({ id: "task-1", goal: "Test control", now });
  task = transitionSayuriTask(task, "planning", now);
  task = transitionSayuriTask(task, "waiting-user", now);
  const plan: SayuriPlan = {
    id: "plan-1",
    taskId: task.id,
    goal: task.goal,
    createdAt: now,
    steps: [
      {
        id: "step-1",
        title: "Continue after confirmation",
        status: "in-progress",
        risk: "read",
        requiresEvidence: false,
      },
    ],
  };
  await indexed.saveSnapshot(task, plan);
  return {
    stateStore,
    taskRegistry,
    backgroundStore,
    cronIntentStore,
    task,
  };
}

describe("Sayuri cognitive control plane", () => {
  test("exposes read-only task and plan state then confirms with revision guard", async () => {
    const ctx = await fixture();
    const snapshot = await getSayuriCognitiveControlSnapshot({
      projectId: "project-1",
      ...ctx,
    });
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.selectedTask?.task.status).toBe("waiting-user");
    expect(snapshot.selectedTask?.plan.id).toBe("plan-1");

    const confirmed = await confirmSayuriWaitingTask({
      projectId: "project-1",
      taskId: "task-1",
      expectedRevision: ctx.task.revision,
      now: "2026-10-07T00:00:01.000Z",
      ...ctx,
    });
    expect(confirmed.status).toBe("running");

    await expect(
      confirmSayuriWaitingTask({
        projectId: "project-1",
        taskId: "task-1",
        expectedRevision: ctx.task.revision,
        ...ctx,
      }),
    ).rejects.toThrow("Stale Sayuri task revision");
  });

  test("cancels a task through lifecycle rules and keeps the registry synchronized", async () => {
    const ctx = await fixture();
    const confirmed = await confirmSayuriWaitingTask({
      projectId: "project-1",
      taskId: "task-1",
      expectedRevision: ctx.task.revision,
      now: "2026-10-07T00:00:01.000Z",
      ...ctx,
    });
    const result = await cancelSayuriControlTarget({
      kind: "task",
      projectId: "project-1",
      taskId: "task-1",
      expectedRevision: confirmed.revision,
      now: "2026-10-07T00:00:02.000Z",
      ...ctx,
    });
    expect(result.kind).toBe("task");
    if (result.kind !== "task") throw new Error("Expected task result");
    expect(result.task.status).toBe("cancelled");
    expect(
      (await ctx.taskRegistry.getTask("project-1", "task-1"))?.status,
    ).toBe("cancelled");
  });

  test("only pending cron intents can be cancelled", async () => {
    const ctx = await fixture();
    const intent: SayuriCronWorkIntent = {
      id: "intent-1",
      projectId: "project-1",
      sourceCronTaskId: "cron-1",
      sourceAgentId: "agent-1",
      sourceConversationId: "conversation-1",
      intendedOccurrence: "2026-10-08T00:00:00.000Z",
      objective: "Scheduled objective",
      title: "Scheduled work",
      priority: 50,
      constraints: [],
      successCriteria: [],
      status: "pending",
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    await ctx.cronIntentStore.save(intent);
    const result = await cancelSayuriControlTarget({
      kind: "cron-intent",
      projectId: "project-1",
      intentId: "intent-1",
      now: "2026-10-07T00:00:03.000Z",
      ...ctx,
    });
    expect(result.kind).toBe("cron-intent");
    if (result.kind !== "cron-intent") throw new Error("Expected cron result");
    expect(result.cronIntent.status).toBe("cancelled");
  });
});
