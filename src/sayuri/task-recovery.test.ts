import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { FileSayuriBrainStateStore } from "./state-store";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";
import {
  recoverLatestSayuriSessionForProject,
  releaseWaitingSayuriTask,
} from "./task-recovery";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
} from "./task-registry";

describe("Sayuri unfinished task recovery", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function environment() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-recovery-"));
    roots.push(root);
    const stateStore = new FileSayuriBrainStateStore(join(root, "state"));
    const taskRegistry = new FileSayuriTaskRegistry(join(root, "state"));
    const scopeRoot = join(root, "workspace");
    const providerStorage = join(root, "provider");
    await mkdir(scopeRoot, { recursive: true });
    const modelsRuntime = new LocalPiModelsRuntime({
      storageDir: providerStorage,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "DeepSeek-V4-Flash", object: "model" }],
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });
    return {
      stateStore,
      taskRegistry,
      scopeRoot,
      providerStorage,
      modelsRuntime,
    };
  }

  test("waiting-user is surfaced without automatically resuming execution", async () => {
    const env = await environment();
    const store = new ProjectIndexedSayuriBrainStateStore({
      inner: env.stateStore,
      registry: env.taskRegistry,
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
    });
    let task = createSayuriTask({
      id: "waiting-task",
      goal: "Wait for the user",
      now: "2026-10-06T09:40:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T09:40:01.000Z");
    task = transitionSayuriTask(
      task,
      "waiting-user",
      "2026-10-06T09:40:02.000Z",
    );
    await store.saveSnapshot(task, {
      id: "waiting-plan",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T09:40:00.000Z",
      steps: [
        {
          id: "ask-step",
          title: "Wait for confirmation",
          status: "blocked",
          risk: "read",
          requiresEvidence: false,
        },
      ],
    });

    const result = await recoverLatestSayuriSessionForProject({
      projectId: "project-a",
      scopeRoot: env.scopeRoot,
      stateStore: env.stateStore,
      taskRegistry: env.taskRegistry,
      modelGateway: {
        baseUrl: "https://unused.example.test/v1",
        apiKey: "unused",
        storageDir: env.providerStorage,
      },
      modelsRuntime: env.modelsRuntime,
    });

    expect(result.kind).toBe("waiting-user");
    expect((await env.stateStore.loadSnapshot(task.id))?.task.status).toBe(
      "waiting-user",
    );

    const released = await releaseWaitingSayuriTask({
      projectId: "project-a",
      taskId: task.id,
      trigger: "user-confirmed",
      stateStore: env.stateStore,
      taskRegistry: env.taskRegistry,
      now: "2026-10-06T09:40:03.000Z",
    });
    expect(released.status).toBe("running");
  });

  test("ready work advances through an explicit transition and resumes a primary session", async () => {
    const env = await environment();
    const store = new ProjectIndexedSayuriBrainStateStore({
      inner: env.stateStore,
      registry: env.taskRegistry,
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
    });
    let task = createSayuriTask({
      id: "ready-task",
      goal: "Recover work",
      now: "2026-10-06T09:41:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T09:41:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T09:41:02.000Z");
    await store.saveSnapshot(task, {
      id: "ready-plan",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T09:41:00.000Z",
      steps: [
        {
          id: "read-step",
          title: "Resume project inspection",
          status: "pending",
          risk: "read",
          requiresEvidence: false,
        },
      ],
    });

    const result = await recoverLatestSayuriSessionForProject({
      projectId: "project-a",
      scopeRoot: env.scopeRoot,
      stateStore: env.stateStore,
      taskRegistry: env.taskRegistry,
      modelsRuntime: env.modelsRuntime,
      modelGateway: {
        baseUrl: "https://cloud.example.test/v1",
        apiKey: "cloud-key",
        storageDir: env.providerStorage,
      },
      now: "2026-10-06T09:41:03.000Z",
    });

    expect(result.kind).toBe("session");
    if (result.kind !== "session")
      throw new Error("Expected recovered session");
    expect(result.session.controller.task.status).toBe("running");
    expect(result.session.resumed).toBe(true);
    expect(
      (await env.taskRegistry.getTask("project-a", "ready-task"))?.status,
    ).toBe("running");
  });
});
