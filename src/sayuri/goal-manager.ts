import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import { resolveSayuriStateRoot } from "./state-store";
import type {
  SayuriProjectTaskEntry,
  SayuriTaskRegistry,
} from "./task-registry";

export type SayuriGoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

export interface SayuriProjectGoal {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  status: SayuriGoalStatus;
  priority: number;
  createdAt: string;
  updatedAt: string;
  dependsOnGoalIds: readonly string[];
  taskIds: readonly string[];
  constraints: readonly string[];
  successCriteria: readonly string[];
  blockedReason?: string;
}

export interface SayuriGoalDraft {
  id?: string;
  projectId: string;
  title: string;
  objective: string;
  priority?: number;
  createdAt?: string;
  dependsOnGoalIds?: readonly string[];
  constraints?: readonly string[];
  successCriteria?: readonly string[];
}

export interface SayuriGoalStore {
  createGoal(draft: SayuriGoalDraft): Promise<SayuriProjectGoal>;
  saveGoal(goal: SayuriProjectGoal): Promise<void>;
  getGoal(projectId: string, goalId: string): Promise<SayuriProjectGoal | null>;
  listGoals(projectId: string): Promise<SayuriProjectGoal[]>;
}

interface SayuriGoalFile {
  schemaVersion: 1;
  projectId: string;
  goals: SayuriProjectGoal[];
}

export interface SayuriPlannerSeed {
  taskId: string;
  projectId: string;
  goalId: string;
  goal: string;
  constraints: readonly string[];
  successCriteria: readonly string[];
}

export type SayuriProjectWorkDecision =
  | { kind: "resume-unfinished-task"; task: SayuriProjectTaskEntry }
  | { kind: "create-task"; goal: SayuriProjectGoal; plannerSeed: SayuriPlannerSeed }
  | { kind: "idle"; reason: string };

const GOAL_STATUSES = new Set<SayuriGoalStatus>([
  "active",
  "paused",
  "blocked",
  "completed",
  "cancelled",
]);

function encodeProjectId(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new Error("Goal projectId is required.");
  return Buffer.from(value, "utf8").toString("base64url");
}

function normalizePriority(priority: number | undefined): number {
  const value = priority ?? 50;
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    throw new Error("Goal priority must be an integer from 0 to 100.");
  }
  return value;
}

function validateTimestamp(value: string, field: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`${field} must be an ISO-compatible timestamp.`);
  }
}

export function validateSayuriGoal(goal: SayuriProjectGoal): void {
  if (!goal.id.trim()) throw new Error("Goal id is required.");
  if (!goal.projectId.trim()) throw new Error("Goal projectId is required.");
  if (!goal.title.trim()) throw new Error("Goal title is required.");
  if (!goal.objective.trim()) throw new Error("Goal objective is required.");
  if (!GOAL_STATUSES.has(goal.status)) {
    throw new Error(`Unknown goal status "${String(goal.status)}".`);
  }
  normalizePriority(goal.priority);
  validateTimestamp(goal.createdAt, "Goal createdAt");
  validateTimestamp(goal.updatedAt, "Goal updatedAt");
  for (const dependency of goal.dependsOnGoalIds) {
    if (!dependency.trim() || dependency === goal.id) {
      throw new Error("Goal dependencies must be non-empty and non-self.");
    }
  }
  if (new Set(goal.dependsOnGoalIds).size !== goal.dependsOnGoalIds.length) {
    throw new Error("Goal dependencies must be unique.");
  }
  if (new Set(goal.taskIds).size !== goal.taskIds.length) {
    throw new Error("Goal task links must be unique.");
  }
  if (goal.status === "blocked" && !goal.blockedReason?.trim()) {
    throw new Error("Blocked goals require blockedReason.");
  }
}

export function createSayuriGoal(draft: SayuriGoalDraft): SayuriProjectGoal {
  const now = draft.createdAt ?? new Date().toISOString();
  const goal: SayuriProjectGoal = {
    id: draft.id?.trim() || `goal-${randomUUID()}`,
    projectId: draft.projectId.trim(),
    title: draft.title.trim(),
    objective: draft.objective.trim(),
    status: "active",
    priority: normalizePriority(draft.priority),
    createdAt: now,
    updatedAt: now,
    dependsOnGoalIds: [...(draft.dependsOnGoalIds ?? [])],
    taskIds: [],
    constraints: [...(draft.constraints ?? [])],
    successCriteria: [...(draft.successCriteria ?? [])],
  };
  validateSayuriGoal(goal);
  return goal;
}

export function transitionSayuriGoal(
  goal: SayuriProjectGoal,
  status: SayuriGoalStatus,
  input: { now?: string; blockedReason?: string } = {},
): SayuriProjectGoal {
  if (goal.status === "completed" || goal.status === "cancelled") {
    throw new Error(`Goal is terminal in status "${goal.status}".`);
  }
  const next: SayuriProjectGoal = {
    ...goal,
    status,
    updatedAt: input.now ?? new Date().toISOString(),
    ...(status === "blocked"
      ? { blockedReason: input.blockedReason?.trim() || "" }
      : { blockedReason: undefined }),
  };
  validateSayuriGoal(next);
  return next;
}

