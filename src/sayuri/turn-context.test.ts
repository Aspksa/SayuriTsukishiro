import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSayuriExecutionController } from "./execution-control";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";
import {
  buildSayuriTurnRuntimeContext,
  withSayuriTurnOptions,
} from "./turn-context";

function runningTask() {
  let task = createSayuriTask({
    id: "turn-task",
    goal: "Bind Sayuri to one turn",
    now: "2026-10-06T08:50:00.000Z",
  });
  task = transitionSayuriTask(task, "planning", "2026-10-06T08:50:01.000Z");
  task = transitionSayuriTask(task, "ready", "2026-10-06T08:50:02.000Z");
  return transitionSayuriTask(task, "running", "2026-10-06T08:50:03.000Z");
}

describe("Sayuri turn context", () => {
  test("binds execution control only to the requested turn", () => {
    const scopeRoot = mkdtempSync(join(tmpdir(), "sayuri-turn-context-"));
    try {
      const controller = createSayuriExecutionController({
        task: runningTask(),
        scopeRoot,
        plan: {
          id: "turn-plan",
          taskId: "turn-task",
          goal: "Bind a turn",
          createdAt: "2026-10-06T08:50:04.000Z",
          steps: [
            {
              id: "read-step",
              title: "Read safely",
              status: "pending",
              risk: "read",
              requiresEvidence: false,
            },
          ],
        },
      });

      const runtime = buildSayuriTurnRuntimeContext({
        controller,
        agentId: "agent-1",
        conversationId: "conv-1",
      });
      expect(runtime.toolExecutionControl).toBe(controller.runtimeControl);
      expect(runtime.permissionMode).toBe("standard");
      expect(runtime.conversationId).toBe("conv-1");

      const options = withSayuriTurnOptions(
        { skillSources: [] },
        {
          controller,
          agentId: "agent-1",
          conversationId: "conv-1",
        },
      );
      expect(options.workingDirectory).toBe(controller.scopeRoot);
      expect(options.agentId).toBe("agent-1");
      expect(options.runtimeContext?.toolExecutionControl).toBe(
        controller.runtimeControl,
      );
    } finally {
      rmSync(scopeRoot, { recursive: true, force: true });
    }
  });
});
