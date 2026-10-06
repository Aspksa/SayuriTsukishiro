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

  return {
    id,
    goal,
    status: "created",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    checkpoints: [],
  };
}

export function transitionSayuriTask(
  task: SayuriTaskState,
  nextStatus: SayuriTaskStatus,
  now: string = new Date().toISOString(),
): SayuriTaskState {
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

  return {
    ...task,
    status: "checkpointed",
    revision: task.revision + 1,
    updatedAt: checkpoint.createdAt,
    checkpoints: [...task.checkpoints, { ...checkpoint }],
  };
}
