import { getSayuriCognitiveControlSnapshot } from "@/sayuri/control-plane";
import { subscribeToSayuriProjectStateChanges } from "@/sayuri/state-events";
import type { SayuriStateUpdateMessage } from "@/types/sayuri-control-protocol";
import { debugWarn } from "@/utils/debug";
import {
  nextListenerConnectionEventSeq,
  unsubscribeListenerConnection,
} from "./connection";
import { enqueueOutboundFrame } from "./outbound-wire";
import { classifyOutboundFrame } from "./protocol-outbound-routing";
import { isListenerTransportOpen } from "./transport";
import type {
  ListenerConnectionId,
  ListenerConnectionState,
  ListenerRuntime,
} from "./types";

const PREFIX = "sayuri-project:";
const pendingByRuntime = new WeakMap<
  ListenerRuntime,
  { projects: Set<string>; running: boolean }
>();

function normalizedProjectId(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new Error("Sayuri projectId is required.");
  return value;
}

export function sayuriProjectSubscriptionKey(projectId: string): string {
  return (
    PREFIX +
    Buffer.from(normalizedProjectId(projectId), "utf8").toString("base64url")
  );
}

export function subscribeSayuriProject(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  projectId: string,
): boolean {
  const connection = runtime.connections.get(connectionId);
  if (!connection) return false;
  const key = sayuriProjectSubscriptionKey(projectId);
  connection.subscriptions.add(key);
  let ids = runtime.connectionIdsByRuntimeKey.get(key);
  if (!ids) {
    ids = new Set();
    runtime.connectionIdsByRuntimeKey.set(key, ids);
  }
  ids.add(connectionId);
  return true;
}

export function unsubscribeSayuriProject(
  runtime: ListenerRuntime,
  connectionId: ListenerConnectionId,
  projectId: string,
): boolean {
  return unsubscribeListenerConnection(
    runtime,
    connectionId,
    sayuriProjectSubscriptionKey(projectId),
  );
}

function subscribers(
  runtime: ListenerRuntime,
  projectId: string,
): ListenerConnectionState[] {
  const ids = runtime.connectionIdsByRuntimeKey.get(
    sayuriProjectSubscriptionKey(projectId),
  );
  if (!ids) return [];
  return [...ids]
    .map((id) => runtime.connections.get(id))
    .filter(
      (connection): connection is ListenerConnectionState =>
        connection?.initialized === true &&
        isListenerTransportOpen(connection.writer),
    )
    .sort((left, right) => left.ordinal - right.ordinal);
}

export async function emitSayuriProjectStateUpdate(
  runtime: ListenerRuntime,
  projectId: string,
): Promise<void> {
  const targets = subscribers(runtime, projectId);
  if (targets.length === 0) return;
  const snapshot = await getSayuriCognitiveControlSnapshot({ projectId });
  for (const connection of targets) {
    enqueueOutboundFrame(connection.writer, {
      typeLabel: "sayuri_state_update",
      frameClass: classifyOutboundFrame({ type: "sayuri_state_update" }),
      coalesceKey: `sayuri_state_update:${projectId}`,
      build: () => {
        const eventSeq = nextListenerConnectionEventSeq(connection, runtime);
        if (eventSeq === null) return null;
        const message: SayuriStateUpdateMessage = {
          type: "sayuri_state_update",
          project_id: projectId,
          snapshot,
          event_seq: eventSeq,
          emitted_at: new Date().toISOString(),
          idempotency_key: `sayuri_state_update:${eventSeq}:${crypto.randomUUID()}`,
        };
        return {
          payload: JSON.stringify(message),
          perfKey: "sayuri_state_update",
        };
      },
      onSendError: (error) => {
        debugWarn(
          "Sayuri state subscription",
          `Failed to send project "${projectId}" update`,
          error,
        );
      },
    });
  }
}

export function scheduleSayuriProjectStateUpdate(
  runtime: ListenerRuntime,
  projectId: string,
): void {
  let state = pendingByRuntime.get(runtime);
  if (!state) {
    state = { projects: new Set(), running: false };
    pendingByRuntime.set(runtime, state);
  }
  state.projects.add(normalizedProjectId(projectId));
  if (state.running) return;
  state.running = true;
  queueMicrotask(() => {
    void (async () => {
      try {
        while (state!.projects.size > 0) {
          const projects = [...state!.projects];
          state!.projects.clear();
          for (const project of projects) {
            try {
              await emitSayuriProjectStateUpdate(runtime, project);
            } catch (error) {
              debugWarn(
                "Sayuri state subscription",
                `Failed to refresh project "${project}"`,
                error,
              );
            }
          }
        }
      } finally {
        state!.running = false;
        if (state!.projects.size > 0) {
          scheduleSayuriProjectStateUpdate(runtime, [...state!.projects][0]!);
        }
      }
    })();
  });
}

export function installSayuriProjectStateEventRouting(
  runtime: ListenerRuntime,
): () => void {
  return subscribeToSayuriProjectStateChanges((change) => {
    scheduleSayuriProjectStateUpdate(runtime, change.projectId);
  });
}
