import { describe, expect, test } from "bun:test";

const { runSayuriLeasedSubagent } = await import("./subagent-runtime");
const { createSayuriSubagentCapabilityLease } = await import(
  "./subagent-lease"
);
const { createSayuriTask, transitionSayuriTask } = await import(
  "./task-lifecycle"
);

describe("Sayuri leased subagent runtime", () => {
  test("forces exact Sayuri model and returns parent-bound evidence", async () => {
    let task = createSayuriTask({
      id: "parent-task",
      goal: "Delegate safely",
      now: "2026-10-06T11:42:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T11:42:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T11:42:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T11:42:03.000Z");
    const plan = {
      id: "parent-plan",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T11:42:00.000Z",
      steps: [
        {
          id: "delegate",
          title: "Delegate",
          status: "in-progress" as const,
          risk: "read" as const,
          requiresEvidence: false,
        },
      ],
    };
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-runtime",
      parentTaskId: task.id,
      parentPlanId: plan.id,
      parentStepId: "delegate",
      subagentId: "child-runtime",
      subagentType: "general-purpose",
      allowedTools: ["Read", "Grep"],
      scopeRoot: "/workspace",
      issuedAt: "2026-10-06T11:42:04.000Z",
    });

    const output = await runSayuriLeasedSubagent({
      lease,
      task,
      plan,
      prompt: "Inspect safely.",
      spawnSubagent: async (input) => ({
        agentId: "child-agent",
        conversationId: "child-conversation",
        report: `tools=${input.allowedTools.join(",")};model=${input.model}`,
        success: true,
      }),
      now: "2026-10-06T11:42:05.000Z",
    });

    expect(output.result.report).toContain(
      "model=openai-compatible/DeepSeek-V4-Flash",
    );
    expect(output.receipt).toMatchObject({
      taskId: task.id,
      stepId: "delegate",
      trust: "derived",
      outcome: "success",
      metadata: {
        leaseId: "lease-runtime",
        subagentId: "child-runtime",
        toolCount: 2,
      },
    });
  });
});
