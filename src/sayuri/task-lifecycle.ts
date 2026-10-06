export type SayuriTaskStatus =
  | "created"
  | "planning"
  | "ready"
  | "running"
  | "waiting-user"
  | "waiting-external"
  | "verifying"
  | "checkpointed"
  | "completed"
  | "failed"
  | "cancelled";

export interface SayuriTaskCheckpoint {
  id: string;
  createdAt: string;
  summary: string;
  nextAction: string;
  verifiedReceiptIds: readonly string[];
}

export interface SayuriTaskState {
  id: string;
  goal: string;
  status: SayuriTaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  checkpoints: readonly SayuriTaskCheckpoint[];
}

const TERMINAL_STATUSES = new Set<SayuriTaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const SAYURI_TASK_STATUSES = new Set<SayuriTaskStatus>([
  "created",
  "planning",
  "ready",
  "running",
  "waiting-user",
  "waiting-external",
  "verifying",
  "checkpointed",
  "completed",
  "failed",
  "cancelled",
]);

const ALLOWED_TRANSITIONS: Readonly<
  Record<SayuriTaskStatus, ReadonlySet<SayuriTaskStatus>>
> = {
  created: new Set(["planning", "cancelled"]),
  planning: new Set(["ready", "waiting-user", "failed", "cancelled"]),
  ready: new Set(["running", "cancelled"]),
  running: new Set([
    "waiting-user",
    "waiting-external",
    "verifying",
    "checkpointed",
    "failed",
    "cancelled",
  ]),
  "waiting-user": new Set(["planning", "ready", "running", "cancelled"]),
  "waiting-external": new Set(["running", "verifying", "failed", "cancelled"]),
  verifying: new Set(["running", "checkpointed", "completed", "failed"]),
  checkpointed: new Set(["running", "planning", "verifying", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

function assertTimestamp(timestamp: string): void {
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new Error("Task timestamp must be ISO-compatible.");
  }
}

export function isSayuriTaskStatus(value: unknown): value is SayuriTaskStatus {
  return typeof value === "string" && SAYURI_TASK_STATUSES.has(
    value as SayuriTaskStatus,
  );
}

export function isTerminalSayuriTaskStatus(status: SayuriTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isUnfinishedSayuriTaskStatus(status: SayuriTaskStatus): boolean {
  return !isTerminalSayuriTaskStatus(status);
}

export function validateSayuriTaskState(task: SayuriTaskState): void {
  if (!task.id.trim()) throw new Error("Task id is required.");
  if (!task.goal.trim()) throw new Error("Task goal is required.");
  if (!SAYURI_TASK_STATUSES.has(task.status)) {
    throw new Error(`Unknown Sayuri task status "${task.status}".`);
  }
  if (!Number.isSafeInteger(task.revision) || task.revision < 0) {
    throw new Error("Task revision must be a non-negative safe integer.");
  }
  assertTimestamp(task.createdAt);
  assertTimestamp(task.updatedAt);

  const checkpointIds = new Set<string>();
  for (const checkpoint of task.checkpoints) {
    if (!checkpoint.id.trim()) throw new Error("Checkpoint id is required.");
    if (checkpointIds.has(checkpoint.id)) {
      throw new Error(`Duplicate checkpoint id "${checkpoint.id}".`);
    }
    checkpointIds.add(checkpoint.id);
    if (!checkpoint.summary.trim()) {
      throw new Error("Checkpoint summary is required.");
    }
    if (!checkpoint.nextAction.trim()) {
      throw new Error("Checkpoint nextAction is required.");
    }
    assertTimestamp(checkpoint.createdAt);
    if (
      !Array.isArray(checkpoint.verifiedReceiptIds) ||
      checkpoint.verifiedReceiptIds.some(
        (receiptId) => typeof receiptId !== "string" || !receiptId.trim(),
      )
    ) {
      throw new Error("Checkpoint verifiedReceiptIds must contain valid ids.");
    }
  }
}

export function createSayuriTask(input: {
  id: string;
  goal: string;
  now?: string;
}): SayuriTaskState {
  const id = input.id.trim();
  const goal = input.goal.trim();
  if (!id) throw new Error("Task id is required.");
  if (!goal) throw new Error("Task goal is required.");
  const now = input.now ?? new Date().toISOString();
  assertTimestamp(now);

  const task: SayuriTaskState = {
    id,
    goal,
    status: "created",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    checkpoints: [],
  };
  validateSayuriTaskState(task);
  return task;
}

export function transitionSayuriTask(
  task: SayuriTaskState,
  nextStatus: SayuriTaskStatus,
  now: string = new Date().toISOString(),
): SayuriTaskState {
  validateSayuriTaskState(task);
  assertTimestamp(now);
  if (TERMINAL_STATUSES.has(task.status)) {
    throw new Error(`Task is terminal in status "${task.status}".`);
  }
  if (!ALLOWED_TRANSITIONS[task.status].has(nextStatus)) {
    throw new Error(
      `Invalid Sayuri task transition: ${task.status} -> ${nextStatus}.`,
    );
  }
  return {
    ...task,
    status: nextStatus,
    revision: task.revision + 1,
    updatedAt: now,
  };
}

export function checkpointSayuriTask(
  task: SayuriTaskState,
  checkpoint: SayuriTaskCheckpoint,
): SayuriTaskState {
  validateSayuriTaskState(task);
  if (
    task.status !== "running" &&
    task.status !== "verifying" &&
    task.status !== "checkpointed"
  ) {
    throw new Error(
      `Task status "${task.status}" cannot produce a checkpoint.`,
    );
  }
  if (!checkpoint.id.trim()) throw new Error("Checkpoint id is required.");
  if (!checkpoint.summary.trim()) {
    throw new Error("Checkpoint summary is required.");
  }
  if (!checkpoint.nextAction.trim()) {
    throw new Error("Checkpoint nextAction is required.");
  }
  assertTimestamp(checkpoint.createdAt);
  if (task.checkpoints.some((item) => item.id === checkpoint.id)) {
    throw new Error(`Checkpoint "${checkpoint.id}" already exists.`);
  }

  const next = {
    ...task,
    status: "checkpointed" as const,
    revision: task.revision + 1,
    updatedAt: checkpoint.createdAt,
    checkpoints: [...task.checkpoints, { ...checkpoint }],
  };
  validateSayuriTaskState(next);
  return next;
}
