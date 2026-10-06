export type SayuriEvidenceKind =
  | "tool-result"
  | "file-change"
  | "external-response"
  | "test-result"
  | "memory-commit"
  | "user-confirmation";

export type SayuriEvidenceTrust = "direct" | "derived" | "reported";
export type SayuriEvidenceOutcome = "success" | "error" | "denied";

export type SayuriEvidenceMetadataValue =
  | string
  | number
  | boolean
  | null;

export interface SayuriEvidenceReceipt {
  id: string;
  executionId: string;
  taskId?: string;
  stepId?: string;
  kind: SayuriEvidenceKind;
  trust: SayuriEvidenceTrust;
  outcome: SayuriEvidenceOutcome;
  source: string;
  summary: string;
  createdAt: string;
  metadata?: Readonly<Record<string, SayuriEvidenceMetadataValue>>;
}

export function validateSayuriEvidenceReceipt(
  receipt: SayuriEvidenceReceipt,
): void {
  if (!receipt.id.trim()) throw new Error("Evidence receipt id is required.");
  if (!receipt.executionId.trim()) {
    throw new Error("Evidence execution id is required.");
  }
  if (!receipt.source.trim()) throw new Error("Evidence source is required.");
  if (!receipt.summary.trim()) throw new Error("Evidence summary is required.");
  if (Number.isNaN(Date.parse(receipt.createdAt))) {
    throw new Error("Evidence createdAt must be an ISO-compatible timestamp.");
  }
}

/**
 * Append-only evidence collection for one Sayuri runtime process.
 *
 * Durable stores may hydrate the ledger again after a restart; immutable
 * receipt IDs keep verification deterministic across process boundaries.
 */
export class SayuriEvidenceLedger {
  readonly #receipts = new Map<string, SayuriEvidenceReceipt>();

  append(receipt: SayuriEvidenceReceipt): void {
    validateSayuriEvidenceReceipt(receipt);
    if (this.#receipts.has(receipt.id)) {
      throw new Error(`Evidence receipt "${receipt.id}" already exists.`);
    }
    this.#receipts.set(receipt.id, { ...receipt });
  }

  get(receiptId: string): SayuriEvidenceReceipt | null {
    const receipt = this.#receipts.get(receiptId);
    return receipt ? { ...receipt } : null;
  }

  listForExecution(executionId: string): SayuriEvidenceReceipt[] {
    return [...this.#receipts.values()]
      .filter((receipt) => receipt.executionId === executionId)
      .map((receipt) => ({ ...receipt }));
  }

  snapshot(): SayuriEvidenceReceipt[] {
    return [...this.#receipts.values()].map((receipt) => ({ ...receipt }));
  }
}
