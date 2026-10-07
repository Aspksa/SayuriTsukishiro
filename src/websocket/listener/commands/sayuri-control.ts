import type WebSocket from "ws";
import {
  cancelSayuriControlTarget,
  confirmSayuriWaitingTask,
  getSayuriCognitiveControlSnapshot,
} from "@/sayuri/control-plane";
import type {
  SayuriCancelCommand,
  SayuriControlCommand,
  SayuriControlResponseMessage,
  SayuriStateGetCommand,
  SayuriTaskConfirmCommand,
} from "@/types/sayuri-control-protocol";

type SafeSocketSend = (
  socket: WebSocket,
  payload: unknown,
  errorType: string,
  context: string,
) => boolean;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function stateResponse(
  command: SayuriStateGetCommand,
): Promise<SayuriControlResponseMessage> {
  try {
    return {
      type: "sayuri_state_get_response",
      request_id: command.request_id,
      success: true,
      snapshot: await getSayuriCognitiveControlSnapshot({
        projectId: command.project_id,
        ...(command.task_id ? { taskId: command.task_id } : {}),
      }),
    };
  } catch (error) {
    return {
      type: "sayuri_state_get_response",
      request_id: command.request_id,
      success: false,
      error: errorMessage(error),
    };
  }
}

async function confirmResponse(
  command: SayuriTaskConfirmCommand,
): Promise<SayuriControlResponseMessage> {
  try {
    return {
      type: "sayuri_task_confirm_response",
      request_id: command.request_id,
      success: true,
      task: await confirmSayuriWaitingTask({
        projectId: command.project_id,
        taskId: command.task_id,
        expectedRevision: command.expected_revision,
      }),
    };
  } catch (error) {
    return {
      type: "sayuri_task_confirm_response",
      request_id: command.request_id,
      success: false,
      error: errorMessage(error),
    };
  }
}

async function cancelResponse(
  command: SayuriCancelCommand,
): Promise<SayuriControlResponseMessage> {
  try {
    const common = { projectId: command.project_id };
    const target = command.target;
    const result =
      target.kind === "task"
        ? await cancelSayuriControlTarget({
            ...common,
            kind: "task",
            taskId: target.task_id,
            expectedRevision: target.expected_revision,
          })
        : target.kind === "background"
          ? await cancelSayuriControlTarget({
              ...common,
              kind: "background",
              leaseId: target.lease_id,
            })
          : await cancelSayuriControlTarget({
              ...common,
              kind: "cron-intent",
              intentId: target.intent_id,
            });
    return {
      type: "sayuri_cancel_response",
      request_id: command.request_id,
      success: true,
      result,
    };
  } catch (error) {
    return {
      type: "sayuri_cancel_response",
      request_id: command.request_id,
      success: false,
      error: errorMessage(error),
    };
  }
}

export async function handleSayuriControlCommand(
  command: SayuriControlCommand,
  context: {
    socket: WebSocket;
    safeSocketSend: SafeSocketSend;
  },
): Promise<void> {
  const response =
    command.type === "sayuri_state_get"
      ? await stateResponse(command)
      : command.type === "sayuri_task_confirm"
        ? await confirmResponse(command)
        : await cancelResponse(command);
  context.safeSocketSend(
    context.socket,
    response,
    response.type,
    command.type,
  );
}
