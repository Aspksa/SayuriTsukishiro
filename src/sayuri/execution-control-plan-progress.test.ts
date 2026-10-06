import {
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "sayuri-plan-progress-controller-"));
  clearTools();
  await loadSpecificTools(["Read"]);
});

afterEach(async () => {
  clearTools();
  await rm(workDir, { recursive: true, force: true });
});

describe("Sayuri execution controller plan progression", () => {
  test("binds an active read step and advances to its dependency-successor", async () => {
    let task = createSayuriTask({
      id: "read-progress-task",
      goal: "Advance a read step",
      now: "2026-10-06T10:41:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T10:41:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T10:41:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T10:41:03.000Z");

    const file = join(workDir, "source.txt");
    await writeFile(file, "Sayuri", "utf8");
    const controller = createSayuriExecutionController({
      task,
      scopeRoot: workDir,
      plan: {
        id: "read-progress-plan",
        taskId: task.id,
        goal: task.goal,
        createdAt: "2026-10-06T10:41:00.000Z",
        steps: [
          {
            id: "inspect",
            title: "Inspect",
            intent: "Read source",
            toolName: "Read",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "next",
            title: "Next",
            intent: "Continue analysis",
            toolName: "Read",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
            dependsOnStepIds: ["inspect"],
          },
        ],
      },
    });

    const result = await runWithSayuriExecutionController(controller, () =>
      executeTool("Read", { file_path: file }, { toolCallId: "read-progress" }),
    );
    expect(result.status).toBe("success");

    await controller.checkpointToolCall({
      toolCallId: "read-progress",
      summary: "Source read and verified.",
      nextAction: "Caller fallback",
      createdAt: "2026-10-06T10:41:04.000Z",
    });

    expect(controller.plan.steps[0]?.status).toBe("completed");
    expect(controller.plan.steps[1]?.status).toBe("in-progress");
    expect(controller.task.checkpoints.at(-1)?.nextAction).toBe(
      "Continue analysis",
    );
  });
});
