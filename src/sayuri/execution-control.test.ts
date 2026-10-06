import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTools,
  executeTool,
  loadSpecificTools,
} from "@/tools/manager";
import {
  createSayuriExecutionController,
  runWithSayuriExecutionController,
} from "./execution-control";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

let workDir = "";

function runningTask() {
  let task = createSayuriTask({
    id: "task-execution-control",
    goal: "Exercise the Sayuri execution boundary",
    now: "2026-10-06T08:00:00.000Z",
  });
  task = transitionSayuriTask(
    task,
    "planning",
    "2026-10-06T08:00:01.000Z",
  );
  task = transitionSayuriTask(
    task,
    "ready",
    "2026-10-06T08:00:02.000Z",
  );
  return transitionSayuriTask(
    task,
    "running",
    "2026-10-06T08:00:03.000Z",
  );
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "sayuri-execution-control-"));
  clearTools();
  await loadSpecificTools(["Read", "Write"]);
});

afterEach(async () => {
  clearTools();
  await rm(workDir, { recursive: true, force: true });
});

describe("Sayuri real tool execution control", () => {
  test("allows scoped reads without a mutation authorization", async () => {
    const sourcePath = join(workDir, "source.txt");
    await writeFile(sourcePath, "Sayuri", "utf8");
    const controller = createSayuriExecutionController({
      task: runningTask(),
      scopeRoot: workDir,
      plan: {
        id: "plan-read",
        taskId: "task-execution-control",
        goal: "Read project evidence",
        createdAt: "2026-10-06T08:00:04.000Z",
        steps: [
          {
            id: "read-step",
            title: "Read project file",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
    });

    const result = await runWithSayuriExecutionController(controller, () =>
      executeTool(
        "Read",
        { file_path: sourcePath },
        { toolCallId: "read-1" },
      ),
    );

    expect(result.status).toBe("success");
    expect(controller.verifyToolCall("read-1").verdict).toBe("verified");
  });

  test("blocks an unplanned write before the file is created", async () => {
    const targetPath = join(workDir, "blocked.txt");
    const controller = createSayuriExecutionController({
      task: runningTask(),
      scopeRoot: workDir,
      plan: {
        id: "plan-block",
        taskId: "task-execution-control",
        goal: "Protect project mutations",
        createdAt: "2026-10-06T08:00:04.000Z",
        steps: [
          {
            id: "write-step",
            title: "Write approved file",
            status: "in-progress",
            risk: "project-mutation",
            requiresEvidence: true,
          },
        ],
      },
    });

    const result = await runWithSayuriExecutionController(controller, () =>
      executeTool(
        "Write",
        { file_path: targetPath, content: "must not exist" },
        { toolCallId: "write-unplanned" },
      ),
    );

    expect(result.status).toBe("error");
    expect(String(result.toolReturn)).toContain("denied by runtime control");
    expect(controller.verifyToolCall("write-unplanned").verdict).toBe("failed");
    expect(readFile(targetPath, "utf8")).rejects.toThrow();
  });

  test("executes an approved planned write, records evidence, and checkpoints it", async () => {
    const targetPath = join(workDir, "approved.txt");
    const controller = createSayuriExecutionController({
      task: runningTask(),
      scopeRoot: workDir,
      plan: {
        id: "plan-write",
        taskId: "task-execution-control",
        goal: "Write a verified project file",
        createdAt: "2026-10-06T08:00:04.000Z",
        steps: [
          {
            id: "write-step",
            title: "Write project file",
            toolName: "Write",
            status: "in-progress",
            risk: "project-mutation",
            requiresEvidence: true,
          },
        ],
      },
      authorizations: [
        {
          toolCallId: "write-approved",
          stepId: "write-step",
          scopeApproved: true,
          approvalGranted: true,
        },
      ],
    });

    const result = await runWithSayuriExecutionController(controller, () =>
      executeTool(
        "Write",
        { file_path: targetPath, content: "verified" },
        { toolCallId: "write-approved" },
      ),
    );

    expect(result.status).toBe("success");
    expect(await readFile(targetPath, "utf8")).toBe("verified");
    expect(controller.verifyToolCall("write-approved").verdict).toBe("verified");

    const checkpointed = await controller.checkpointToolCall({
      toolCallId: "write-approved",
      summary: "Approved file write completed and verified.",
      nextAction: "Continue to the next planned step.",
      createdAt: "2026-10-06T08:00:05.000Z",
    });
    expect(checkpointed.status).toBe("checkpointed");
    expect(checkpointed.checkpoints).toHaveLength(1);
    expect(checkpointed.checkpoints[0]?.verifiedReceiptIds).toHaveLength(1);
  });
});
