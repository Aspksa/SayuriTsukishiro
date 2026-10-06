import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSayuriExecutionController } from "./execution-control";
import type { SayuriPrimarySession } from "./session";
import { FileSayuriBrainStateStore } from "./state-store";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
} from "./task-registry";
import {
  checkpointSayuriTask,
  createSayuriTask,
  transitionSayuriTask,
} from "./task-lifecycle";
import {
  superviseSayuriProject,
  superviseSayuriSession,
} from "./cognitive-loop-supervisor";

describe("Sayuri Cognitive Loop Supervisor", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  test("turns a verified checkpoint with an unlocked step back into running work", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayuri-supervisor-"));
    roots.push(root);
    const stateStore = new FileSayuriBrainStateStore(root);
    const taskRegistry = new FileSayuriTaskRegistry(root);
    const indexed = new ProjectIndexedSayuriBrainStateStore({
      inner: stateStore,
      registry: taskRegistry,
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
    });

    let task = createSayuriTask({
      id: "task-loop",
      goal: "Continue deterministic work",
      now: "2026-10-06T11:20:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T11:20:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T11:20:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T11:20:03.000Z");
    task = checkpointSayuriTask(task, {
      id: "checkpoint-1",
      createdAt: "2026-10-06T11:20:04.000Z",
      summary: "First step verified.",
      nextAction: "Continue with second step.",
      verifiedReceiptIds: [],
    });
    const plan = {
      id: "plan-loop",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T11:20:00.000Z",
      steps: [
        {
          id: "first",
          title: "First",
          status: "completed" as const,
          risk: "read" as const,
          requiresEvidence: false,
        },
        {
          id: "second",
          title: "Second",
          intent: "Read the next project artifact",
          toolName: "Read",
          status: "in-progress" as const,
          risk: "read" as const,
          requiresEvidence: false,
          dependsOnStepIds: ["first"],
        },
      ],
    };
    await indexed.saveSnapshot(task, plan);
    const controller = createSayuriExecutionController({
      task,
      plan,
      scopeRoot: join(root, "workspace"),
      stateStore: indexed,
    });
    const session = {
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
      controller,
      stateStore: indexed,
      taskRegistry,
      modelRuntime: {} as never,
      resumed: true,
    } satisfies SayuriPrimarySession;

    const result = await superviseSayuriSession({
      session,
      modelGateway: {
        baseUrl: "https://unused.example.test/v1",
        apiKey: "unused",
      },
      now: "2026-10-06T11:20:05.000Z",
    });

    expect(result.kind).toBe("continue");
    if (result.kind !== "continue") throw new Error("Expected continue");
    expect(result.step.id).toBe("second");
    expect(result.session.controller.task.status).toBe("running");
    expect(
      (await taskRegistry.getTask("project-a", task.id))?.status,
    ).toBe("running");
  });

  test("refuses to choose between multiple unfinished project tasks", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayuri-supervisor-conflict-"));
    roots.push(root);
    const registry = new FileSayuriTaskRegistry(root);
    for (const [taskId, status] of [
      ["task-a", "running"],
      ["task-b", "waiting-user"],
    ] as const) {
      await registry.upsertTask({
        projectId: "project-a",
        taskId,
        planId: `plan-${taskId}`,
        agentId: "sayuri-primary",
        conversationId: "default",
        goal: "Conflicting work",
        status,
        revision: 1,
        updatedAt: "2026-10-06T11:21:00.000Z",
        checkpointCount: 0,
      });
    }

    const result = await superviseSayuriProject({
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
      scopeRoot: join(root, "workspace"),
      taskRegistry: registry,
      stateStore: new FileSayuriBrainStateStore(root),
      modelGateway: {
        baseUrl: "https://unused.example.test/v1",
        apiKey: "unused",
      },
    });

    expect(result.kind).toBe("conflict");
    if (result.kind !== "conflict") throw new Error("Expected conflict");
    expect(new Set(result.taskIds)).toEqual(new Set(["task-a", "task-b"]));
  });
});
