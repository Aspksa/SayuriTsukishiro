import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { FileSayuriGoalStore } from "./goal-manager";
import { FileSayuriBrainStateStore } from "./state-store";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
} from "./task-registry";
import { orchestrateSayuriProjectWork } from "./work-orchestrator";

function sse(content: string): Response {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  return new Response(
    [
      chunk({
        id: "planner-orchestrator",
        object: "chat.completion.chunk",
        created: 1,
        model: "DeepSeek-V4-Flash",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        id: "planner-orchestrator",
        object: "chat.completion.chunk",
        created: 1,
        model: "DeepSeek-V4-Flash",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }),
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("Sayuri Project Work Orchestrator", () => {
  const roots: string[] = [];
  const servers: Array<{ stop(force?: boolean): void }> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup(plannerJson?: string) {
    const root = await mkdtemp(join(tmpdir(), "sayuri-orchestrator-"));
    roots.push(root);
    const stateRoot = join(root, "state");
    const providerStorage = join(root, "provider");
    const scopeRoot = join(root, "workspace");
    await mkdir(scopeRoot, { recursive: true });
    const requests: string[] = [];
    // Discovery and chat streaming use different pi-ai fetch paths.
    // A loopback server prevents any real Cloud.ru request during tests.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "DeepSeek-V4-Flash", object: "model" }],
          });
        }
        if (url.pathname === "/v1/chat/completions" && plannerJson) {
          return sse(plannerJson);
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const runtime = new LocalPiModelsRuntime({ storageDir: providerStorage });
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    return {
      stateStore: new FileSayuriBrainStateStore(stateRoot),
      taskRegistry: new FileSayuriTaskRegistry(stateRoot),
      goalStore: new FileSayuriGoalStore(stateRoot),
      providerStorage,
      scopeRoot,
      runtime,
      requests,
      baseUrl,
    };
  }

  test("creates a plan from the next goal only after unfinished recovery is empty", async () => {
    const taskId = "task-from-goal";
    const env = await setup(
      JSON.stringify({
        taskId,
        goalId: "goal-next",
        steps: [
          {
            id: "inspect",
            title: "Inspect",
            intent: "Read project state",
            toolName: "Read",
          },
        ],
      }),
    );
    await env.goalStore.createGoal({
      id: "goal-next",
      projectId: "project-a",
      title: "Continue brain",
      objective: "Build the next safe brain stage",
      priority: 90,
      successCriteria: ["Plan is durable"],
      createdAt: "2026-10-06T10:30:00.000Z",
    });

    const result = await orchestrateSayuriProjectWork({
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
      scopeRoot: env.scopeRoot,
      stateStore: env.stateStore,
      taskRegistry: env.taskRegistry,
      goalStore: env.goalStore,
      modelsRuntime: env.runtime,
      modelGateway: {
        baseUrl: env.baseUrl,
        apiKey: "cloud-key",
        storageDir: env.providerStorage,
      },
      taskIdFactory: () => taskId,
      now: "2026-10-06T10:30:01.000Z",
    });

    expect(result.kind).toBe("session");
    if (result.kind !== "session") throw new Error("Expected session");
    expect(result.source).toBe("new-goal");
    expect(result.session.controller.task.status).toBe("running");
    expect(
      (await env.goalStore.getGoal("project-a", "goal-next"))?.taskIds,
    ).toEqual([taskId]);
    expect((await env.taskRegistry.getTask("project-a", taskId))?.status).toBe(
      "running",
    );
    expect(env.requests).toContain("/v1/chat/completions");
  });

  test("recovers unfinished work instead of invoking Planner Runtime", async () => {
    const env = await setup();
    const indexed = new ProjectIndexedSayuriBrainStateStore({
      inner: env.stateStore,
      registry: env.taskRegistry,
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
    });
    let task = createSayuriTask({
      id: "existing-task",
      goal: "Continue existing task",
      now: "2026-10-06T10:31:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T10:31:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T10:31:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T10:31:03.000Z");
    await indexed.saveSnapshot(task, {
      id: "existing-plan",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T10:31:00.000Z",
      steps: [
        {
          id: "read-step",
          title: "Read",
          intent: "Continue reading",
          toolName: "Read",
          status: "in-progress",
          risk: "read",
          requiresEvidence: false,
        },
      ],
    });

    const result = await orchestrateSayuriProjectWork({
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
      scopeRoot: env.scopeRoot,
      stateStore: env.stateStore,
      taskRegistry: env.taskRegistry,
      goalStore: env.goalStore,
      modelsRuntime: env.runtime,
      modelGateway: {
        baseUrl: env.baseUrl,
        apiKey: "cloud-key",
        storageDir: env.providerStorage,
      },
    });

    expect(result.kind).toBe("session");
    if (result.kind !== "session") throw new Error("Expected session");
    expect(result.source).toBe("recovered");
    expect(result.taskId).toBe("existing-task");
    expect(env.requests).not.toContain("/v1/chat/completions");
  });

  test("returns idle when there is no unfinished task and no eligible goal", async () => {
    const env = await setup();
    const result = await orchestrateSayuriProjectWork({
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
      scopeRoot: env.scopeRoot,
      stateStore: env.stateStore,
      taskRegistry: env.taskRegistry,
      goalStore: env.goalStore,
      modelsRuntime: env.runtime,
      modelGateway: {
        baseUrl: env.baseUrl,
        apiKey: "cloud-key",
        storageDir: env.providerStorage,
      },
    });
    expect(result.kind).toBe("idle");
  });
});
