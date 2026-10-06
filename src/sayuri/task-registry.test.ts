import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileSayuriTaskRegistry,
  ProjectIndexedSayuriBrainStateStore,
} from "./task-registry";
import { FileSayuriBrainStateStore } from "./state-store";
import {
  createSayuriTask,
  transitionSayuriTask,
} from "./task-lifecycle";

describe("Sayuri project task registry", () => {
  test("indexes durable task state by project and finds unfinished work", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayuri-task-registry-"));
    try {
      const registry = new FileSayuriTaskRegistry(root);
      const inner = new FileSayuriBrainStateStore(root);
      const store = new ProjectIndexedSayuriBrainStateStore({
        inner,
        registry,
        projectId: "project-a",
        agentId: "sayuri-primary",
        conversationId: "default",
      });

      let task = createSayuriTask({
        id: "task-a",
        goal: "Continue project work",
        now: "2026-10-06T09:30:00.000Z",
      });
      task = transitionSayuriTask(
        task,
        "planning",
        "2026-10-06T09:30:01.000Z",
      );
      task = transitionSayuriTask(
        task,
        "ready",
        "2026-10-06T09:30:02.000Z",
      );
      task = transitionSayuriTask(
        task,
        "running",
        "2026-10-06T09:30:03.000Z",
      );
      const plan = {
        id: "plan-a",
        taskId: "task-a",
        goal: "Continue project work",
        createdAt: "2026-10-06T09:30:00.000Z",
        steps: [
          {
            id: "read-step",
            title: "Inspect project",
            status: "pending" as const,
            risk: "read" as const,
            requiresEvidence: false,
          },
        ],
      };

      await store.saveSnapshot(task, plan);

      const entry = await registry.getTask("project-a", "task-a");
      expect(entry).toMatchObject({
        projectId: "project-a",
        taskId: "task-a",
        planId: "plan-a",
        status: "running",
        checkpointCount: 0,
      });
      expect((await registry.findLatestUnfinished("project-a"))?.taskId).toBe(
        "task-a",
      );
      expect(await registry.findLatestUnfinished("project-b")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps terminal tasks indexed but excludes them from unfinished recovery", async () => {
    const root = await mkdtemp(join(tmpdir(), "sayuri-task-registry-"));
    try {
      const registry = new FileSayuriTaskRegistry(root);
      await registry.upsertTask({
        projectId: "project-a",
        taskId: "done",
        planId: "done-plan",
        agentId: "sayuri-primary",
        conversationId: "default",
        goal: "Finished",
        status: "completed",
        revision: 7,
        updatedAt: "2026-10-06T09:31:00.000Z",
        checkpointCount: 2,
        nextAction: "None",
      });

      expect(await registry.listProjectTasks("project-a")).toHaveLength(1);
      expect(await registry.findLatestUnfinished("project-a")).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
