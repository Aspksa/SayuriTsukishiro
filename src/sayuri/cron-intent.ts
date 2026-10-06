import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { registerScheduledTaskAdmissionHandler } from "@/cron/scheduled-admission";
import type { ScheduledTaskAdmissionInput } from "@/cron/scheduled-admission";
import { withFileLock } from "@/utils/file-lock";
import {
  FileSayuriGoalStore,
  type SayuriGoalStore,
} from "./goal-manager";
import { resolveSayuriStateRoot } from "./state-store";
import {
  FileSayuriTaskRegistry,
  type SayuriTaskRegistry,
} from "./task-registry";
import { isUnfinishedSayuriTaskStatus } from "./task-lifecycle";

const OPEN = "<sayuri-work-intent>";
const CLOSE = "</sayuri-work-intent>";

export interface SayuriCronIntentSpec {
  projectId: string;
  objective: string;
  title?: string;
  priority?: number;
  constraints?: readonly string[];
  successCriteria?: readonly string[];
}

export type SayuriCronIntentStatus = "pending" | "admitted" | "cancelled";

export interface SayuriCronWorkIntent {
  id: string;
  projectId: string;
  sourceCronTaskId: string;
  sourceAgentId: string;
  sourceConversationId: string;
  intendedOccurrence: string;
  objective: string;
  title: string;
  priority: number;
  constraints: readonly string[];
  successCriteria: readonly string[];
  status: SayuriCronIntentStatus;
  createdAt: string;
  updatedAt: string;
  goalId?: string;
}

interface SayuriCronIntentFile {
  schemaVersion: 1;
  projectId: string;
  intents: SayuriCronWorkIntent[];
}

function encodeProjectId(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new Error("Cron intent projectId is required.");
  return Buffer.from(value, "utf8").toString("base64url");
}

function normalizePriority(value: number | undefined): number {
  const priority = value ?? 50;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
    throw new Error("Cron intent priority must be an integer from 0 to 100.");
  }
  return priority;
}

export function buildSayuriCronIntentPrompt(spec: SayuriCronIntentSpec): string {
  const normalized = {
    projectId: spec.projectId.trim(),
    objective: spec.objective.trim(),
    title: spec.title?.trim() || "Scheduled Sayuri work",
    priority: normalizePriority(spec.priority),
    constraints: [...(spec.constraints ?? [])],
    successCriteria: [...(spec.successCriteria ?? [])],
  };
  if (!normalized.projectId || !normalized.objective) {
    throw new Error("Sayuri cron intent requires projectId and objective.");
  }
  return `${OPEN}${JSON.stringify(normalized)}${CLOSE}`;
}

export function parseSayuriCronIntentPrompt(
  prompt: string,
): SayuriCronIntentSpec | null {
  const trimmed = prompt.trim();
  if (!trimmed.startsWith(OPEN) || !trimmed.endsWith(CLOSE)) return null;
  const raw = trimmed.slice(OPEN.length, -CLOSE.length);
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Sayuri cron intent prompt contains invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Sayuri cron intent payload must be an object.");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "projectId",
    "objective",
    "title",
    "priority",
    "constraints",
    "successCriteria",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new Error(`Unsupported Sayuri cron intent field "${key}".`);
    }
  }
  if (
    typeof record.projectId !== "string" ||
    !record.projectId.trim() ||
    typeof record.objective !== "string" ||
    !record.objective.trim()
  ) {
    throw new Error("Sayuri cron intent requires projectId and objective.");
  }
  const stringArray = (input: unknown, field: string): string[] => {
    if (input === undefined) return [];
    if (
      !Array.isArray(input) ||
      input.some((item) => typeof item !== "string" || !item.trim())
    ) {
      throw new Error(`Sayuri cron intent ${field} must contain strings.`);
    }
    return input.map((item) => item.trim());
  };
  return {
    projectId: record.projectId.trim(),
    objective: record.objective.trim(),
    ...(typeof record.title === "string" && record.title.trim()
      ? { title: record.title.trim() }
      : {}),
    priority: normalizePriority(
      typeof record.priority === "number" ? record.priority : undefined,
    ),
    constraints: stringArray(record.constraints, "constraints"),
    successCriteria: stringArray(record.successCriteria, "successCriteria"),
  };
}

export interface SayuriCronIntentStore {
  save(intent: SayuriCronWorkIntent): Promise<void>;
  get(projectId: string, intentId: string): Promise<SayuriCronWorkIntent | null>;
  list(projectId: string): Promise<SayuriCronWorkIntent[]>;
}

export class FileSayuriCronIntentStore implements SayuriCronIntentStore {
  readonly #root: string;

  constructor(root: string = resolveSayuriStateRoot()) {
    this.#root = root;
  }

