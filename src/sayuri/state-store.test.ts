import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSayuriBrainStateStore } from "./state-store";
import { createSayuriTask } from "./task-lifecycle";

describe("FileSayuriBrainStateStore", () => {
  test("round-trips task, plan, and append-only receipts", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayuri-state-store-"));
    try {
      const store = new FileSayuriBrainStateStore(root);
      const task = createSayuriTask({
        id: "../unsafe-looking-task",
        goal: "Verify encoded durable state paths",
        now: "2026-10-06T08:40:00.000Z",
      });
      const plan = {
        id: "plan-1",
        taskId: task.id,
        goal: task.goal,
        createdAt: "2026-10-06T08:40:00.000Z",
        steps: [
          {
            id: "read-step",
            title: "Read state",
            status: "pending" as const,
            risk: "read" as const,
            requiresEvidence: false,
          },
        ],
      };

      await store.saveSnapshot(task, plan);
      await store.appendReceipt(task.id, {
        id: "receipt-1",
        executionId: "execution-1",
        taskId: task.id,
        stepId: "read-step",
        kind: "tool-result",
        trust: "direct",
        outcome: "success",
        source: "test",
        summary: "State persisted.",
        createdAt: "2026-10-06T08:40:01.000Z",
        metadata: { toolCallId: "read-call" },
      });

      const reloaded = new FileSayuriBrainStateStore(root);
      expect((await reloaded.loadSnapshot(task.id))?.task.id).toBe(task.id);
      expect(await reloaded.loadReceipts(task.id)).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
