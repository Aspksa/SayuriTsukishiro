import { describe, expect, test } from "bun:test";
import {
  assertSayuriSubagentLeaseBinding,
  createSayuriSubagentCapabilityLease,
} from "./subagent-lease";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

function runningTask() {
  let task = createSayuriTask({
    id: "parent-task",
    goal: "Delegate safely",
    now: "2026-10-06T11:40:00.000Z",
  });
  task = transitionSayuriTask(task, "planning", "2026-10-06T11:40:01.000Z");
  task = transitionSayuriTask(task, "ready", "2026-10-06T11:40:02.000Z");
  return transitionSayuriTask(task, "running", "2026-10-06T11:40:03.000Z");
}

const plan = {
  id: "parent-plan",
  taskId: "parent-task",
  goal: "Delegate safely",
  createdAt: "2026-10-06T11:40:00.000Z",
  steps: [
    {
      id: "delegate",
      title: "Delegate analysis",
      status: "in-progress" as const,
      risk: "read" as const,
      requiresEvidence: false,
    },
  ],
};

describe("Sayuri subagent capability leases", () => {
  test("accepts explicit read-only capabilities bound to the active parent step", () => {
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-read",
      parentTaskId: "parent-task",
      parentPlanId: "parent-plan",
      parentStepId: "delegate",
      subagentId: "child-1",
      subagentType: "general-purpose",
      allowedTools: ["Read", "Grep"],
      scopeRoot: "/workspace",
      issuedAt: "2026-10-06T11:40:04.000Z",
      expiresAt: "2026-10-06T12:40:04.000Z",
    });
    expect(() =>
      assertSayuriSubagentLeaseBinding({
        lease,
        task: runningTask(),
        plan,
        now: "2026-10-06T11:41:00.000Z",
      }),
    ).not.toThrow();
  });

  test("rejects mutation authority from a read-only lease", () => {
    expect(() =>
      createSayuriSubagentCapabilityLease({
        parentTaskId: "parent-task",
        parentPlanId: "parent-plan",
        parentStepId: "delegate",
        subagentId: "child-2",
        subagentType: "general-purpose",
        allowedTools: ["Read", "Write"],
        scopeRoot: "/workspace",
      }),
    ).toThrow("Read-only subagent lease cannot grant");
  });

  test("scoped mutation leases still reject shell, lifecycle and destructive tools", () => {
    for (const tool of ["Bash", "TaskUpdate", "TaskStop"]) {
      expect(() =>
        createSayuriSubagentCapabilityLease({
          parentTaskId: "parent-task",
          parentPlanId: "parent-plan",
          parentStepId: "delegate",
          subagentId: `child-${tool}`,
          subagentType: "general-purpose",
          mode: "scoped-project-mutation",
          allowedTools: ["Read", tool],
          scopeRoot: "/workspace",
        }),
      ).toThrow("Scoped subagent lease cannot grant");
    }
  });

  test("rejects stale leases and non-active parent steps", () => {
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-stale",
      parentTaskId: "parent-task",
      parentPlanId: "parent-plan",
      parentStepId: "delegate",
      subagentId: "child-stale",
      subagentType: "general-purpose",
      allowedTools: ["Read"],
      scopeRoot: "/workspace",
      issuedAt: "2026-10-06T11:40:00.000Z",
      expiresAt: "2026-10-06T11:41:00.000Z",
    });
    expect(() =>
      assertSayuriSubagentLeaseBinding({
        lease,
        task: runningTask(),
        plan,
        now: "2026-10-06T11:42:00.000Z",
      }),
    ).toThrow("expired");
  });
});
