import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalDecision,
  executeApprovalBatch,
} from "@/agent/approval-execution";
import {
  clearTools,
  loadSpecificTools,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { createSayuriExecutionController } from "./execution-control";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

let workDir = "";

function runningTask() {
  let task = createSayuriTask({
    id: "approval-task",
    goal: "Bridge human approval safely",
    now: "2026-10-06T09:00:00.000Z",
  });
  task = transitionSayuriTask(task, "planning", "2026-10-06T09:00:01.000Z");
  task = transitionSayuriTask(task, "ready", "2026-10-06T09:00:02.000Z");
  return transitionSayuriTask(task, "running", "2026-10-06T09:00:03.000Z");
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "sayuri-approval-bridge-"));
  clearTools();
  await loadSpecificTools(["Write", "Bash"]);
});

afterEach(async () => {
  clearTools();
  await rm(workDir, { recursive: true, force: true });
});

describe("Sayuri approval bridge", () => {
  test("turns an existing human approval into one scoped project mutation", async () => {
    const target = join(workDir, "approved.txt");
    const controller = createSayuriExecutionController({
      task: runningTask(),
      scopeRoot: workDir,
      plan: {
        id: "approval-plan",
        taskId: "approval-task",
        goal: "Perform one approved project mutation",
        createdAt: "2026-10-06T09:00:04.000Z",
        steps: [
          {
            id: "write-step",
            title: "Write approved file",
            toolName: "Write",
            status: "in-progress",
            risk: "project-mutation",
            requiresEvidence: true,
          },
        ],
      },
    });
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Write"],
      {
        workingDirectory: workDir,
        runtimeContext: {
          toolExecutionControl: controller.runtimeControl,
          permissionMode: "standard",
        },
      },
    );
    const decision: ApprovalDecision = {
      type: "approve",
      approval: {
        toolCallId: "approved-write",
        toolName: "Write",
        toolArgs: JSON.stringify({
          file_path: target,
          content: "approved",
        }),
      },
    };

    try {
      const [result] = await executeApprovalBatch([decision], undefined, {
        toolContextId: prepared.contextId,
        workingDirectory: workDir,
      });
      expect(result?.type).toBe("tool");
      expect(result && "status" in result ? result.status : undefined).toBe(
        "success",
      );
      expect(await readFile(target, "utf8")).toBe("approved");
      expect(controller.verifyToolCall("approved-write").verdict).toBe(
        "verified",
      );

      const [replay] = await executeApprovalBatch([decision], undefined, {
        toolContextId: prepared.contextId,
        workingDirectory: workDir,
      });
      expect(replay && "status" in replay ? replay.status : undefined).toBe(
        "error",
      );
      expect(
        replay && "tool_return" in replay ? String(replay.tool_return) : "",
      ).toContain("already been consumed");
    } finally {
      releaseToolExecutionContext(prepared.contextId);
    }
  });

  test("requires an active workspace sandbox for shell approval bridging", async () => {
    const controller = createSayuriExecutionController({
      task: runningTask(),
      scopeRoot: workDir,
      plan: {
        id: "shell-plan",
        taskId: "approval-task",
        goal: "Keep shell blocked until sandbox policy is ready",
        createdAt: "2026-10-06T09:01:00.000Z",
        steps: [
          {
            id: "shell-step",
            title: "Run shell",
            toolName: "Bash",
            status: "in-progress",
            risk: "system-mutation",
            requiresEvidence: true,
          },
        ],
      },
    });
    const prepared = await prepareToolExecutionContextForSpecificTools(
      ["Bash"],
      {
        workingDirectory: workDir,
        runtimeContext: {
          toolExecutionControl: controller.runtimeControl,
          permissionMode: "standard",
        },
      },
    );

    try {
      const [result] = await executeApprovalBatch(
        [
          {
            type: "approve",
            approval: {
              toolCallId: "shell-call",
              toolName: "Bash",
              toolArgs: JSON.stringify({ command: "echo should-not-run" }),
            },
          },
        ],
        undefined,
        {
          toolContextId: prepared.contextId,
          workingDirectory: workDir,
        },
      );
      expect(result && "status" in result ? result.status : undefined).toBe(
        "error",
      );
      expect(
        result && "tool_return" in result ? String(result.tool_return) : "",
      ).toContain("requires an active Sayuri workspace sandbox");
    } finally {
      releaseToolExecutionContext(prepared.contextId);
    }
  });
});
