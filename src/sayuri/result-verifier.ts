import type {
  SayuriEvidenceReceipt,
  SayuriEvidenceTrust,
} from "./evidence-ledger";
import { SayuriEvidenceLedger } from "./evidence-ledger";

export type SayuriVerificationVerdict =
  | "verified"
  | "insufficient-evidence"
  | "failed";

export interface SayuriVerificationRequest {
  executionId: string;
  receiptIds: readonly string[];
  minimumTrust?: SayuriEvidenceTrust;
}

export interface SayuriVerificationResult {
  verdict: SayuriVerificationVerdict;
  reason: string;
  receipts: readonly SayuriEvidenceReceipt[];
}

const TRUST_RANK: Readonly<Record<SayuriEvidenceTrust, number>> = {
  reported: 0,
  derived: 1,
  direct: 2,
};

export function verifySayuriResult(
  request: SayuriVerificationRequest,
  ledger: SayuriEvidenceLedger,
): SayuriVerificationResult {
  if (!request.executionId.trim()) {
    return {
      verdict: "insufficient-evidence",
      reason: "Execution id is required.",
      receipts: [],
    };
  }
  if (request.receiptIds.length === 0) {
    return {
      verdict: "insufficient-evidence",
      reason: "No evidence receipts were supplied.",
      receipts: [],
    };
  }

  const receipts: SayuriEvidenceReceipt[] = [];
  for (const receiptId of request.receiptIds) {
    const receipt = ledger.get(receiptId);
    if (!receipt) {
      return {
        verdict: "insufficient-evidence",
        reason: `Evidence receipt "${receiptId}" was not found.`,
        receipts,
      };
    }
    if (receipt.executionId !== request.executionId) {
      return {
        verdict: "failed",
        reason: `Evidence receipt "${receiptId}" belongs to another execution.`,
        receipts: [...receipts, receipt],
      };
    }
    receipts.push(receipt);
  }

  const unsuccessful = receipts.find((receipt) => receipt.outcome !== "success");
  if (unsuccessful) {
    return {
      verdict: "failed",
      reason: `Evidence receipt "${unsuccessful.id}" is ${unsuccessful.outcome}.`,
      receipts,
    };
  }

  const minimumTrust = request.minimumTrust ?? "direct";
  const requiredRank = TRUST_RANK[minimumTrust];
  if (!receipts.some((receipt) => TRUST_RANK[receipt.trust] >= requiredRank)) {
    return {
      verdict: "insufficient-evidence",
      reason: `No receipt meets minimum trust "${minimumTrust}".`,
      receipts,
    };
  }

  return {
    verdict: "verified",
    reason: "Execution is supported by successful evidence receipts.",
    receipts,
  };
}
