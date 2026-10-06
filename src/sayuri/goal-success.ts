import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile,
} from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "@/utils/file-lock";
import {
  transitionSayuriGoal,
  type SayuriGoalStore,
  type SayuriProjectGoal,
} from "./goal-manager";
import { resolveSayuriStateRoot } from "./state-store";
import type { SayuriTaskRegistry } from "./task-registry";

export interface SayuriGoalCriterionEvidence {
  id: string;
  projectId: string;
  goalId: string;
  criterion: string;
  source: "user-confirmation";
  createdAt: string;
}

export interface SayuriGoalEvidenceStore {
  appendUserConfirmation(input: {
    projectId: string;
    goalId: string;
    criterion: string;
    createdAt?: string;
  }): Promise<SayuriGoalCriterionEvidence>;
  listForGoal(
    projectId: string,
    goalId: string,
  ): Promise<SayuriGoalCriterionEvidence[]>;
}

export interface SayuriGoalSuccessEvaluation {
  ready: boolean;
  reasons: readonly string[];
  taskIds: readonly string[];
  confirmedCriteria: readonly string[];
}

function validateEvidence(evidence: SayuriGoalCriterionEvidence): void {
  if (!evidence.id.trim()) throw new Error("Goal evidence id is required.");
  if (!evidence.projectId.trim()) {
    throw new Error("Goal evidence projectId is required.");
  }
  if (!evidence.goalId.trim()) {
    throw new Error("Goal evidence goalId is required.");
  }
  if (!evidence.criterion.trim()) {
    throw new Error("Goal evidence criterion is required.");
  }
  if (evidence.source !== "user-confirmation") {
    throw new Error("Unsupported goal evidence source.");
  }
  if (Number.isNaN(Date.parse(evidence.createdAt))) {
    throw new Error("Goal evidence createdAt must be ISO-compatible.");
  }
}

function encodeProjectId(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new Error("Goal evidence projectId is required.");
  return Buffer.from(value, "utf8").toString("base64url");
}

export class FileSayuriGoalEvidenceStore implements SayuriGoalEvidenceStore {
  readonly #root: string;

  constructor(root: string = resolveSayuriStateRoot()) {
    this.#root = root;
  }

  private projectDir(projectId: string): string {
    return join(this.#root, "projects", encodeProjectId(projectId));
  }

  private filePath(projectId: string): string {
    return join(this.projectDir(projectId), "goal-success-evidence.jsonl");
  }

  private lockPath(projectId: string): string {
    return join(this.projectDir(projectId), ".goal-success-evidence.lock");
  }

  async appendUserConfirmation(input: {
    projectId: string;
    goalId: string;
    criterion: string;
    createdAt?: string;
  }): Promise<SayuriGoalCriterionEvidence> {
    const evidence: SayuriGoalCriterionEvidence = {
      id: `goal-evidence-${randomUUID()}`,
      projectId: input.projectId.trim(),
      goalId: input.goalId.trim(),
      criterion: input.criterion.trim(),
      source: "user-confirmation",
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    validateEvidence(evidence);

    const directory = this.projectDir(evidence.projectId);
    await mkdir(directory, { recursive: true });
    await withFileLock(
      this.lockPath(evidence.projectId),
      async () => {
        const existing = await this.listForGoal(
          evidence.projectId,
          evidence.goalId,
        );
        if (
          existing.some(
            (item) =>
              item.source === evidence.source &&
              item.criterion === evidence.criterion,
          )
        ) {
          return;
        }
        await appendFile(
          this.filePath(evidence.projectId),
          `${JSON.stringify(evidence)}\n`,
          "utf8",
        );
      },
      { reapOnlyDeadOwner: true },
    );
    return evidence;
  }

  async listForGoal(
    projectId: string,
    goalId: string,
  ): Promise<SayuriGoalCriterionEvidence[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      throw error;
    }

    const evidence: SayuriGoalCriterionEvidence[] = [];
    for (const [index, line] of raw.split("\n").entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error(
          `Invalid goal evidence JSON at line ${index + 1} for project "${projectId}".`,
        );
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Goal evidence entry must be an object.");
      }
      const item = value as SayuriGoalCriterionEvidence;
      validateEvidence(item);
      if (item.projectId === projectId && item.goalId === goalId) {
        evidence.push(item);
      }
    }
    return evidence;
  }
}

export async function evaluateSayuriGoalSuccess(input: {
  goal: SayuriProjectGoal;
  taskRegistry: SayuriTaskRegistry;
  evidenceStore: SayuriGoalEvidenceStore;
}): Promise<SayuriGoalSuccessEvaluation> {
  const reasons: string[] = [];
  if (input.goal.status !== "active" && input.goal.status !== "blocked") {
    reasons.push(
      `Goal must be active/blocked for completion evaluation, got "${input.goal.status}".`,
    );
  }
  if (input.goal.taskIds.length === 0) {
    reasons.push("Goal has no linked tasks.");
  }

  let completedTaskCount = 0;
  for (const taskId of input.goal.taskIds) {
    const task = await input.taskRegistry.getTask(input.goal.projectId, taskId);
    if (!task) {
      reasons.push(`Linked task "${taskId}" is missing from the project registry.`);
      continue;
    }
    if (task.status === "completed") {
      completedTaskCount += 1;
      continue;
    }
    if (task.status !== "failed" && task.status !== "cancelled") {
      reasons.push(
        `Linked task "${taskId}" is unfinished in status "${task.status}".`,
      );
    }
  }
  if (input.goal.taskIds.length > 0 && completedTaskCount === 0) {
    reasons.push("Goal has no successfully completed linked task.");
  }

  const evidence = await input.evidenceStore.listForGoal(
    input.goal.projectId,
    input.goal.id,
  );
  const confirmed = new Set(
    evidence
      .filter((item) => item.source === "user-confirmation")
      .map((item) => item.criterion),
  );
  for (const criterion of input.goal.successCriteria) {
    if (!confirmed.has(criterion)) {
      reasons.push(`Success criterion is not confirmed: ${criterion}`);
    }
  }

  return {
    ready: reasons.length === 0,
    reasons,
    taskIds: [...input.goal.taskIds],
    confirmedCriteria: input.goal.successCriteria.filter((criterion) =>
      confirmed.has(criterion),
    ),
  };
}

export async function completeSayuriGoalIfVerified(input: {
  projectId: string;
  goalId: string;
  goalStore: SayuriGoalStore;
  taskRegistry: SayuriTaskRegistry;
  evidenceStore: SayuriGoalEvidenceStore;
  now?: string;
}): Promise<SayuriProjectGoal> {
  const goal = await input.goalStore.getGoal(input.projectId, input.goalId);
  if (!goal) throw new Error(`Goal "${input.goalId}" was not found.`);

  const evaluation = await evaluateSayuriGoalSuccess({
    goal,
    taskRegistry: input.taskRegistry,
    evidenceStore: input.evidenceStore,
  });
  if (!evaluation.ready) {
    throw new Error(
      `Sayuri Goal Success Gate rejected completion: ${evaluation.reasons.join(" ")}`,
    );
  }

  const completed = transitionSayuriGoal(
    goal,
    "completed",
    input.now ? { now: input.now } : {},
  );
  await input.goalStore.saveGoal(completed);
  return completed;
}