  private projectDir(projectId: string): string {
    return join(this.#root, "projects", encodeProjectId(projectId));
  }

  private filePath(projectId: string): string {
    return join(this.projectDir(projectId), "cron-intents.json");
  }

  private lockPath(projectId: string): string {
    return join(this.projectDir(projectId), ".cron-intents.lock");
  }

  private async read(projectId: string): Promise<SayuriCronIntentFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { schemaVersion: 1, projectId, intents: [] };
      }
      throw error;
    }
    const value = JSON.parse(raw) as SayuriCronIntentFile;
    if (
      value.schemaVersion !== 1 ||
      value.projectId !== projectId ||
      !Array.isArray(value.intents)
    ) {
      throw new Error("Cron intent store schema/project identity is invalid.");
    }
    return value;
  }

  async save(intent: SayuriCronWorkIntent): Promise<void> {
    const dir = this.projectDir(intent.projectId);
    await mkdir(dir, { recursive: true });
    await withFileLock(
      this.lockPath(intent.projectId),
      async () => {
        const current = await this.read(intent.projectId);
        const intents = current.intents.filter((item) => item.id !== intent.id);
        intents.push(intent);
        intents.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const target = this.filePath(intent.projectId);
        const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          temp,
          `${JSON.stringify({
            schemaVersion: 1,
            projectId: intent.projectId,
            intents,
          }, null, 2)}\n`,
          "utf8",
        );
        await rename(temp, target);
      },
      { reapOnlyDeadOwner: true },
    );
  }

  async get(
    projectId: string,
    intentId: string,
  ): Promise<SayuriCronWorkIntent | null> {
    return (await this.read(projectId)).intents.find(
      (intent) => intent.id === intentId,
    ) ?? null;
  }

  async list(projectId: string): Promise<SayuriCronWorkIntent[]> {
    return [...(await this.read(projectId)).intents];
  }
}

function intentIdFor(input: ScheduledTaskAdmissionInput): string {
  return `cron-${input.task.id}-${input.timing.intendedOccurrence.getTime()}`;
}

export function createSayuriCronAdmissionHandler(
  store: SayuriCronIntentStore,
) {
  return async (input: ScheduledTaskAdmissionInput) => {
    let spec: SayuriCronIntentSpec | null;
    try {
      spec = parseSayuriCronIntentPrompt(input.task.prompt);
    } catch (error) {
      return {
        handled: true as const,
        accepted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (!spec) return { handled: false as const };

    const now = input.timing.schedulerNow.toISOString();
    const id = intentIdFor(input);
    const existing = await store.get(spec.projectId, id);
    if (!existing) {
      await store.save({
        id,
        projectId: spec.projectId,
        sourceCronTaskId: input.task.id,
        sourceAgentId: input.task.agent_id,
        sourceConversationId: input.task.conversation_id ?? "default",
        intendedOccurrence: input.timing.intendedOccurrence.toISOString(),
        objective: spec.objective,
        title: spec.title ?? input.task.name,
        priority: normalizePriority(spec.priority),
        constraints: [...(spec.constraints ?? [])],
        successCriteria: [...(spec.successCriteria ?? [])],
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      handled: true as const,
      accepted: true,
      referenceId: id,
      summary: `Sayuri work intent ${id} admitted without direct execution.`,
    };
  };
}

let defaultAdmissionInstalled = false;

export function installSayuriCronAdmission(
  store: SayuriCronIntentStore = new FileSayuriCronIntentStore(),
): void {
  if (defaultAdmissionInstalled) return;
  registerScheduledTaskAdmissionHandler(createSayuriCronAdmissionHandler(store));
  defaultAdmissionInstalled = true;
}

export type SayuriCronIntentAdmissionDecision =
  | { kind: "none" }
  | { kind: "deferred-active-task"; taskId: string }
  | { kind: "goal-created"; intentId: string; goalId: string };

export async function admitNextSayuriCronIntent(input: {
  projectId: string;
  intentStore: SayuriCronIntentStore;
  goalStore?: SayuriGoalStore;
  taskRegistry?: SayuriTaskRegistry;
  now?: string;
}): Promise<SayuriCronIntentAdmissionDecision> {
  const goalStore = input.goalStore ?? new FileSayuriGoalStore();
  const taskRegistry = input.taskRegistry ?? new FileSayuriTaskRegistry();
  const unfinished = (await taskRegistry.listProjectTasks(input.projectId)).find(
    (task) => isUnfinishedSayuriTaskStatus(task.status),
  );
  if (unfinished) {
    return { kind: "deferred-active-task", taskId: unfinished.taskId };
  }

  const intent = (await input.intentStore.list(input.projectId)).find(
    (candidate) => candidate.status === "pending",
  );
  if (!intent) return { kind: "none" };

  const goalId = `goal-${intent.id}`;
  const existingGoal = await goalStore.getGoal(input.projectId, goalId);
  if (!existingGoal) {
    await goalStore.createGoal({
      id: goalId,
      projectId: input.projectId,
      title: intent.title,
      objective: intent.objective,
      priority: intent.priority,
      constraints: [
        ...intent.constraints,
        `Scheduled work intent: ${intent.id}`,
        "All mutations must pass Sayuri Action Broker.",
      ],
      successCriteria: intent.successCriteria,
      createdAt: input.now ?? new Date().toISOString(),
    });
  }

  await input.intentStore.save({
    ...intent,
    status: "admitted",
    goalId,
    updatedAt: input.now ?? new Date().toISOString(),
  });
  return { kind: "goal-created", intentId: intent.id, goalId };
}
