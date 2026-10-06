import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSayuriBackgroundLeaseRecord,
  FileSayuriBackgroundLeaseStore,
  recoverSayuriBackgroundLeases,
  transitionSayuriBackgroundLease,
} from "./background-lease";
import {
  cancelSayuriBackgroundSubagent,
  handoffSayuriBackgroundResult,
} from "./background-runtime";
import { createSayuriExecutionController } from "./execution-control";
import { createSayuriSubagentCapabilityLease } from "./subagent-lease";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

describe("Sayuri background runtime handoff", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-background-runtime-"));
    roots.push(root);
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-bg-runtime",
      parentTaskId: "task-bg",
      parentPlanId: "plan-bg",
      parentStepId: "delegate",
      subagentId: "child-bg",
      subagentType: "general-purpose",
      allowedTools: ["Read"],
      scopeRoot: join(root, "workspace"),
      issuedAt: "2026-10-06T12:20:00.000Z",
      expiresAt: "2026-10-06T13:20:00.000Z",
    });
    return {
      root,
      lease,
      store: new FileSayuriBackgroundLeaseStore(root),
    };
  }

  test("hands a completed child result to the parent exactly once", async () => {
    const { root, lease, store } = await setup();
    let task = createSayuriTask({
      id: "task-bg",
      goal: "Use background evidence",
      now: "2026-10-06T12:20:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T12:20:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T12:20:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T12:20:03.000Z");
    const plan = {
      id: "plan-bg",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T12:20:00.000Z",
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
      scopeRoot: join(root, "workspace"),
    });
    let record = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease,
      deadlineAt: "2026-10-06T12:50:00.000Z",
      now: "2026-10-06T12:20:04.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "running", {
      now: "2026-10-06T12:20:05.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "completed", {
      now: "2026-10-06T12:20:06.000Z",
      resultReceipt: {
        id: "receipt-lease-bg-runtime",
        executionId: "subagent-lease-bg-runtime",
        taskId: task.id,
        stepId: "delegate",
        kind: "tool-result",
        trust: "derived",
        outcome: "success",
        source: "sayuri-subagent:general-purpose",
        summary: "Background child completed.",
        createdAt: "2026-10-06T12:20:06.000Z",
        metadata: {
          leaseId: lease.id,
          subagentId: lease.subagentId,
        },
      },
    });
    await store.save(record);

    const first = await handoffSayuriBackgroundResult({
      projectId: "project-a",
      leaseId: lease.id,
      store,
      controller,
      summary: "Background result accepted.",
      nextAction: "Finalize if ready.",
      now: "2026-10-06T12:20:07.000Z",
    });
    expect(first.status).toBe("handed-off");
    expect(controller.task.status).toBe("checkpointed");
    expect(controller.plan.steps[0]?.status).toBe("completed");
    expect(controller.evidenceSnapshot()).toHaveLength(1);

    const second = await handoffSayuriBackgroundResult({
      projectId: "project-a",
      leaseId: lease.id,
      store,
      controller,
      summary: "Must be idempotent.",
      nextAction: "None",
      now: "2026-10-06T12:20:08.000Z",
    });
    expect(second.status).toBe("handed-off");
    expect(controller.evidenceSnapshot()).toHaveLength(1);
    expect(controller.task.checkpoints).toHaveLength(1);
  });

  test("can cancel an orphaned durable lease after restart", async () => {
    const { lease, store } = await setup();
    let record = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease,
      deadlineAt: "2026-10-06T12:50:00.000Z",
      now: "2026-10-06T12:20:04.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "running", {
      now: "2026-10-06T12:20:05.000Z",
    });
    await store.save(record);
    await recoverSayuriBackgroundLeases({
      projectId: "project-a",
      store,
      now: "2026-10-06T12:21:00.000Z",
    });

    const cancelled = await cancelSayuriBackgroundSubagent({
      projectId: "project-a",
      leaseId: lease.id,
      store,
      now: "2026-10-06T12:21:01.000Z",
    });
    expect(cancelled.status).toBe("cancelled");
  });
});
