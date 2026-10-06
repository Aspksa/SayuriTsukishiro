import { describe, expect, test } from "bun:test";
import { SayuriEvidenceLedger } from "./evidence-ledger";
import { evaluateSayuriCompletionGate } from "./completion-gate";

describe("Sayuri Completion Gate", () => {
  test("accepts a terminal plan only with direct successful evidence for evidence steps", () => {
    const ledger = new SayuriEvidenceLedger();
    ledger.append({
      id: "receipt-write",
      executionId: "exec-write",
      taskId: "task-complete",
      stepId: "write",
      kind: "file-change",
      trust: "direct",
      outcome: "success",
      source: "builtin:Write",
      summary: "Write succeeded.",
      createdAt: "2026-10-06T10:50:00.000Z",
    });

    const result = evaluateSayuriCompletionGate(
      {
        id: "complete-plan",
        taskId: "task-complete",
        goal: "Finish safely",
        createdAt: "2026-10-06T10:49:00.000Z",
        steps: [
          {
            id: "inspect",
            title: "Inspect",
            status: "completed",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "write",
            title: "Write",
            status: "completed",
            risk: "project-mutation",
            requiresEvidence: true,
            receiptIds: ["receipt-write"],
          },
        ],
      },
      ledger,
    );

    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.evidence.map((receipt) => receipt.id)).toEqual([
      "receipt-write",
    ]);
  });

  test("rejects nonterminal work and missing/mismatched evidence", () => {
    const ledger = new SayuriEvidenceLedger();
    ledger.append({
      id: "receipt-wrong-step",
      executionId: "exec-write",
      taskId: "task-complete",
      stepId: "other",
      kind: "file-change",
      trust: "direct",
      outcome: "success",
      source: "builtin:Write",
      summary: "Wrong step.",
      createdAt: "2026-10-06T10:50:00.000Z",
    });

    const result = evaluateSayuriCompletionGate(
      {
        id: "incomplete-plan",
        taskId: "task-complete",
        goal: "Do not finish early",
        createdAt: "2026-10-06T10:49:00.000Z",
        steps: [
          {
            id: "pending",
            title: "Pending",
            status: "pending",
            risk: "read",
            requiresEvidence: false,
          },
          {
            id: "write",
            title: "Write",
            status: "completed",
            risk: "project-mutation",
            requiresEvidence: true,
            receiptIds: ["receipt-wrong-step"],
          },
        ],
      },
      ledger,
    );

    expect(result.ready).toBe(false);
    expect(result.reasons.join("\n")).toContain("not terminal");
    expect(result.reasons.join("\n")).toContain("not bound");
  });
});
