import { describe, expect, test } from "bun:test";
import { progressSayuriPlanFromVerifiedStep } from "./plan-progress";

describe("Sayuri deterministic plan progression", () => {
  test("completes the verified active step and unlocks a satisfied dependent", () => {
    const result = progressSayuriPlanFromVerifiedStep({
      plan: {
        id: "plan-progress",
        taskId: "task-progress",
        goal: "Progress safely",
        createdAt: "2026-10-06T10:40:00.000Z",
        steps: [
          {
            id: "inspect",
            title: "Inspect",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "write",
            title: "Write",
            status: "pending",
            risk: "project-mutation",
            requiresEvidence: true,
            dependsOnStepIds: ["inspect"],
          },
          {
            id: "verify",
            title: "Verify",
            status: "pending",
            risk: "system-mutation",
            requiresEvidence: true,
            dependsOnStepIds: ["write"],
          },
        ],
      },
      stepId: "inspect",
      receiptIds: ["receipt-inspect"],
    });

    expect(result.plan.steps[0]?.status).toBe("completed");
    expect(result.plan.steps[1]?.status).toBe("in-progress");
    expect(result.plan.steps[2]?.status).toBe("pending");
    expect(result.nextStep?.id).toBe("write");
    expect(result.planComplete).toBe(false);
  });

  test("attaches verified mutation evidence and detects completion", () => {
    const result = progressSayuriPlanFromVerifiedStep({
      plan: {
        id: "plan-progress",
        taskId: "task-progress",
        goal: "Finish safely",
        createdAt: "2026-10-06T10:40:00.000Z",
        steps: [
          {
            id: "write",
            title: "Write",
            status: "in-progress",
            risk: "project-mutation",
            requiresEvidence: true,
          },
        ],
      },
      stepId: "write",
      receiptIds: ["receipt-write", "receipt-write"],
    });

    expect(result.plan.steps[0]).toMatchObject({
      status: "completed",
      receiptIds: ["receipt-write"],
    });
    expect(result.nextStep).toBeNull();
    expect(result.planComplete).toBe(true);
  });

  test("does not unlock dependency-incomplete work", () => {
    const result = progressSayuriPlanFromVerifiedStep({
      plan: {
        id: "branch-plan",
        taskId: "branch-task",
        goal: "Respect dependencies",
        createdAt: "2026-10-06T10:40:00.000Z",
        steps: [
          {
            id: "first",
            title: "First",
            status: "in-progress",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "other",
            title: "Other prerequisite",
            status: "blocked",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "dependent",
            title: "Dependent",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
            dependsOnStepIds: ["first", "other"],
          },
        ],
      },
      stepId: "first",
      receiptIds: [],
    });

    expect(result.plan.steps[2]?.status).toBe("pending");
    expect(result.nextStep).toBeNull();
    expect(result.planComplete).toBe(false);
  });

  test("rejects mutation completion without evidence", () => {
    expect(() =>
      progressSayuriPlanFromVerifiedStep({
        plan: {
          id: "evidence-plan",
          taskId: "evidence-task",
          goal: "Require evidence",
          createdAt: "2026-10-06T10:40:00.000Z",
          steps: [
            {
              id: "write",
              title: "Write",
              status: "in-progress",
              risk: "project-mutation",
              requiresEvidence: true,
            },
          ],
        },
        stepId: "write",
        receiptIds: [],
      }),
    ).toThrow("requires verified evidence");
  });
});
