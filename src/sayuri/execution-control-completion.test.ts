import { describe, expect, test } from "bun:test";
import { SayuriEvidenceLedger } from "./evidence-ledger";
import {
  createSayuriExecutionController,
} from "./execution-control";
import {
  checkpointSayuriTask,
  createSayuriTask,
  transitionSayuriTask,
} from "./task-lifecycle";

describe("Sayuri controller Completion Gate", () => {
  test("persists verifying before completed and refuses model-style early completion", async () => {
    let task = createSayuriTask({
      id: "completion-task",
      goal: "Finish only after evidence",
      now: "2026-10-06T10:52:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T10:52:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T10:52:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T10:52:03.000Z");
    task = checkpointSayuriTask(task, {
      id: "checkpoint-final",
      createdAt: "2026-10-06T10:52:04.000Z",
      summary: "Final step verified.",
      nextAction: "Verify overall task completion.",
      verifiedReceiptIds: ["receipt-final"],
    });

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
      summary: "Final mutation succeeded.",
      createdAt: "2026-10-06T10:52:04.000Z",
    });

    const persistedStatuses: string[] = [];
    const controller = createSayuriExecutionController({
      task,
      ledger,
      scopeRoot: "/workspace",
      plan: {
        id: "completion-plan",
        taskId: task.id,
        goal: task.goal,
        createdAt: "2026-10-06T10:52:00.000Z",
        steps: [
          {
            id: "final",
            title: "Final",
            status: "completed",
            risk: "project-mutation",
            requiresEvidence: true,
            receiptIds: ["receipt-final"],
          },
        ],
      },
      stateStore: {
        async saveSnapshot(savedTask) {
          persistedStatuses.push(savedTask.status);
        },
        async loadSnapshot() {
          return null;
        },
        async appendReceipt() {},
        async loadReceipts() {
          return [];
        },
      },
    });

    const completed = await controller.completeTaskIfReady(
      "2026-10-06T10:52:05.000Z",
    );
    expect(completed.status).toBe("completed");
    expect(persistedStatuses).toEqual(["verifying", "completed"]);
  });

  test("rejects completion while plan work is still pending", async () => {
    let task = createSayuriTask({
      id: "incomplete-task",
      goal: "Do not finish early",
      now: "2026-10-06T10:53:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T10:53:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T10:53:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T10:53:03.000Z");
    task = checkpointSayuriTask(task, {
      id: "checkpoint-incomplete",
      createdAt: "2026-10-06T10:53:04.000Z",
      summary: "Partial work.",
      nextAction: "Continue.",
      verifiedReceiptIds: [],
    });

    const controller = createSayuriExecutionController({
      task,
      scopeRoot: "/workspace",
      plan: {
        id: "incomplete-plan",
        taskId: task.id,
        goal: task.goal,
        createdAt: "2026-10-06T10:53:00.000Z",
        steps: [
          {
            id: "pending",
            title: "Pending",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
    });

    await expect(controller.completeTaskIfReady()).rejects.toThrow(
      "Completion Gate rejected",
    );
    expect(controller.task.status).toBe("checkpointed");
  });
});
