import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import type { SayuriEvidenceReceipt } from "./evidence-ledger";
import { resolveSayuriStateRoot } from "./state-store";
import {
  type SayuriSubagentCapabilityLease,
  validateSayuriSubagentCapabilityLease,
} from "./subagent-lease";

export type SayuriBackgroundLeaseStatus =
  | "leased"
  | "running"
  | "orphaned"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "handed-off";

export interface SayuriBackgroundLeaseRecord {
  id: string;
  projectId: string;
  ownerAgentId: string;
  ownerConversationId: string;
  lease: SayuriSubagentCapabilityLease;
  status: SayuriBackgroundLeaseStatus;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  assignment?: string;
  resultReceipt?: SayuriEvidenceReceipt;
  error?: string;
  handoffAt?: string;
}

interface SayuriBackgroundLeaseFile {
  schemaVersion: 1;
  projectId: string;
  records: SayuriBackgroundLeaseRecord[];
}

function encodeProjectId(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new Error("Background lease projectId is required.");
  return Buffer.from(value, "utf8").toString("base64url");
}

function validateTimestamp(value: string, label: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} must be ISO-compatible.`);
  }
}

export function validateSayuriBackgroundLeaseRecord(
  record: SayuriBackgroundLeaseRecord,
): void {
  for (const [label, value] of [
    ["id", record.id],
    ["projectId", record.projectId],
    ["ownerAgentId", record.ownerAgentId],
    ["ownerConversationId", record.ownerConversationId],
  ] as const) {
    if (!value.trim())
      throw new Error(`Background lease ${label} is required.`);
  }
  if (record.assignment !== undefined && !record.assignment.trim()) {
    throw new Error(
      "Background lease assignment must be non-empty when present.",
    );
  }
  if (record.id !== record.lease.id) {
    throw new Error(
      "Background lease record id must match capability lease id.",
    );
  }
  validateTimestamp(record.createdAt, "Background lease createdAt");
  validateTimestamp(record.updatedAt, "Background lease updatedAt");
  validateTimestamp(record.deadlineAt, "Background lease deadlineAt");
  if (Date.parse(record.deadlineAt) <= Date.parse(record.createdAt)) {
    throw new Error("Background lease deadline must be after creation.");
  }
  if (
    record.lease.expiresAt &&
    Date.parse(record.deadlineAt) > Date.parse(record.lease.expiresAt)
  ) {
    throw new Error(
      "Background deadline cannot outlive capability lease expiry.",
    );
  }
  if (record.status === "completed" && !record.resultReceipt) {
    throw new Error("Completed background lease requires a result receipt.");
  }
  if (record.status === "failed" && !record.error?.trim()) {
    throw new Error("Failed background lease requires an error.");
  }
  if (record.status === "handed-off" && !record.handoffAt) {
    throw new Error("Handed-off background lease requires handoffAt.");
  }
}

export function createSayuriBackgroundLeaseRecord(input: {
  projectId: string;
  ownerAgentId: string;
  ownerConversationId: string;
  lease: SayuriSubagentCapabilityLease;
  deadlineAt: string;
  assignment?: string;
  now?: string;
}): SayuriBackgroundLeaseRecord {
  const now = input.now ?? new Date().toISOString();
  validateSayuriSubagentCapabilityLease(input.lease, now);
  const record: SayuriBackgroundLeaseRecord = {
    id: input.lease.id,
    projectId: input.projectId.trim(),
    ownerAgentId: input.ownerAgentId.trim(),
    ownerConversationId: input.ownerConversationId.trim(),
    lease: input.lease,
    status: "leased",
    createdAt: now,
    updatedAt: now,
    deadlineAt: input.deadlineAt,
    ...(input.assignment ? { assignment: input.assignment } : {}),
  };
  validateSayuriBackgroundLeaseRecord(record);
  return record;
}

export function transitionSayuriBackgroundLease(
  record: SayuriBackgroundLeaseRecord,
  next: SayuriBackgroundLeaseStatus,
  input: {
    now?: string;
    resultReceipt?: SayuriEvidenceReceipt;
    error?: string;
  } = {},
): SayuriBackgroundLeaseRecord {
  const allowed: Readonly<
    Record<SayuriBackgroundLeaseStatus, readonly SayuriBackgroundLeaseStatus[]>
  > = {
    leased: ["running", "cancelled", "expired"],
    running: ["completed", "failed", "cancelled", "expired", "orphaned"],
    orphaned: ["running", "cancelled", "expired"],
    completed: ["handed-off"],
    failed: [],
    cancelled: [],
    expired: [],
    "handed-off": [],
  };
  if (!allowed[record.status].includes(next)) {
    throw new Error(
      `Invalid background lease transition ${record.status} -> ${next}.`,
    );
  }
  const updated: SayuriBackgroundLeaseRecord = {
    ...record,
    status: next,
    updatedAt: input.now ?? new Date().toISOString(),
    ...(next === "completed" && input.resultReceipt
      ? { resultReceipt: input.resultReceipt }
      : {}),
    ...(next === "failed"
      ? { error: input.error?.trim() || "Background subagent failed." }
      : {}),
    ...(next === "handed-off"
      ? { handoffAt: input.now ?? new Date().toISOString() }
      : {}),
  };
  validateSayuriBackgroundLeaseRecord(updated);
  return updated;
}

export interface SayuriBackgroundLeaseStore {
  save(record: SayuriBackgroundLeaseRecord): Promise<void>;
  get(
    projectId: string,
    leaseId: string,
  ): Promise<SayuriBackgroundLeaseRecord | null>;
  list(projectId: string): Promise<SayuriBackgroundLeaseRecord[]>;
}

export class FileSayuriBackgroundLeaseStore
  implements SayuriBackgroundLeaseStore
{
  readonly #root: string;

  constructor(root: string = resolveSayuriStateRoot()) {
    this.#root = root;
  }

  private projectDir(projectId: string): string {
    return join(this.#root, "projects", encodeProjectId(projectId));
  }

  private filePath(projectId: string): string {
    return join(this.projectDir(projectId), "background-leases.json");
  }

  private lockPath(projectId: string): string {
    return join(this.projectDir(projectId), ".background-leases.lock");
  }

  private async read(projectId: string): Promise<SayuriBackgroundLeaseFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { schemaVersion: 1, projectId, records: [] };
      }
      throw error;
    }
    const value = JSON.parse(raw) as SayuriBackgroundLeaseFile;
    if (
      value.schemaVersion !== 1 ||
      value.projectId !== projectId ||
      !Array.isArray(value.records)
    ) {
      throw new Error(
        "Background lease store schema/project identity is invalid.",
      );
    }
    for (const record of value.records)
      validateSayuriBackgroundLeaseRecord(record);
    return value;
  }

  async save(record: SayuriBackgroundLeaseRecord): Promise<void> {
    validateSayuriBackgroundLeaseRecord(record);
    const dir = this.projectDir(record.projectId);
    await mkdir(dir, { recursive: true });
    await withFileLock(
      this.lockPath(record.projectId),
      async () => {
        const current = await this.read(record.projectId);
        const records = current.records.filter((item) => item.id !== record.id);
        records.push(record);
        records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const target = this.filePath(record.projectId);
        const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          temp,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              projectId: record.projectId,
              records,
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await rename(temp, target);
      },
      { reapOnlyDeadOwner: true },
    );
  }

  async get(
    projectId: string,
    leaseId: string,
  ): Promise<SayuriBackgroundLeaseRecord | null> {
    return (
      (await this.read(projectId)).records.find(
        (record) => record.id === leaseId,
      ) ?? null
    );
  }

  async list(projectId: string): Promise<SayuriBackgroundLeaseRecord[]> {
    return [...(await this.read(projectId)).records];
  }
}

export async function recoverSayuriBackgroundLeases(input: {
  projectId: string;
  store: SayuriBackgroundLeaseStore;
  now?: string;
  isLive?: (leaseId: string) => boolean;
}): Promise<SayuriBackgroundLeaseRecord[]> {
  const now = input.now ?? new Date().toISOString();
  const records = await input.store.list(input.projectId);
  const recovered: SayuriBackgroundLeaseRecord[] = [];
  for (const record of records) {
    let next = record;
    if (
      ["leased", "running", "orphaned"].includes(record.status) &&
      Date.parse(record.deadlineAt) <= Date.parse(now)
    ) {
      next = transitionSayuriBackgroundLease(record, "expired", { now });
    } else if (
      record.status === "running" &&
      !(input.isLive?.(record.id) ?? false)
    ) {
      next = transitionSayuriBackgroundLease(record, "orphaned", { now });
    }
    if (next !== record) await input.store.save(next);
    recovered.push(next);
  }
  return recovered;
}
