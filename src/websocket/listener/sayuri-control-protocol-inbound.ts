import type {
  SayuriCancelCommand,
  SayuriControlCommand,
  SayuriStateGetCommand,
  SayuriTaskConfirmCommand,
} from "@/types/sayuri-control-protocol";

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isSayuriStateGetCommand(
  value: unknown,
): value is SayuriStateGetCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<SayuriStateGetCommand>;
  return (
    command.type === "sayuri_state_get" &&
    nonEmpty(command.request_id) &&
    nonEmpty(command.project_id) &&
    (command.task_id === undefined || nonEmpty(command.task_id))
  );
}

export function isSayuriTaskConfirmCommand(
  value: unknown,
): value is SayuriTaskConfirmCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<SayuriTaskConfirmCommand>;
  return (
    command.type === "sayuri_task_confirm" &&
    nonEmpty(command.request_id) &&
    nonEmpty(command.project_id) &&
    nonEmpty(command.task_id) &&
    validRevision(command.expected_revision)
  );
}

export function isSayuriCancelCommand(
  value: unknown,
): value is SayuriCancelCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<SayuriCancelCommand>;
  if (
    command.type !== "sayuri_cancel" ||
    !nonEmpty(command.request_id) ||
    !nonEmpty(command.project_id) ||
    !command.target ||
    typeof command.target !== "object"
  ) {
    return false;
  }
  const target = command.target as Record<string, unknown>;
  if (target.kind === "task") {
    return nonEmpty(target.task_id) && validRevision(target.expected_revision);
  }
  if (target.kind === "background") return nonEmpty(target.lease_id);
  if (target.kind === "cron-intent") return nonEmpty(target.intent_id);
  return false;
}

export function isSayuriControlCommand(
  value: unknown,
): value is SayuriControlCommand {
  return (
    isSayuriStateGetCommand(value) ||
    isSayuriTaskConfirmCommand(value) ||
    isSayuriCancelCommand(value)
  );
}
