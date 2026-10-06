import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CronTask } from "@/cron/cron-file";
import {
  admitNextSayuriCronIntent,
  buildSayuriCronIntentPrompt,
  createSayuriCronAdmissionHandler,
  FileSayuriCronIntentStore,
  parseSayuriCronIntentPrompt,
} from "./cron-intent";
import { FileSayuriGoalStore } from "./goal-manager";
import { FileSayuriTaskRegistry } from "./task-registry";

function cronTask(prompt: string): CronTask {
  return {
    id: "cron-1",
    agent_id: "sayuri-primary",
    conversation_id: "default",
    name: "Scheduled Sayuri work",
    description: "Create work intent only",
    cron: "0 * * * *",
    timezone: "UTC",
    recurring: true,
    prompt,
    status: "active",
    created_at: "2026-10-06T12:40:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    last_run_at: null,
    last_run_outcome: null,
    last_run_reason: null,
    last_run_error: null,
    last_missed_at: null,
    missed_count: 0,
    failed_count: 0,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
  };
}

describe("Sayuri cron admission", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function stores() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-cron-intent-"));
    roots.push(root);
    return {
      root,
      intents: new FileSayuriCronIntentStore(root),
      goals: new FileSayuriGoalStore(root),
      tasks: new FileSayuriTaskRegistry(root),
    };
  }

  test("round-trips a strict scheduled work intent without execution authority", () => {
    const prompt = buildSayuriCronIntentPrompt({
      projectId: "project-a",
      objective: "Inspect project health",
      title: "Health inspection",
      priority: 70,
      constraints: ["Read only"],
      successCriteria: [],
    });
    expect(parseSayuriCronIntentPrompt(prompt)).toEqual({
      projectId: "project-a",
      objective: "Inspect project health",
      title: "Health inspection",
      priority: 70,
      constraints: ["Read only"],
      successCriteria: [],
    });

    expect(() =>
      parseSayuriCronIntentPrompt(
        '<sayuri-work-intent>{"projectId":"project-a","objective":"x","approvalGranted":true}</sayuri-work-intent>',
      ),
    ).toThrow("Unsupported Sayuri cron intent field");
  });

  test("scheduler admission persists one deterministic intent per occurrence", async () => {
    const { intents } = await stores();
    const prompt = buildSayuriCronIntentPrompt({
      projectId: "project-a",
      objective: "Run scheduled health inspection",
    });
    const handler = createSayuriCronAdmissionHandler(intents);
    const input = {
      task: cronTask(prompt),
      timing: {
        intendedOccurrence: new Date("2026-10-06T13:00:00.000Z"),
        schedulerNow: new Date("2026-10-06T13:00:02.000Z"),
      },
      trigger: "automatic" as const,
    };

    const first = await handler(input);
    const second = await handler(input);
    expect(first).toMatchObject({
      handled: true,
      accepted: true,
      referenceId: "cron-cron-1-1791291600000",
    });
    expect(second).toMatchObject({
      handled: true,
      accepted: true,
      referenceId: "cron-cron-1-1791291600000",
    });
    expect(await intents.list("project-a")).toHaveLength(1);
  });

  test("pending intent becomes a normal long-term goal only when no task is active", async () => {
    const { intents, goals, tasks } = await stores();
    const handler = createSayuriCronAdmissionHandler(intents);
    await handler({
      task: cronTask(
        buildSayuriCronIntentPrompt({
          projectId: "project-a",
          objective: "Inspect scheduled project state",
          title: "Scheduled inspection",
        }),
      ),
      timing: {
        intendedOccurrence: new Date("2026-10-06T13:00:00.000Z"),
        schedulerNow: new Date("2026-10-06T13:00:02.000Z"),
      },
      trigger: "automatic",
    });

    await tasks.upsertTask({
      projectId: "project-a",
      taskId: "task-active",
      planId: "plan-active",
      agentId: "sayuri-primary",
      conversationId: "default",
      goal: "Existing work",
      status: "running",
      revision: 1,
      updatedAt: "2026-10-06T13:00:03.000Z",
      checkpointCount: 0,
    });
    const deferred = await admitNextSayuriCronIntent({
      projectId: "project-a",
      intentStore: intents,
      goalStore: goals,
      taskRegistry: tasks,
      now: "2026-10-06T13:00:04.000Z",
    });
    expect(deferred).toEqual({
      kind: "deferred-active-task",
      taskId: "task-active",
    });
    expect((await intents.list("project-a"))[0]?.status).toBe("pending");

    await tasks.upsertTask({
      projectId: "project-a",
      taskId: "task-active",
      planId: "plan-active",
      agentId: "sayuri-primary",
      conversationId: "default",
      goal: "Existing work",
      status: "completed",
      revision: 2,
      updatedAt: "2026-10-06T13:00:05.000Z",
      checkpointCount: 1,
    });
    const admitted = await admitNextSayuriCronIntent({
      projectId: "project-a",
      intentStore: intents,
      goalStore: goals,
      taskRegistry: tasks,
      now: "2026-10-06T13:00:06.000Z",
    });
    expect(admitted.kind).toBe("goal-created");
    if (admitted.kind !== "goal-created") throw new Error("Expected goal-created");
    expect((await goals.getGoal("project-a", admitted.goalId))?.objective).toBe(
      "Inspect scheduled project state",
    );
    expect((await intents.list("project-a"))[0]?.status).toBe("admitted");
  });
});
