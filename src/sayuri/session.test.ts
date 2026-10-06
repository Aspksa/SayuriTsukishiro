import { afterEach, describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Backend } from "@/backend";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { getRuntimeContext } from "@/runtime-context";
import { SAYURI_RUNTIME_MODEL_HANDLE } from "./model-gateway";
import {
  bootstrapSayuriPrimarySession,
  sendSayuriSessionMessage,
} from "./session";
import { FileSayuriBrainStateStore } from "./state-store";
import { FileSayuriTaskRegistry } from "./task-registry";

describe("Sayuri primary session bootstrap", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-session-"));
    roots.push(root);
    const providerStorage = join(root, "provider");
    const stateRoot = join(root, "state");
    const scopeRoot = join(root, "workspace");
    await mkdir(scopeRoot, { recursive: true });

    const runtime = new LocalPiModelsRuntime({
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

    return { root, providerStorage, stateRoot, scopeRoot, runtime };
  }

  test("configures model, starts durable task, and sends through the Sayuri turn boundary", async () => {
    const env = await setup();
    const stateStore = new FileSayuriBrainStateStore(env.stateRoot);
    const taskRegistry = new FileSayuriTaskRegistry(env.stateRoot);
    const session = await bootstrapSayuriPrimarySession({
      projectId: "project-main",
      agentId: "sayuri-primary",
      conversationId: "default",
      taskId: "task-primary",
      goal: "Run one controlled primary session",
      scopeRoot: env.scopeRoot,
      stateStore,
      taskRegistry,
      modelsRuntime: env.runtime,
      modelGateway: {
        baseUrl: "https://cloud.example.test/v1",
        apiKey: "cloud-key",
        storageDir: env.providerStorage,
      },
      plan: {
        id: "plan-primary",
        taskId: "task-primary",
        goal: "Run one controlled primary session",
        createdAt: "2026-10-06T09:20:00.000Z",
        steps: [
          {
            id: "read-step",
            title: "Read project context",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
      now: "2026-10-06T09:20:00.000Z",
    });

    expect(session.resumed).toBe(false);
    expect(session.controller.task.status).toBe("running");
    expect(
      (await taskRegistry.getTask("project-main", "task-primary"))?.status,
    ).toBe("running");
    expect((await stateStore.loadSnapshot("task-primary"))?.task.status).toBe(
      "running",
    );

    let observedModelRoute: unknown;
    let requestBody: Record<string, unknown> | undefined;
    const stream = {
      async *[Symbol.asyncIterator]() {},
    } as unknown as Stream<LettaStreamingResponse>;
    const backend = {
      createConversationMessageStream: async (
        _conversationId: string,
        body: Record<string, unknown>,
      ) => {
        observedModelRoute = getRuntimeContext()?.modelRoute;
        requestBody = body;
        return stream;
      },
    } as unknown as Backend;

    await sendSayuriSessionMessage({
      session,
      messages: [{ role: "user", content: "status" }],
      backend,
      options: { skillSources: [] },
    });

    expect(observedModelRoute).toEqual({
      modelHandle: SAYURI_RUNTIME_MODEL_HANDLE,
      providerType: "openai-compatible",
      exact: true,
    });
    expect(requestBody?.override_model).toBe(SAYURI_RUNTIME_MODEL_HANDLE);
  });

  test("resumes durable state without accepting a replacement plan", async () => {
    const env = await setup();
    const stateStore = new FileSayuriBrainStateStore(env.stateRoot);
    const taskRegistry = new FileSayuriTaskRegistry(env.stateRoot);
    const base = {
      projectId: "project-main",
      agentId: "sayuri-primary",
      conversationId: "default",
      taskId: "task-resume",
      scopeRoot: env.scopeRoot,
      stateStore,
      taskRegistry,
      modelsRuntime: env.runtime,
      modelGateway: {
        baseUrl: "https://cloud.example.test/v1",
        apiKey: "cloud-key",
        storageDir: env.providerStorage,
      },
    };

    const first = await bootstrapSayuriPrimarySession({
      ...base,
      goal: "Resume me",
      plan: {
        id: "resume-plan",
        taskId: "task-resume",
        goal: "Resume me",
        createdAt: "2026-10-06T09:21:00.000Z",
        steps: [
          {
            id: "read-step",
            title: "Inspect state",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
      now: "2026-10-06T09:21:00.000Z",
    });
    expect(first.resumed).toBe(false);

    const resumed = await bootstrapSayuriPrimarySession(base);
    expect(resumed.resumed).toBe(true);
    expect(resumed.controller.task.id).toBe("task-resume");

    await expect(
      bootstrapSayuriPrimarySession({
        ...base,
        plan: {
          id: "replacement",
          taskId: "task-resume",
          goal: "Changed",
          createdAt: "2026-10-06T09:22:00.000Z",
          steps: [
            {
              id: "other",
              title: "Replace",
              status: "pending",
              risk: "read",
              requiresEvidence: false,
            },
          ],
        },
      }),
    ).rejects.toThrow("replace a durable Sayuri plan");
  });
});
