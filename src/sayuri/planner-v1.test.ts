import { describe, expect, test } from "bun:test";
import type { SayuriPlannerSeed } from "./goal-manager";
import {
  buildSayuriPlannerV1Prompt,
  compileSayuriPlannerV1Plan,
  parseSayuriPlannerV1Proposal,
} from "./planner-v1";

const seed: SayuriPlannerSeed = {
  taskId: "task-planner",
  projectId: "project-main",
  goalId: "goal-planner",
  goal: "Improve Sayuri safely",
  constraints: ["Do not bypass Action Broker"],
  successCriteria: ["Tests pass"],
};

describe("Sayuri Planner v1 proposal boundary", () => {
  test("rejects model attempts to grant itself authority", () => {
    expect(() =>
      parseSayuriPlannerV1Proposal(
        {
          taskId: seed.taskId,
          goalId: seed.goalId,
          steps: [
            {
              id: "step-1",
              title: "Write",
              intent: "Modify a file",
              toolName: "Write",
              risk: "read",
              approvalGranted: true,
            },
          ],
        },
        seed,
      ),
    ).toThrow("authority field");
  });

  test("assigns risk and evidence deterministically from the intended tool", () => {
    const proposal = parseSayuriPlannerV1Proposal(
      {
        taskId: seed.taskId,
        goalId: seed.goalId,
        steps: [
          {
            id: "inspect",
            title: "Inspect",
            intent: "Read the implementation",
            toolName: "Read",
          },
          {
            id: "change",
            title: "Change",
            intent: "Write the verified change",
            toolName: "Write",
            dependsOnStepIds: ["inspect"],
          },
          {
            id: "verify",
            title: "Verify",
            intent: "Run the test suite",
            toolName: "Bash",
            dependsOnStepIds: ["change"],
          },
        ],
      },
      seed,
    );

    const plan = compileSayuriPlannerV1Plan({
      seed,
      proposal,
      planId: "plan-v1",
      createdAt: "2026-10-06T10:10:00.000Z",
    });

    expect(plan.steps).toEqual([
      expect.objectContaining({
        id: "inspect",
        status: "in-progress",
        risk: "read",
        requiresEvidence: false,
        toolName: "Read",
      }),
      expect.objectContaining({
        id: "change",
        status: "pending",
        risk: "project-mutation",
        requiresEvidence: true,
        toolName: "Write",
      }),
      expect.objectContaining({
        id: "verify",
        status: "pending",
        risk: "system-mutation",
        requiresEvidence: true,
        toolName: "Bash",
      }),
    ]);
  });

  test("rejects forward dependencies and tells the model only to propose", () => {
    expect(() =>
      parseSayuriPlannerV1Proposal(
        {
          taskId: seed.taskId,
          goalId: seed.goalId,
          steps: [
            {
              id: "second-first",
              title: "Bad dependency",
              intent: "Reference the future",
              dependsOnStepIds: ["later"],
            },
            {
              id: "later",
              title: "Later",
              intent: "Future step",
            },
          ],
        },
        seed,
      ),
    ).toThrow("earlier step");

    const prompt = buildSayuriPlannerV1Prompt(seed);
    expect(prompt).toContain("Never output permissions");
    expect(prompt).toContain("Return JSON only");
    expect(prompt).toContain(seed.goalId);
  });
});
