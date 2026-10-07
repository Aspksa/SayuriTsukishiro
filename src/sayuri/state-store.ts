import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import {
  type SayuriEvidenceReceipt,
  validateSayuriEvidenceReceipt,
} from "./evidence-ledger";
import { type SayuriPlan, validateSayuriPlan } from "./planner";
import {
  type SayuriTaskState,
  validateSayuriTaskState,
} from "./task-lifecycle";

export const SAYURI_BRAIN_STATE_SCHEMA_VERSION = 1;
export const SAYURI_STATE_DIR_ENV = "SAYURI_STATE_DIR";

export interface SayuriBrainStateSnapshot {
  schemaVersion: typeof SAYURI_BRAIN_STATE_SCHEMA_VERSION;
  task: SayuriTaskState;
  plan: SayuriPlan;
  updatedAt: string;
}

export interface SayuriBrainStateStore {
  saveSnapshot(task: SayuriTaskState, plan: SayuriPlan): Promise<void>;
  loadSnapshot(taskId: string): Promise<SayuriBrainStateSnapshot | null>;
  appendReceipt(taskId: string, receipt: SayuriEvidenceReceipt): Promise<void>;
  loadReceipts(taskId: string): Promise<SayuriEvidenceReceipt[]>;
}

export function resolveSayuriStateRoot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = homedir(),
): string {
  const configured = env[SAYURI_STATE_DIR_ENV]?.trim();
  return configured || join(homeDir, ".sayuri", "state");
}

function encodeTaskId(taskId: string): string {
  const normalized = taskId.trim();
  if (!normalized) throw new Error("Task id is required.");
  return Buffer.from(normalized, "utf8").toString("base64url");
}

function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be an ISO-compatible timestamp.`);
  }
  return value;
}

function parseSnapshot(taskId: string, raw: string): SayuriBrainStateSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Sayuri brain state for "${taskId}" is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Sayuri brain state for "${taskId}" is invalid.`);
  }

  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SAYURI_BRAIN_STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported Sayuri brain state schema "${String(record.schemaVersion)}".`,
    );
  }
  if (!record.task || typeof record.task !== "object") {
    throw new Error(`Persisted Sayuri task "${taskId}" is invalid.`);
  }
  if (!record.plan || typeof record.plan !== "object") {
    throw new Error(`Persisted Sayuri plan "${taskId}" is invalid.`);
  }

  const task = record.task as SayuriTaskState;
  const plan = record.plan as SayuriPlan;
  validateSayuriTaskState(task);
  const planValidation = validateSayuriPlan(plan);
  if (!planValidation.valid) {
    throw new Error(
      `Persisted Sayuri plan is invalid: ${planValidation.errors.join(" ")}`,
    );
  }
  if (task.id !== taskId || plan.taskId !== taskId) {
    throw new Error(
      `Persisted Sayuri state does not belong to task "${taskId}".`,
    );
  }

  return {
    schemaVersion: SAYURI_BRAIN_STATE_SCHEMA_VERSION,
    task,
    plan,
    updatedAt: parseIsoTimestamp(record.updatedAt, "State updatedAt"),
  };
}

function parseReceipts(taskId: string, raw: string): SayuriEvidenceReceipt[] {
  const receipts: SayuriEvidenceReceipt[] = [];
  const receiptIds = new Set<string>();

  for (const [index, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new Error(
        `Invalid Sayuri receipt JSON at line ${index + 1} for task "${taskId}".`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `Invalid Sayuri receipt at line ${index + 1} for task "${taskId}".`,
      );
    }
    const receipt = value as SayuriEvidenceReceipt;
    validateSayuriEvidenceReceipt(receipt);
    if (receipt.taskId !== taskId) {
      throw new Error(
        `Receipt "${receipt.id}" does not belong to task "${taskId}".`,
      );
    }
    if (receiptIds.has(receipt.id)) {
      throw new Error(`Duplicate persisted receipt id "${receipt.id}".`);
    }
    receiptIds.add(receipt.id);
    receipts.push(receipt);
  }

  return receipts;
}

export class FileSayuriBrainStateStore implements SayuriBrainStateStore {
  readonly #root: string;

  constructor(root: string = resolveSayuriStateRoot()) {
    this.#root = root;
  }

  private taskDir(taskId: string): string {
    return join(this.#root, "tasks", encodeTaskId(taskId));
  }

  private snapshotPath(taskId: string): string {
    return join(this.taskDir(taskId), "state.json");
  }

  private receiptsPath(taskId: string): string {
    return join(this.taskDir(taskId), "receipts.jsonl");
  }

  private lockPath(taskId: string): string {
    return join(this.taskDir(taskId), ".state.lock");
  }

  private async ensureTaskDir(taskId: string): Promise<void> {
    await mkdir(this.taskDir(taskId), { recursive: true });
  }

  async saveSnapshot(task: SayuriTaskState, plan: SayuriPlan): Promise<void> {
    validateSayuriTaskState(task);
    const planValidation = validateSayuriPlan(plan);
    if (!planValidation.valid) {
      throw new Error(
        `Cannot persist invalid Sayuri plan: ${planValidation.errors.join(" ")}`,
      );
    }
    if (plan.taskId !== task.id) {
      throw new Error("Plan taskId must match the persisted Sayuri task.");
    }

    await this.ensureTaskDir(task.id);
    await withFileLock(
      this.lockPath(task.id),
      async () => {
        const snapshot: SayuriBrainStateSnapshot = {
          schemaVersion: SAYURI_BRAIN_STATE_SCHEMA_VERSION,
          task,
          plan,
          updatedAt: new Date().toISOString(),
        };
        const target = this.snapshotPath(task.id);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(snapshot, null, 2)}\n`,
          "utf8",
        );
        await rename(temporary, target);
      },
      { reapOnlyDeadOwner: true },
    );
  }

  async loadSnapshot(taskId: string): Promise<SayuriBrainStateSnapshot | null> {
    try {
      const raw = await readFile(this.snapshotPath(taskId), "utf8");
      return parseSnapshot(taskId, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
      throw error;
    }
  }

  async appendReceipt(
    taskId: string,
    receipt: SayuriEvidenceReceipt,
  ): Promise<void> {
    validateSayuriEvidenceReceipt(receipt);
    if (receipt.taskId !== taskId) {
      throw new Error(
        `Receipt "${receipt.id}" must belong to task "${taskId}".`,
      );
    }

    await this.ensureTaskDir(taskId);
    await withFileLock(
      this.lockPath(taskId),
      async () => {
        const existing = await this.loadReceipts(taskId);
        const duplicate = existing.find((item) => item.id === receipt.id);
        if (duplicate) {
          if (JSON.stringify(duplicate) === JSON.stringify(receipt)) return;
          throw new Error(
            `Receipt id "${receipt.id}" already exists with different data.`,
          );
        }
        await appendFile(
          this.receiptsPath(taskId),
          `${JSON.stringify(receipt)}\n`,
          "utf8",
        );
      },
      { reapOnlyDeadOwner: true },
    );
  }

  async loadReceipts(taskId: string): Promise<SayuriEvidenceReceipt[]> {
    try {
      const raw = await readFile(this.receiptsPath(taskId), "utf8");
      return parseReceipts(taskId, raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }
  }
}
