import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTools, executeTool, loadSpecificTools } from "@/tools/manager";
import {
  createDurableSayuriExecutionController,
  resumeSayuriExecutionController,
  runWithSayuriExecutionController,
} from "./execution-control";
import { FileSayuriBrainStateStore } from "./state-store";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

let root = "";
let workDir = "";

function runningTask() {
  let task = createSayuriTask({
    id: "durable-task",
    goal: "Persist verified Sayuri execution state",
    now: "2026-10-06T08:30:00.000Z",
  });
  task = transitionSayuriTask(task, "planning", "2026-10-06T08:30:01.000Z");
  task = transitionSayuriTask(task, "ready", "2026-10-06T08:30:02.000Z");
  return transitionSayuriTask(task, "running", "2026-10-06T08:30:03.000Z");
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "sayuri-brain-state-"));
  workDir = join(root, "workspace");
  await mkdir(workDir, { recursive: true });
  clearTools();
  await loadSpecificTools(["Write"]);
});

afterEach(async () => {
  clearTools();
  await rm(root, { recursive: true, force: true });
});

describe("Sayuri durable brain state", () => {
  test("recovers receipts and checkpoints across controller restarts", async () => {
    const stateStore = new FileSayuriBrainStateStore(join(root, "state"));
    const targetPath = join(workDir, "durable.txt");
    const plan = {
      id: "durable-plan",
      taskId: "durable-task",
      goal: "Write durable evidence",
      createdAt: "2026-10-06T08:30:04.000Z",
      steps: [
        {
          id: "write-step",
          title: "Write verified state",
          toolName: "Write",
          status: "in-progress" as const,
          risk: "project-mutation" as const,
          requiresEvidence: true,
        },
      ],
    };

    const controller = await createDurableSayuriExecutionController({
      task: runningTask(),
      plan,
      scopeRoot: workDir,
      stateStore,
      authorizations: [
        {
          toolCallId: "durable-write",
          stepId: "write-step",
          scopeApproved: true,
          approvalGranted: true,
        },
      ],
    });

    const result = await runWithSayuriExecutionController(controller, () =>
      executeTool(
        "Write",
        { file_path: targetPath, content: "persisted" },
        { toolCallId: "durable-write" },
      ),
    );
    expect(result.status).toBe("success");
    expect(controller.verifyToolCall("durable-write").verdict).toBe("verified");

    const resumed = await resumeSayuriExecutionController({
      stateStore: new FileSayuriBrainStateStore(join(root, "state")),
      taskId: "durable-task",
      scopeRoot: workDir,
    });
    expect(resumed.verifyToolCall("durable-write").verdict).toBe("verified");

    const checkpointed = await resumed.checkpointToolCall({
      toolCallId: "durable-write",
      summary: "Recovered execution remains verifiable.",
      nextAction: "Resume the next plan step.",
      createdAt: "2026-10-06T08:30:05.000Z",
    });
    expect(checkpointed.status).toBe("checkpointed");

    const resumedAgain = await resumeSayuriExecutionController({
      stateStore: new FileSayuriBrainStateStore(join(root, "state")),
      taskId: "durable-task",
      scopeRoot: workDir,
    });
    expect(resumedAgain.task.status).toBe("checkpointed");
    expect(resumedAgain.task.checkpoints).toHaveLength(1);
    expect(await readFile(targetPath, "utf8")).toBe("persisted");
  });

  test("does not persist approval grants across a restart", async () => {
    const stateStore = new FileSayuriBrainStateStore(join(root, "state"));
    const controller = await createDurableSayuriExecutionController({
      task: runningTask(),
      scopeRoot: workDir,
      stateStore,
      plan: {
        id: "approval-plan",
        taskId: "durable-task",
        goal: "Require fresh mutation approval after restart",
        createdAt: "2026-10-06T08:31:00.000Z",
        steps: [
          {
            id: "write-step",
            title: "Write only with live approval",
            toolName: "Write",
            status: "in-progress",
            risk: "project-mutation",
            requiresEvidence: true,
          },
        ],
      },
      authorizations: [
        {
          toolCallId: "first-write",
          stepId: "write-step",
          scopeApproved: true,
          approvalGranted: true,
        },
      ],
    });

    const first = await runWithSayuriExecutionController(controller, () =>
      executeTool(
        "Write",
        { file_path: join(workDir, "first.txt"), content: "ok" },
        { toolCallId: "first-write" },
      ),
    );
    expect(first.status).toBe("success");

    const resumed = await resumeSayuriExecutionController({
      stateStore,
      taskId: "durable-task",
      scopeRoot: workDir,
    });
    const second = await runWithSayuriExecutionController(resumed, () =>
      executeTool(
        "Write",
        { file_path: join(workDir, "second.txt"), content: "blocked" },
        { toolCallId: "second-write" },
      ),
    );
    expect(second.status).toBe("error");
    expect(String(second.toolReturn)).toContain(
      "Action is not attached to a validated plan step",
    );
    expect(await Bun.file(join(workDir, "second.txt")).exists()).toBe(false);
  });
});
