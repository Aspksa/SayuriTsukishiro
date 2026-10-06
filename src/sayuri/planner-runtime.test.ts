import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import type { SayuriPlannerSeed } from "./goal-manager";
import {
  planAndPersistSayuriTask,
  requestSayuriPlannerV1Proposal,
} from "./planner-runtime";
import { FileSayuriBrainStateStore } from "./state-store";

function ssePlannerResponse(content: string): Response {
  const chunk = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
  return new Response(
    [
      chunk({
        id: "planner-test",
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
        id: "planner-test",
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

describe("Sayuri Planner runtime", () => {
  const roots: string[] = [];
  const servers: Array<{ stop(force?: boolean): void }> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup(responseText: string) {
    const root = await mkdtemp(join(tmpdir(), "sayuri-planner-runtime-"));
    roots.push(root);
    const providerStorage = join(root, "provider");
    const stateStore = new FileSayuriBrainStateStore(join(root, "state"));
    const requests: string[] = [];
    // Use a real loopback HTTP server for both model discovery and streaming.
    // Pi-AI's stream transport uses fetch independently of catalog discovery;
    // injecting fetchImpl alone does not mock a chat completion.
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
        if (url.pathname === "/v1/chat/completions") {
          return ssePlannerResponse(responseText);
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);
    const runtime = new LocalPiModelsRuntime({ storageDir: providerStorage });
    const baseUrl = `http://127.0.0.1:${server.port}/v1`;
    return { providerStorage, stateStore, runtime, requests, baseUrl };
  }

  const seed: SayuriPlannerSeed = {
    taskId: "planner-runtime-task",
    projectId: "project-main",
    goalId: "goal-main",
    goal: "Implement the next safe stage",
    constraints: ["Do not bypass Action Broker"],
    successCriteria: ["Persist a validated plan"],
  };

  test("calls the exact DeepSeek route and persists only the compiled ready plan", async () => {
    const env = await setup(
      JSON.stringify({
        taskId: seed.taskId,
        goalId: seed.goalId,
        steps: [
          {
            id: "inspect",
            title: "Inspect",
            intent: "Read project state",
            toolName: "Read",
          },
          {
            id: "change",
            title: "Change",
            intent: "Write the planned change",
            toolName: "Write",
            dependsOnStepIds: ["inspect"],
          },
        ],
      }),
    );

    const result = await planAndPersistSayuriTask({
      seed,
      stateStore: env.stateStore,
      modelsRuntime: env.runtime,
      modelGateway: {
        baseUrl: env.baseUrl,
        apiKey: "cloud-key",
        storageDir: env.providerStorage,
      },
      planId: "compiled-plan",
      now: "2026-10-06T10:20:00.000Z",
    });

    expect(result.task.status).toBe("ready");
    expect(result.plan.id).toBe("compiled-plan");
    expect(result.plan.steps[1]).toMatchObject({
      toolName: "Write",
      risk: "project-mutation",
      requiresEvidence: true,
    });
    expect((await env.stateStore.loadSnapshot(seed.taskId))?.plan.id).toBe(
      "compiled-plan",
    );
    expect(env.requests).toContain("/v1/models");
    expect(env.requests).toContain("/v1/chat/completions");
  });

  test("rejects non-JSON model output and persists nothing", async () => {
    const env = await setup("Here is your plan: {}");

    await expect(
      planAndPersistSayuriTask({
        seed,
        stateStore: env.stateStore,
        modelsRuntime: env.runtime,
        modelGateway: {
          baseUrl: env.baseUrl,
          apiKey: "cloud-key",
          storageDir: env.providerStorage,
        },
      }),
    ).rejects.toThrow("strict JSON");

    expect(await env.stateStore.loadSnapshot(seed.taskId)).toBeNull();
  });

  test("rejects authority injection before persistence", async () => {
    const env = await setup(
      JSON.stringify({
        taskId: seed.taskId,
        goalId: seed.goalId,
        steps: [
          {
            id: "write",
            title: "Write",
            intent: "Change a file",
            toolName: "Write",
            approvalGranted: true,
          },
        ],
      }),
    );

    await expect(
      requestSayuriPlannerV1Proposal({
        seed,
        modelsRuntime: env.runtime,
        modelGateway: {
          baseUrl: env.baseUrl,
          apiKey: "cloud-key",
          storageDir: env.providerStorage,
        },
      }).then((raw) => {
        // Parsing is deliberately a separate deterministic boundary.
        return import("./planner-v1").then(({ parseSayuriPlannerV1Proposal }) =>
          parseSayuriPlannerV1Proposal(raw, seed),
        );
      }),
    ).rejects.toThrow("authority field");
  });
});
