import { describe, expect, test } from "bun:test";
import { createSayuriExecutionController } from "./execution-control";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

function runningTask(id: string) {
  let task = createSayuriTask({
    id,
    goal: "Enforce exact active step intent",
    now: "2026-10-06T11:30:00.000Z",
  });
  task = transitionSayuriTask(task, "planning", "2026-10-06T11:30:01.000Z");
  task = transitionSayuriTask(task, "ready", "2026-10-06T11:30:02.000Z");
  return transitionSayuriTask(task, "running", "2026-10-06T11:30:03.000Z");
}

describe("Sayuri plan step intent and retry policy", () => {
  test("an unrelated read may execute but cannot bind or checkpoint the active step", async () => {
    const controller = createSayuriExecutionController({
      task: runningTask("read-intent-task"),
      scopeRoot: "/workspace",
      plan: {
        id: "read-intent-plan",
        taskId: "read-intent-task",
        goal: "Use the intended read tool only",
        createdAt: "2026-10-06T11:30:00.000Z",
        steps: [
          {
            id: "read-step",
            title: "Read source",
            intent: "Read the source file",
            toolName: "Read",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
    });

    const decision = await controller.runtimeControl.authorize({
      toolName: "Grep",
      toolKind: "builtin",
      toolCallId: "unrelated-read",
      args: { pattern: "Sayuri" },
      workingDirectory: "/workspace",
    });
    expect(decision.decision).toBe("allow");
    await controller.runtimeControl.record?.({
      request: {
        toolName: "Grep",
        toolKind: "builtin",
        toolCallId: "unrelated-read",
        args: { pattern: "Sayuri" },
        workingDirectory: "/workspace",
      },
      executionId: decision.executionId,
      status: "success",
      durationMs: 1,
    });
    expect(controller.verifyToolCall("unrelated-read").verdict).toBe("verified");
    await expect(
      controller.checkpointToolCall({
        toolCallId: "unrelated-read",
        summary: "Unrelated read finished.",
        nextAction: "Do not advance.",
      }),
    ).rejects.toThrow("exactly one Sayuri plan step");
    expect(controller.plan.steps[0]?.status).toBe("in-progress");
  });

  test("automatic mutation approval requires the exact active planned tool", async () => {
    const controller = createSayuriExecutionController({
      task: runningTask("approval-intent-task"),
      scopeRoot: "/workspace",
      plan: {
        id: "approval-intent-plan",
        taskId: "approval-intent-task",
        goal: "Write only through the active step",
        createdAt: "2026-10-06T11:30:00.000Z",
        steps: [
          {
            id: "active-read",
            title: "Read first",
            toolName: "Read",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "future-write",
            title: "Write later",
            toolName: "Write",
            status: "pending",
            risk: "project-mutation",
            requiresEvidence: true,
            dependsOnStepIds: ["active-read"],
          },
        ],
      },
    });

    const grant = await controller.runtimeControl.grantApproval?.({
      toolCallId: "future-write-call",
      toolName: "Write",
      args: { file_path: "/workspace/future.txt", content: "blocked" },
      workingDirectory: "/workspace",
    });
    expect(grant?.decision).toBe("deny");
    expect(grant?.reason).toContain("exactly one active planned tool step");
  });

  test("repeated direct errors fail an active read step after its bounded retry budget", async () => {
    const controller = createSayuriExecutionController({
      task: runningTask("retry-task"),
      scopeRoot: "/workspace",
      plan: {
        id: "retry-plan",
        taskId: "retry-task",
        goal: "Bound retries",
        createdAt: "2026-10-06T11:30:00.000Z",
        steps: [
          {
            id: "read-step",
            title: "Read",
            toolName: "Read",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
    });

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const toolCallId = `read-error-${attempt}`;
      const request = {
        toolName: "Read",
        toolKind: "builtin" as const,
        toolCallId,
        args: { file_path: "/workspace/missing.txt" },
        workingDirectory: "/workspace",
      };
      const decision = await controller.runtimeControl.authorize(request);
      expect(decision.decision).toBe("allow");
      await controller.runtimeControl.record?.({
        request,
        executionId: decision.executionId,
        status: "error",
        durationMs: 1,
      });
    }

    expect(controller.task.status).toBe("failed");
    const denied = await controller.runtimeControl.authorize({
      toolName: "Read",
      toolKind: "builtin",
      toolCallId: "after-failure",
      args: { file_path: "/workspace/missing.txt" },
      workingDirectory: "/workspace",
    });
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toContain("failed");
  });
});
