import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSayuriExecutionController } from "./execution-control";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";
import { resolveSayuriWorkspaceSandbox } from "./workspace-sandbox";

function runningTask() {
  let task = createSayuriTask({
    id: "sandbox-task",
    goal: "Constrain Sayuri shell execution",
    now: "2026-10-06T09:10:00.000Z",
  });
  task = transitionSayuriTask(task, "planning", "2026-10-06T09:10:01.000Z");
  task = transitionSayuriTask(task, "ready", "2026-10-06T09:10:02.000Z");
  return transitionSayuriTask(task, "running", "2026-10-06T09:10:03.000Z");
}

describe("Sayuri workspace sandbox policy", () => {
  test("requests a workspace sandbox when a kernel backend is available", async () => {
    const isolationRoot = await mkdtemp(join(tmpdir(), "sayuri-sandbox-"));
    const scopeRoot = join(isolationRoot, "project");
    await mkdir(scopeRoot);
    try {
      const result = resolveSayuriWorkspaceSandbox(scopeRoot, {
        backend: "seatbelt",
        reason: "test backend",
      });
      expect(result.sandbox?.root).toBe(
        resolve(scopeRoot).replaceAll("\\", "/"),
      );
      expect(result.sandbox?.isolationRoot).toBe(
        dirname(resolve(scopeRoot)).replaceAll("\\", "/"),
      );
    } finally {
      await rm(isolationRoot, { recursive: true, force: true });
    }
  });

  test("system mutation needs a matching active workspace sandbox", async () => {
    const isolationRoot = await mkdtemp(
      join(tmpdir(), "sayuri-system-sandbox-"),
    );
    const scopeRoot = join(isolationRoot, "project");
    await mkdir(scopeRoot);
    try {
      const controller = createSayuriExecutionController({
        task: runningTask(),
        scopeRoot,
        plan: {
          id: "system-plan",
          taskId: "sandbox-task",
          goal: "Authorize one sandboxed shell command",
          createdAt: "2026-10-06T09:11:00.000Z",
          steps: [
            {
              id: "shell-step",
              title: "Run sandboxed command",
              toolName: "Bash",
              status: "in-progress",
              risk: "system-mutation",
              requiresEvidence: true,
            },
          ],
        },
      });

      const denied = await controller.runtimeControl.grantApproval?.({
        toolCallId: "shell-no-sandbox",
        toolName: "Bash",
        args: { command: "echo blocked" },
        workingDirectory: scopeRoot,
      });
      expect(denied?.decision).toBe("deny");

      const sandbox = {
        root: resolve(scopeRoot),
        isolationRoot: resolve(isolationRoot),
      };
      const granted = await controller.runtimeControl.grantApproval?.({
        toolCallId: "shell-sandboxed",
        toolName: "Bash",
        args: { command: "echo safe" },
        workingDirectory: scopeRoot,
        workspaceSandbox: sandbox,
      });
      expect(granted?.decision).toBe("allow");

      const first = await controller.runtimeControl.authorize({
        toolName: "Bash",
        toolKind: "builtin",
        toolCallId: "shell-sandboxed",
        args: { command: "echo safe" },
        workingDirectory: scopeRoot,
      });
      expect(first.decision).toBe("allow");

      const replay = await controller.runtimeControl.authorize({
        toolName: "Bash",
        toolKind: "builtin",
        toolCallId: "shell-sandboxed",
        args: { command: "echo safe" },
        workingDirectory: scopeRoot,
      });
      expect(replay.decision).toBe("deny");
    } finally {
      await rm(isolationRoot, { recursive: true, force: true });
    }
  });
});
