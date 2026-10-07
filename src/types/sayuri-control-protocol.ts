import type { SayuriCognitiveControlSnapshot } from "../sayuri/control-plane";
import type { SayuriTaskState } from "../sayuri/task-lifecycle";

export interface SayuriStateGetCommand {
  type: "sayuri_state_get";
  request_id: string;
  project_id: string;
  task_id?: string;
}

export interface SayuriStateGetResponse {
  type: "sayuri_state_get_response";
  request_id: string;
  success: boolean;
  snapshot?: SayuriCognitiveControlSnapshot;
  error?: string;
}

export interface SayuriStateSubscribeCommand {
  type: "sayuri_state_subscribe";
  request_id: string;
  project_id: string;
}

export interface SayuriStateSubscribeResponse {
  type: "sayuri_state_subscribe_response";
  request_id: string;
  success: boolean;
  snapshot?: SayuriCognitiveControlSnapshot;
  error?: string;
}

export interface SayuriStateUnsubscribeCommand {
  type: "sayuri_state_unsubscribe";
  request_id: string;
  project_id: string;
}

export interface SayuriStateUnsubscribeResponse {
  type: "sayuri_state_unsubscribe_response";
  request_id: string;
  success: boolean;
  unsubscribed: boolean;
  error?: string;
}

export interface SayuriStateUpdateMessage {
  type: "sayuri_state_update";
  project_id: string;
  snapshot: SayuriCognitiveControlSnapshot;
  event_seq: number;
  emitted_at: string;
  idempotency_key: string;
}

export interface SayuriTaskConfirmCommand {
  type: "sayuri_task_confirm";
  request_id: string;
  project_id: string;
  task_id: string;
  expected_revision: number;
}

export interface SayuriTaskConfirmResponse {
  type: "sayuri_task_confirm_response";
  request_id: string;
  success: boolean;
  task?: SayuriTaskState;
  error?: string;
}

export type SayuriCancelTarget =
  | {
      kind: "task";
      task_id: string;
      expected_revision: number;
    }
  | {
      kind: "background";
      lease_id: string;
    }
  | {
      kind: "cron-intent";
      intent_id: string;
    };

export interface SayuriCancelCommand {
  type: "sayuri_cancel";
  request_id: string;
  project_id: string;
  target: SayuriCancelTarget;
}

export interface SayuriCancelResponse {
  type: "sayuri_cancel_response";
  request_id: string;
  success: boolean;
  result?: Awaited<
    ReturnType<
      typeof import("../sayuri/control-plane").cancelSayuriControlTarget
    >
  >;
  error?: string;
}

export type SayuriControlCommand =
  | SayuriStateGetCommand
  | SayuriStateSubscribeCommand
  | SayuriStateUnsubscribeCommand
  | SayuriTaskConfirmCommand
  | SayuriCancelCommand;

export type SayuriControlResponseMessage =
  | SayuriStateGetResponse
  | SayuriStateSubscribeResponse
  | SayuriStateUnsubscribeResponse
  | SayuriStateUpdateMessage
  | SayuriTaskConfirmResponse
  | SayuriCancelResponse;
