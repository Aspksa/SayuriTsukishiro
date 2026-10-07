import type {
  SayuriCancelCommand,
  SayuriControlCommand,
  SayuriStateGetCommand,
  SayuriStateSubscribeCommand,
  SayuriStateUnsubscribeCommand,
  SayuriTaskConfirmCommand,
} from "@/types/sayuri-control-protocol";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const allow = new Set(allowed);
  return Object.keys(value).every((key) => allow.has(key));
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isSayuriStateGetCommand(
  value: unknown,
): value is SayuriStateGetCommand {
  const command = record(value);
  return Boolean(
    command &&
      onlyKeys(command, ["type", "request_id", "project_id", "task_id"]) &&
      command.type === "sayuri_state_get" &&
      nonEmpty(command.request_id) &&
      nonEmpty(command.project_id) &&
      (command.task_id === undefined || nonEmpty(command.task_id)),
  );
}

export function isSayuriStateSubscribeCommand(
  value: unknown,
): value is SayuriStateSubscribeCommand {
  const command = record(value);
  return Boolean(
    command &&
      onlyKeys(command, ["type", "request_id", "project_id"]) &&
      command.type === "sayuri_state_subscribe" &&
      nonEmpty(command.request_id) &&
      nonEmpty(command.project_id),
  );
}

export function isSayuriStateUnsubscribeCommand(
  value: unknown,
): value is SayuriStateUnsubscribeCommand {
  const command = record(value);
  return Boolean(
    command &&
      onlyKeys(command, ["type", "request_id", "project_id"]) &&
      command.type === "sayuri_state_unsubscribe" &&
      nonEmpty(command.request_id) &&
      nonEmpty(command.project_id),
  );
}

export function isSayuriTaskConfirmCommand(
  value: unknown,
): value is SayuriTaskConfirmCommand {
  const command = record(value);
  return Boolean(
    command &&
      onlyKeys(command, [
        "type",
        "request_id",
        "project_id",
        "task_id",
        "expected_revision",
      ]) &&
      command.type === "sayuri_task_confirm" &&
      nonEmpty(command.request_id) &&
      nonEmpty(command.project_id) &&
      nonEmpty(command.task_id) &&
      validRevision(command.expected_revision),
  );
}

export function isSayuriCancelCommand(
  value: unknown,
): value is SayuriCancelCommand {
  const command = record(value);
  if (
    !command ||
    !onlyKeys(command, ["type", "request_id", "project_id", "target"]) ||
    command.type !== "sayuri_cancel" ||
    !nonEmpty(command.request_id) ||
    !nonEmpty(command.project_id)
  ) {
    return false;
  }
  const target = record(command.target);
  if (!target) return false;
  if (target.kind === "task") {
    return (
      onlyKeys(target, ["kind", "task_id", "expected_revision"]) &&
      nonEmpty(target.task_id) &&
      validRevision(target.expected_revision)
    );
  }
  if (target.kind === "background") {
    return onlyKeys(target, ["kind", "lease_id"]) && nonEmpty(target.lease_id);
  }
  if (target.kind === "cron-intent") {
    return (
      onlyKeys(target, ["kind", "intent_id"]) && nonEmpty(target.intent_id)
    );
  }
  return false;
}

export function isSayuriControlCommand(
  value: unknown,
): value is SayuriControlCommand {
  return (
    isSayuriStateGetCommand(value) ||
    isSayuriStateSubscribeCommand(value) ||
    isSayuriStateUnsubscribeCommand(value) ||
    isSayuriTaskConfirmCommand(value) ||
    isSayuriCancelCommand(value)
  );
}