export function linkTaskToSayuriGoal(
  goal: SayuriProjectGoal,
  taskId: string,
  now: string = new Date().toISOString(),
): SayuriProjectGoal {
  const normalized = taskId.trim();
  if (!normalized) throw new Error("Linked taskId is required.");
  if (goal.taskIds.includes(normalized)) return goal;
  const next = {
    ...goal,
    taskIds: [...goal.taskIds, normalized],
    updatedAt: now,
  };
  validateSayuriGoal(next);
  return next;
}

function sortGoals(goals: readonly SayuriProjectGoal[]): SayuriProjectGoal[] {
  return [...goals].sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    const created = left.createdAt.localeCompare(right.createdAt);
    return created !== 0 ? created : left.id.localeCompare(right.id);
  });
}

export class FileSayuriGoalStore implements SayuriGoalStore {
  readonly #root: string;

  constructor(root: string = resolveSayuriStateRoot()) {
    this.#root = root;
  }

  private projectDir(projectId: string): string {
    return join(this.#root, "projects", encodeProjectId(projectId));
  }

  private filePath(projectId: string): string {
    return join(this.projectDir(projectId), "goals.json");
  }

  private lockPath(projectId: string): string {
    return join(this.projectDir(projectId), ".goals.lock");
  }

  private async read(projectId: string): Promise<SayuriGoalFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { schemaVersion: 1, projectId, goals: [] };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Goal store for project "${projectId}" is not valid JSON.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`Goal store for project "${projectId}" is invalid.`);
    }
    const record = value as Partial<SayuriGoalFile>;
    if (
      record.schemaVersion !== 1 ||
      record.projectId !== projectId ||
      !Array.isArray(record.goals)
    ) {
      throw new Error("Goal store project identity or schema is invalid.");
    }
    for (const goal of record.goals) validateSayuriGoal(goal);
    return { schemaVersion: 1, projectId, goals: record.goals };
  }

  async createGoal(draft: SayuriGoalDraft): Promise<SayuriProjectGoal> {
    const goal = createSayuriGoal(draft);
    const existing = await this.getGoal(goal.projectId, goal.id);
    if (existing) throw new Error(`Goal "${goal.id}" already exists.`);
    await this.saveGoal(goal);
    return goal;
  }

  async saveGoal(goal: SayuriProjectGoal): Promise<void> {
    validateSayuriGoal(goal);
    const directory = this.projectDir(goal.projectId);
    await mkdir(directory, { recursive: true });
    await withFileLock(
      this.lockPath(goal.projectId),
      async () => {
        const current = await this.read(goal.projectId);
        const goals = current.goals.filter((item) => item.id !== goal.id);
        goals.push({ ...goal });
        const target = this.filePath(goal.projectId);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(
          temporary,
          `${JSON.stringify({
            schemaVersion: 1,
            projectId: goal.projectId,
            goals: sortGoals(goals),
          }, null, 2)}\n`,
          "utf8",
        );
        await rename(temporary, target);
      },
      { reapOnlyDeadOwner: true },
    );
  }

  async getGoal(
    projectId: string,
    goalId: string,
  ): Promise<SayuriProjectGoal | null> {
    const file = await this.read(projectId);
    return file.goals.find((goal) => goal.id === goalId) ?? null;
  }

  async listGoals(projectId: string): Promise<SayuriProjectGoal[]> {
    return sortGoals((await this.read(projectId)).goals);
  }
}

export async function chooseNextEligibleSayuriGoal(
  store: SayuriGoalStore,
  projectId: string,
): Promise<SayuriProjectGoal | null> {
  const goals = await store.listGoals(projectId);
  const completed = new Set(
    goals.filter((goal) => goal.status === "completed").map((goal) => goal.id),
  );
  return (
    goals.find(
      (goal) =>
        goal.status === "active" &&
        goal.dependsOnGoalIds.every((dependency) => completed.has(dependency)),
    ) ?? null
  );
}

export async function decideNextSayuriProjectWork(input: {
  projectId: string;
  goalStore: SayuriGoalStore;
  taskRegistry: SayuriTaskRegistry;
  taskIdFactory?: () => string;
}): Promise<SayuriProjectWorkDecision> {
  const unfinished = await input.taskRegistry.findLatestUnfinished(
    input.projectId,
  );
  if (unfinished) {
    return { kind: "resume-unfinished-task", task: unfinished };
  }

  const goal = await chooseNextEligibleSayuriGoal(
    input.goalStore,
    input.projectId,
  );
  if (!goal) {
    return {
      kind: "idle",
      reason: "No active goal with satisfied dependencies is eligible.",
    };
  }

  const taskId = input.taskIdFactory?.() ?? `task-${randomUUID()}`;
  return {
    kind: "create-task",
    goal,
    plannerSeed: {
      taskId,
      projectId: input.projectId,
      goalId: goal.id,
      goal: goal.objective,
      constraints: [...goal.constraints],
      successCriteria: [...goal.successCriteria],
    },
  };
}
