import { describe, expect, test } from "bun:test";
import {
  checkpointSayuriTask,
  createSayuriModelGatewayConfig,
  createSayuriTask,
  decideSayuriAction,
  SayuriEvidenceLedger,
  transitionSayuriTask,
  validateSayuriPlan,
  verifySayuriResult,
} from "./index";

describe("Sayuri Cognitive Core foundation", () => {
  test("locks the external model route to Cloud.ru DeepSeek-V4-Flash", () => {
    const config = createSayuriModelGatewayConfig({
      baseUrl: "https://example.cloud.ru/v1/",
      apiKey: "secret-key-value",
    });

    expect(config.provider).toBe("cloud.ru");
    expect(config.model).toBe("DeepSeek-V4-Flash");
    expect(config.baseUrl).toBe("https://example.cloud.ru/v1");
    expect(config.allowFallbacks).toBe(false);

    expect(() =>
      createSayuriModelGatewayConfig({
        baseUrl: "https://example.cloud.ru/v1",
        apiKey: "secret",
        model: "DeepSeek-V4-Pro",
      }),
    ).toThrow("DeepSeek-V4-Flash");
    expect(() =>
      createSayuriModelGatewayConfig({
        baseUrl: "https://example.cloud.ru/v1",
        apiKey: "secret",
        allowFallbacks: true,
      }),
    ).toThrow("fallbacks");
  });

  test("allows reads but places mutations behind task, plan, scope, and approval", () => {
    expect(
      decideSayuriAction({
        toolName: "Read",
        risk: "read",
        planned: false,
        scopeApproved: true,
      }).decision,
    ).toBe("allow");

    expect(
      decideSayuriAction({
        toolName: "Edit",
        risk: "project-mutation",
        planned: true,
        scopeApproved: true,
      }).decision,
    ).toBe("deny");

    expect(
      decideSayuriAction({
        toolName: "Edit",
        risk: "project-mutation",
        taskId: "task-1",
        planned: true,
        scopeApproved: true,
      }).decision,
    ).toBe("ask");

    expect(
      decideSayuriAction({
        toolName: "Edit",
        risk: "project-mutation",
        taskId: "task-1",
        planned: true,
        scopeApproved: true,
        approvalGranted: true,
      }).decision,
    ).toBe("allow");
  });

  test("enforces task lifecycle transitions and evidence-aware checkpoints", () => {
    let task = createSayuriTask({
      id: "task-1",
      goal: "Build Sayuri Cognitive Core",
      now: "2026-10-06T07:00:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T07:01:00.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T07:02:00.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T07:03:00.000Z");
    task = checkpointSayuriTask(task, {
      id: "checkpoint-1",
      createdAt: "2026-10-06T07:04:00.000Z",
      summary: "Foundation modules created.",
      nextAction: "Integrate Action Broker with the tool execution boundary.",
      verifiedReceiptIds: ["receipt-1"],
    });

    expect(task.status).toBe("checkpointed");
    expect(task.revision).toBe(4);
    expect(task.checkpoints).toHaveLength(1);
    expect(() => transitionSayuriTask(task, "completed")).toThrow(
      "checkpointed -> completed",
    );
  });

  test("rejects mutation plans that do not demand evidence", () => {
    const validation = validateSayuriPlan({
      id: "plan-1",
      taskId: "task-1",
      goal: "Secure tool execution",
      createdAt: "2026-10-06T07:00:00.000Z",
      steps: [
        {
          id: "step-1",
          title: "Patch permission boundary",
          status: "pending",
          risk: "project-mutation",
          requiresEvidence: false,
        },
      ],
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.join("\n")).toContain(
      "must require execution evidence",
    );
  });

  test("verifies execution only from successful receipts with sufficient trust", () => {
    const ledger = new SayuriEvidenceLedger();
    ledger.append({
      id: "receipt-1",
      executionId: "exec-1",
      taskId: "task-1",
      stepId: "step-1",
      kind: "test-result",
      trust: "direct",
      outcome: "success",
      source: "bun test",
      summary: "Focused cognitive-core tests passed.",
      createdAt: "2026-10-06T07:05:00.000Z",
    });

    expect(
      verifySayuriResult(
        { executionId: "exec-1", receiptIds: ["receipt-1"] },
        ledger,
      ).verdict,
    ).toBe("verified");

    expect(
      verifySayuriResult(
        { executionId: "exec-2", receiptIds: ["receipt-1"] },
        ledger,
      ).verdict,
    ).toBe("failed");
  });
});
