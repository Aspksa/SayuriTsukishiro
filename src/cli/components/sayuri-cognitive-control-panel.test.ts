import { describe, expect, test } from "bun:test";
import type { SayuriCognitiveControlSnapshot } from "@/sayuri/control-plane";
import { buildSayuriCognitiveControlView } from "./SayuriCognitiveControlPanel";

function snapshot(
  status: "waiting-user" | "running" | "completed",
): SayuriCognitiveControlSnapshot {
  return {
    projectId: "project-a",
    tasks: [],
    selectedTask: {
      task: {
        id: "task-1",
        goal: "Ship cognitive UI",
        status,
        revision: 7,
        createdAt: "2026-10-07T04:00:00.000Z",
        updatedAt: "2026-10-07T04:01:00.000Z",
        checkpoints: [],
      },
      plan: {
        id: "plan-1",
        taskId: "task-1",
        goal: "Ship cognitive UI",
        createdAt: "2026-10-07T04:00:00.000Z",
        steps: [
          {
            id: "step-1",
            title: "Build projection",
            status: "completed",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "step-2",
            title: "Render panel",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "step-3",
            title: "Wire actions",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "step-4",
            title: "Hidden by maxItems",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
          },
        ],
      },
      updatedAt: "2026-10-07T04:01:00.000Z",
    },
    background: [
      {
        id: "lease-1",
        projectId: "project-a",
        ownerAgentId: "agent-1",
        ownerConversationId: "default",
        lease: {
          id: "lease-1",
          parentTaskId: "task-1",
          parentPlanId: "plan-1",
          parentStepId: "step-2",
          subagentId: "child-1",
          subagentType: "general-purpose",
          mode: "read-only",
          allowedTools: ["Read"],
          scopeRoot: "/workspace",
          issuedAt: "2026-10-07T04:00:00.000Z",
        },
        status: "running",
        createdAt: "2026-10-07T04:00:00.000Z",
        updatedAt: "2026-10-07T04:01:00.000Z",
        deadlineAt: "2099-10-07T05:00:00.000Z",
        assignment: "Inspect tests",
      },
      {
        id: "lease-2",
        projectId: "project-a",
        ownerAgentId: "agent-1",
        ownerConversationId: "default",
        lease: {
          id: "lease-2",
          parentTaskId: "task-1",
          parentPlanId: "plan-1",
          parentStepId: "step-1",
          subagentId: "child-2",
          subagentType: "general-purpose",
          mode: "read-only",
          allowedTools: ["Read"],
          scopeRoot: "/workspace",
          issuedAt: "2026-10-07T03:00:00.000Z",
        },
        status: "completed",
        createdAt: "2026-10-07T03:00:00.000Z",
        updatedAt: "2026-10-07T03:30:00.000Z",
        deadlineAt: "2099-10-07T05:00:00.000Z",
        resultReceiptId: "receipt-1",
      },
    ],
    cronIntents: [
      {
        id: "cron-1",
        projectId: "project-a",
        sourceCronTaskId: "source-1",
        sourceAgentId: "agent-1",
        sourceConversationId: "default",
        intendedOccurrence: "2026-10-08T04:00:00.000Z",
        objective: "Scheduled work",
        title: "Nightly review",
        priority: 50,
        constraints: [],
        successCriteria: [],
        status: "pending",
        createdAt: "2026-10-07T04:00:00.000Z",
        updatedAt: "2026-10-07T04:00:00.000Z",
      },
    ],
  };
}

describe("Sayuri Cognitive Control panel projection", () => {
  test("shows bounded plan/background/cron state and enables waiting-user actions", () => {
    const view = buildSayuriCognitiveControlView(snapshot("waiting-user"), 3);
    expect(view.task).toMatchObject({
      id: "task-1",
      status: "waiting-user",
      revision: 7,
    });
    expect(view.planSteps.map((step) => step.id)).toEqual([
      "step-1",
      "step-2",
      "step-3",
    ]);
    expect(view.activeBackground).toEqual([
      { id: "lease-1", status: "running", label: "Inspect tests" },
    ]);
    expect(view.pendingCronIntents).toEqual([
      { id: "cron-1", title: "Nightly review" },
    ]);
    expect(view.canConfirm).toBe(true);
    expect(view.canCancel).toBe(true);
  });

  test("never exposes confirm/cancel for a terminal task", () => {
    const view = buildSayuriCognitiveControlView(snapshot("completed"));
    expect(view.canConfirm).toBe(false);
    expect(view.canCancel).toBe(false);
  });

  test("running work may be cancelled but cannot be user-confirmed", () => {
    const view = buildSayuriCognitiveControlView(snapshot("running"));
    expect(view.canConfirm).toBe(false);
    expect(view.canCancel).toBe(true);
  });
});
