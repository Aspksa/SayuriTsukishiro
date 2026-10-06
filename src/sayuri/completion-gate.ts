import type {
  SayuriEvidenceReceipt,
} from "./evidence-ledger";
import { SayuriEvidenceLedger } from "./evidence-ledger";
import type { SayuriPlan } from "./planner";
import { validateSayuriPlan } from "./planner";

export interface SayuriCompletionGateResult {
  ready: boolean;
  reasons: readonly string[];
  evidence: readonly SayuriEvidenceReceipt[];
}

export function evaluateSayuriCompletionGate(
  plan: SayuriPlan,
  ledger: SayuriEvidenceLedger,
): SayuriCompletionGateResult {
  const reasons: string[] = [];
  const evidence: SayuriEvidenceReceipt[] = [];
  const validation = validateSayuriPlan(plan);
  if (!validation.valid) {
    return {
      ready: false,
      reasons: validation.errors.map((error) => `Invalid plan: ${error}`),
      evidence,
    };
  }

  for (const step of plan.steps) {
    if (step.status !== "completed" && step.status !== "cancelled") {
      reasons.push(
        `Plan step "${step.id}" is not terminal: ${step.status}.`,
      );
      continue;
    }
    if (step.status === "cancelled" || !step.requiresEvidence) continue;

    if (!step.receiptIds || step.receiptIds.length === 0) {
      reasons.push(`Plan step "${step.id}" has no evidence receipts.`);
      continue;
    }

    let hasDirectSuccess = false;
    for (const receiptId of step.receiptIds) {
      const receipt = ledger.get(receiptId);
      if (!receipt) {
        reasons.push(
          `Plan step "${step.id}" references missing receipt "${receiptId}".`,
        );
        continue;
      }
      evidence.push(receipt);
      if (receipt.taskId !== plan.taskId) {
        reasons.push(
          `Receipt "${receipt.id}" belongs to another task.`,
        );
      }
      if (receipt.stepId !== step.id) {
        reasons.push(
          `Receipt "${receipt.id}" is not bound to plan step "${step.id}".`,
        );
      }
      if (receipt.outcome !== "success") {
        reasons.push(
          `Receipt "${receipt.id}" is not successful: ${receipt.outcome}.`,
        );
      }
      if (receipt.outcome === "success" && receipt.trust === "direct") {
        hasDirectSuccess = true;
      }
    }
    if (!hasDirectSuccess) {
      reasons.push(
        `Plan step "${step.id}" lacks direct successful evidence.`,
      );
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    evidence,
  };
}
