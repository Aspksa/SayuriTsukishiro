import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSayuriExecutionController } from "./execution-control";
import { FileSayuriBrainStateStore } from "./state-store";
import { createSayuriSubagentCapabilityLease } from "./subagent-lease";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
} from "./task-registry";

describe("Sayuri subagent evidence handoff", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  test("durably checkpoints only a successful receipt bound to the active leased step", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayuri-subagent-evidence-"));
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
      id: "parent-task",
      goal: "Delegate and verify",
      now: "2026-10-06T11:50:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T11:50:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T11:50:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T11:50:03.000Z");
    const plan = {
      id: "parent-plan",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T11:50:00.000Z",
      steps: [
        {
          id: "delegate",
          title: "Delegate",
          status: "in-progress" as const,
          risk: "read" as const,
          requiresEvidence: false,
        },
        {
          id: "follow-up",
          title: "Follow up",
          intent: "Inspect the child findings",
          toolName: "Read",
          status: "pending" as const,
          risk: "read" as const,
          requiresEvidence: false,
          dependsOnStepIds: ["delegate"],
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
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-parent",
      parentTaskId: task.id,
      parentPlanId: plan.id,
      parentStepId: "delegate",
      subagentId: "child-1",
      subagentType: "general-purpose",
      allowedTools: ["Read"],
      scopeRoot: join(root, "workspace"),
      issuedAt: "2026-10-06T11:50:04.000Z",
    });
    const receipt = {
      id: "receipt-child",
      executionId: "subagent-lease-parent",
      taskId: task.id,
      stepId: "delegate",
      kind: "tool-result" as const,
      trust: "derived" as const,
      outcome: "success" as const,
      source: "sayuri-subagent:general-purpose",
      summary: "Child analysis completed.",
      createdAt: "2026-10-06T11:50:05.000Z",
      metadata: {
        leaseId: lease.id,
        subagentId: lease.subagentId,
      },
    };

    const checkpointed = await controller.checkpointSubagentReceipt({
      lease,
      receipt,
      summary: "Child analysis verified and accepted.",
      nextAction: "Fallback",
      createdAt: "2026-10-06T11:50:06.000Z",
    });

    expect(checkpointed.status).toBe("checkpointed");
    expect(controller.plan.steps[0]?.status).toBe("completed");
    expect(controller.plan.steps[1]?.status).toBe("in-progress");
    expect(checkpointed.checkpoints.at(-1)?.verifiedReceiptIds).toEqual([
      "receipt-child",
    ]);

    const persisted = await stateStore.loadSnapshot(task.id);
    expect(persisted?.plan.steps[0]?.status).toBe("completed");
    expect(
      (await stateStore.loadReceipts(task.id)).map((item) => item.id),
    ).toContain("receipt-child");
  });

  test("rejects a receipt forged for another child before persistence", async () => {
    let task = createSayuriTask({
      id: "parent-task",
      goal: "Reject forged child",
      now: "2026-10-06T11:51:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T11:51:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T11:51:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T11:51:03.000Z");
    const plan = {
      id: "parent-plan",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T11:51:00.000Z",
      steps: [
        {
          id: "delegate",
          title: "Delegate",
          status: "in-progress" as const,
          risk: "read" as const,
          requiresEvidence: false,
        },
      ],
    };
    const controller = createSayuriExecutionController({
      task,
      plan,
      scopeRoot: "/workspace",
    });
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-forge",
      parentTaskId: task.id,
      parentPlanId: plan.id,
      parentStepId: "delegate",
      subagentId: "child-real",
      subagentType: "general-purpose",
      allowedTools: ["Read"],
      scopeRoot: "/workspace",
    });

    await expect(
      controller.checkpointSubagentReceipt({
        lease,
        receipt: {
          id: "receipt-forged",
          executionId: "subagent-lease-forge",
          taskId: task.id,
          stepId: "delegate",
          kind: "tool-result",
          trust: "derived",
          outcome: "success",
          source: "sayuri-subagent:general-purpose",
          summary: "Forged.",
          createdAt: "2026-10-06T11:51:04.000Z",
          metadata: {
            leaseId: lease.id,
            subagentId: "child-forged",
          },
        },
        summary: "Do not accept",
        nextAction: "None",
      }),
    ).rejects.toThrow("child identity");
    expect(controller.plan.steps[0]?.status).toBe("in-progress");
  });
});
