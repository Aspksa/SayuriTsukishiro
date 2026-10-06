import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import type { SayuriPlan } from "./planner";
import {
  type SayuriBrainStateSnapshot,
  type SayuriBrainStateStore,
  resolveSayuriStateRoot,
} from "./state-store";
import {
  isSayuriTaskStatus,
  isUnfinishedSayuriTaskStatus,
  type SayuriTaskState,
  type SayuriTaskStatus,
} from "./task-lifecycle";

export const SAYURI_TASK_REGISTRY_SCHEMA_VERSION = 1;

export interface SayuriProjectTaskEntry {
  projectId: string;
  taskId: string;
  planId: string;
  agentId: string;
  conversationId: string;
  goal: string;
  status: SayuriTaskStatus;
  revision: number;
  updatedAt: string;
  checkpointCount: number;
  latestCheckpointId?: string;
  nextAction?: string;
}

interface SayuriProjectTaskRegistryFile {
  schemaVersion: typeof SAYURI_TASK_REGISTRY_SCHEMA_VERSION;
  projectId: string;
  tasks: SayuriProjectTaskEntry[];
}

export interface SayuriTaskRegistry {
  upsertTask(entry: SayuriProjectTaskEntry): Promise<void>;
  getTask(
    projectId: string,
    taskId: string,
  ): Promise<SayuriProjectTaskEntry | null>;
  listProjectTasks(projectId: string): Promise<SayuriProjectTaskEntry[]>;
  findLatestUnfinished(
    projectId: string,
  ): Promise<SayuriProjectTaskEntry | null>;
}

function encodeId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return Buffer.from(normalized, "utf8").toString("base64url");
}

function validateEntry(entry: SayuriProjectTaskEntry): void {
  if (!entry.projectId.trim()) throw new Error("Registry projectId is required.");
  if (!entry.taskId.trim()) throw new Error("Registry taskId is required.");
  if (!entry.planId.trim()) throw new Error("Registry planId is required.");
  if (!entry.agentId.trim()) throw new Error("Registry agentId is required.");
  if (!entry.conversationId.trim()) {
    throw new Error("Registry conversationId is required.");
  }
  if (!entry.goal.trim()) throw new Error("Registry goal is required.");
  if (!isSayuriTaskStatus(entry.status)) {
    throw new Error(`Invalid registry task status "${String(entry.status)}".`);
  }
  if (!Number.isSafeInteger(entry.revision) || entry.revision < 0) {
    throw new Error("Registry revision must be a non-negative safe integer.");
  }
  if (Number.isNaN(Date.parse(entry.updatedAt))) {
    throw new Error("Registry updatedAt must be an ISO-compatible timestamp.");
  }
  if (
    !Number.isSafeInteger(entry.checkpointCount) ||
    entry.checkpointCount < 0
  ) {
    throw new Error(
      "Registry checkpointCount must be a non-negative safe integer.",
    );
  }
}

function taskEntryFromState(input: {
  projectId: string;
  agentId: string;
  conversationId: string;
  task: SayuriTaskState;
  plan: SayuriPlan;
}): SayuriProjectTaskEntry {
  const latest = input.task.checkpoints.at(-1);
  return {
    projectId: input.projectId,
    taskId: input.task.id,
    planId: input.plan.id,
    agentId: input.agentId,
    conversationId: input.conversationId,
    goal: input.task.goal,
    status: input.task.status,
    revision: input.task.revision,
    updatedAt: input.task.updatedAt,
    checkpointCount: input.task.checkpoints.length,
    ...(latest ? { latestCheckpointId: latest.id } : {}),
    ...(latest?.nextAction ? { nextAction: latest.nextAction } : {}),
  };
}

function sortNewestFirst(
  entries: readonly SayuriProjectTaskEntry[],
): SayuriProjectTaskEntry[] {
  return [...entries].sort((left, right) => {
    const timeOrder = right.updatedAt.localeCompare(left.updatedAt);
    return timeOrder !== 0 ? timeOrder : right.revision - left.revision;
  });
}

export class FileSayuriTaskRegistry implements SayuriTaskRegistry {
  readonly #root: string;

  constructor(root: string = resolveSayuriStateRoot()) {
    this.#root = root;
  }

