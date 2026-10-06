import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SayuriEvidenceLedger } from "./evidence-ledger";
import {
  createSayuriExecutionController,
} from "./execution-control";
import { FileSayuriGoalEvidenceStore } from "./goal-success";
import {
  FileSayuriGoalStore,
  linkTaskToSayuriGoal,
} from "./goal-manager";
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
import { finalizeSayuriSessionTask } from "./task-finalizer";

describe("Sayuri Task Finalizer", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function setup(successCriteria: string[] = []) {
    const root = await mkdtemp(join(tmpdir(), "sayuri-finalizer-"));
    roots.push(root);
    const stateStore = new FileSayuriBrainStateStore(root);
    const taskRegistry = new FileSayuriTaskRegistry(root);
    const goalStore = new FileSayuriGoalStore(root);
    const goalEvidenceStore = new FileSayuriGoalEvidenceStore(root);
    const indexed = new ProjectIndexedSayuriBrainStateStore({
      inner: stateStore,
      registry: taskRegistry,
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
    });

    let task = createSayuriTask({
      id: "task-final",
      goal: "Finish one unit",
      now: "2026-10-06T11:10:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T11:10:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T11:10:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T11:10:03.000Z");
    task = checkpointSayuriTask(task, {
      id: "checkpoint-final",
      createdAt: "2026-10-06T11:10:04.000Z",
      summary: "Final step complete.",
      nextAction: "Verify task completion.",
      verifiedReceiptIds: ["receipt-final"],
    });

    const plan = {
      id: "plan-final",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T11:10:00.000Z",
      steps: [
        {
          id: "final",
          title: "Final",
          status: "completed" as const,
          risk: "project-mutation" as const,
          requiresEvidence: true,
          receiptIds: ["receipt-final"],
        },
      ],
    };
    await indexed.saveSnapshot(task, plan);

    const ledger = new SayuriEvidenceLedger();
    ledger.append({
      id: "receipt-final",
      executionId: "exec-final",
      taskId: task.id,
      stepId: "final",
      kind: "file-change",
      trust: "direct",
      outcome: "success",
      source: "builtin:Write",
      summary: "Final write succeeded.",
      createdAt: "2026-10-06T11:10:04.000Z",
    });
    const controller = createSayuriExecutionController({
      task,
      plan,
      scopeRoot: join(root, "workspace"),
      stateStore: indexed,
      ledger,
    });

    let goal = await goalStore.createGoal({
      id: "goal-final",
      projectId: "project-a",
      title: "Finish goal",
      objective: "Finish one unit",
      successCriteria,
      createdAt: "2026-10-06T11:09:00.000Z",
    });
    goal = linkTaskToSayuriGoal(
      goal,
      task.id,
      "2026-10-06T11:10:04.000Z",
    );
    await goalStore.saveGoal(goal);

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

    return {
      root,
      session,
      taskRegistry,
      goalStore,
      goalEvidenceStore,
    };
  }

  test("finalizes the task, completes a verified goal, and requests next work", async () => {
    const env = await setup();
    const result = await finalizeSayuriSessionTask({
      session: env.session,
      goalStore: env.goalStore,
      goalEvidenceStore: env.goalEvidenceStore,
      modelGateway: {
        baseUrl: "https://unused.example.test/v1",
        apiKey: "unused",
        storageDir: join(env.root, "provider"),
      },
      now: "2026-10-06T11:10:05.000Z",
    });

    expect(result.kind).toBe("finalized");
    if (result.kind !== "finalized") throw new Error("Expected finalized");
    expect(result.goal).toBe("completed");
    expect(result.nextWork?.kind).toBe("idle");
    expect(
      (await env.taskRegistry.getTask("project-a", "task-final"))?.status,
    ).toBe("completed");
    expect(
      (await env.goalStore.getGoal("project-a", "goal-final"))?.status,
    ).toBe("completed");
  });

  test("blocks the goal instead of spawning duplicate work while criterion evidence is missing", async () => {
    const env = await setup(["User accepts result"]);
    const result = await finalizeSayuriSessionTask({
      session: env.session,
      goalStore: env.goalStore,
      goalEvidenceStore: env.goalEvidenceStore,
      modelGateway: {
        baseUrl: "https://unused.example.test/v1",
        apiKey: "unused",
        storageDir: join(env.root, "provider"),
      },
      now: "2026-10-06T11:11:00.000Z",
    });

    expect(result.kind).toBe("waiting-goal-evidence");
    expect(
      (await env.goalStore.getGoal("project-a", "goal-final"))?.status,
    ).toBe("blocked");
  });
});
