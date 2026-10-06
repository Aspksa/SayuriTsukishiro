import { describe, expect, test } from "bun:test";
import { createSayuriExecutionController } from "./execution-control";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

describe("Sayuri controller lifecycle gate", () => {
  test("a waiting task denies even read-only execution until explicitly resumed", async () => {
    let task = createSayuriTask({
      id: "lifecycle-gate",
      goal: "Wait safely",
      now: "2026-10-06T09:42:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T09:42:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T09:42:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T09:42:03.000Z");
    const controller = createSayuriExecutionController({
      task,
      scopeRoot: "/workspace",
      plan: {
        id: "gate-plan",
        taskId: task.id,
        goal: task.goal,
        createdAt: "2026-10-06T09:42:00.000Z",
        steps: [
          {
            id: "read-step",
            title: "Read later",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
    });

    await controller.transitionTask(
      "waiting-user",
      "2026-10-06T09:42:04.000Z",
    );
    const denied = await controller.runtimeControl.authorize({
      toolName: "Read",
      toolKind: "builtin",
      toolCallId: "read-waiting",
      args: { file_path: "/workspace/file.txt" },
      workingDirectory: "/workspace",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("waiting-user");

    await controller.transitionTask(
      "running",
      "2026-10-06T09:42:05.000Z",
    );
    const allowed = await controller.runtimeControl.authorize({
      toolName: "Read",
      toolKind: "builtin",
      toolCallId: "read-resumed",
      args: { file_path: "/workspace/file.txt" },
      workingDirectory: "/workspace",
    });
    expect(allowed.decision).toBe("allow");
  });
});