  private projectDir(projectId: string): string {
    return join(this.#root, "projects", encodeId(projectId, "Project id"));
  }

  private registryPath(projectId: string): string {
    return join(this.projectDir(projectId), "tasks.json");
  }

  private lockPath(projectId: string): string {
    return join(this.projectDir(projectId), ".tasks.lock");
  }

  private async readRegistry(
    projectId: string,
  ): Promise<SayuriProjectTaskRegistryFile> {
    let raw: string;
    try {
      raw = await readFile(this.registryPath(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return {
          schemaVersion: SAYURI_TASK_REGISTRY_SCHEMA_VERSION,
          projectId,
          tasks: [],
        };
      }
      throw error;
    }

    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(
        `Sayuri task registry for project "${projectId}" is not valid JSON.`,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Sayuri task registry for project "${projectId}" is invalid.`);
    }
    const record = value as Partial<SayuriProjectTaskRegistryFile>;
    if (record.schemaVersion !== SAYURI_TASK_REGISTRY_SCHEMA_VERSION) {
      throw new Error("Unsupported Sayuri task registry schema.");
    }
    if (record.projectId !== projectId || !Array.isArray(record.tasks)) {
      throw new Error("Sayuri task registry project identity is invalid.");
    }
    for (const entry of record.tasks) validateEntry(entry);
    return {
      schemaVersion: SAYURI_TASK_REGISTRY_SCHEMA_VERSION,
      projectId,
      tasks: record.tasks,
    };
  }

  async upsertTask(entry: SayuriProjectTaskEntry): Promise<void> {
    validateEntry(entry);
    const directory = this.projectDir(entry.projectId);
    await mkdir(directory, { recursive: true });
    await withFileLock(
      this.lockPath(entry.projectId),
      async () => {
        const current = await this.readRegistry(entry.projectId);
        const tasks = current.tasks.filter(
          (candidate) => candidate.taskId !== entry.taskId,
        );
        tasks.push({ ...entry });
        const next: SayuriProjectTaskRegistryFile = {
          schemaVersion: SAYURI_TASK_REGISTRY_SCHEMA_VERSION,
          projectId: entry.projectId,
          tasks: sortNewestFirst(tasks),
        };
        const target = this.registryPath(entry.projectId);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify(next, null, 2)}\n`,
          "utf8",
        );
        await rename(temporary, target);
      },
      { reapOnlyDeadOwner: true },
    );
  }

  async getTask(
    projectId: string,
    taskId: string,
  ): Promise<SayuriProjectTaskEntry | null> {
    const registry = await this.readRegistry(projectId);
    return (
      registry.tasks.find((entry) => entry.taskId === taskId) ?? null
    );
  }

  async listProjectTasks(
    projectId: string,
  ): Promise<SayuriProjectTaskEntry[]> {
    const registry = await this.readRegistry(projectId);
    return sortNewestFirst(registry.tasks);
  }

  async findLatestUnfinished(
    projectId: string,
  ): Promise<SayuriProjectTaskEntry | null> {
    const entries = await this.listProjectTasks(projectId);
    return (
      entries.find((entry) => isUnfinishedSayuriTaskStatus(entry.status)) ??
      null
    );
  }
}

export class ProjectIndexedSayuriBrainStateStore
  implements SayuriBrainStateStore
{
  readonly #inner: SayuriBrainStateStore;
  readonly #registry: SayuriTaskRegistry;
  readonly #projectId: string;
  readonly #agentId: string;
  readonly #conversationId: string;

  constructor(input: {
    inner: SayuriBrainStateStore;
    registry: SayuriTaskRegistry;
    projectId: string;
    agentId: string;
    conversationId: string;
  }) {
    this.#inner = input.inner;
    this.#registry = input.registry;
    this.#projectId = input.projectId;
    this.#agentId = input.agentId;
    this.#conversationId = input.conversationId;
  }

  async saveSnapshot(task: SayuriTaskState, plan: SayuriPlan): Promise<void> {
    await this.#inner.saveSnapshot(task, plan);
    await this.#registry.upsertTask(
      taskEntryFromState({
        projectId: this.#projectId,
        agentId: this.#agentId,
        conversationId: this.#conversationId,
        task,
        plan,
      }),
    );
  }

  loadSnapshot(taskId: string): Promise<SayuriBrainStateSnapshot | null> {
    return this.#inner.loadSnapshot(taskId);
  }

  appendReceipt(
    taskId: string,
    receipt: Parameters<SayuriBrainStateStore["appendReceipt"]>[1],
  ): Promise<void> {
    return this.#inner.appendReceipt(taskId, receipt);
  }

  loadReceipts(
    taskId: string,
  ): ReturnType<SayuriBrainStateStore["loadReceipts"]> {
    return this.#inner.loadReceipts(taskId);
  }
}
