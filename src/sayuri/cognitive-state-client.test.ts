import { describe, expect, mock, test } from "bun:test";
import type {
  SayuriStateUpdateMessage,
} from "@/types/sayuri-control-protocol";
import {
  SayuriCognitiveStateClient,
  type SayuriCognitiveStateTransport,
} from "./cognitive-state-client";

function snapshot(revision: number) {
  return {
    projectId: "project-a",
    tasks: [
      {
        projectId: "project-a",
        taskId: "task-1",
        planId: "plan-1",
        agentId: "agent-1",
        conversationId: "default",
        goal: "Build",
        status: "running" as const,
        revision,
        updatedAt: "2026-10-07T04:00:00.000Z",
        checkpointCount: 0,
      },
    ],
    selectedTask: null,
    background: [],
    cronIntents: [],
  };
}

function transport() {
  let push: ((message: SayuriStateUpdateMessage) => void) | null = null;
  const subscribe = mock(async () => ({
    type: "sayuri_state_subscribe_response" as const,
    request_id: "sub",
    success: true,
    snapshot: snapshot(1),
  }));
  const unsubscribe = mock(async () => ({
    type: "sayuri_state_unsubscribe_response" as const,
    request_id: "unsub",
    success: true,
    unsubscribed: true,
  }));
  const api: SayuriCognitiveStateTransport = {
    sayuriStateGet: async () => ({
      type: "sayuri_state_get_response",
      request_id: "get",
      success: true,
      snapshot: snapshot(3),
    }),
    subscribeSayuriState: subscribe,
    unsubscribeSayuriState: unsubscribe,
    onSayuriStateUpdate: (handler) => {
      push = handler;
      return () => {
        push = null;
      };
    },
    confirmSayuriTask: async (command) => ({
      type: "sayuri_task_confirm_response",
      request_id: "confirm",
      success: true,
      task: {
        id: command.task_id,
        goal: "Build",
        status: "running",
        revision: command.expected_revision + 1,
        createdAt: "2026-10-07T04:00:00.000Z",
        updatedAt: "2026-10-07T04:01:00.000Z",
        checkpoints: [],
      },
    }),
    cancelSayuri: async (command) => ({
      type: "sayuri_cancel_response",
      request_id: "cancel",
      success: true,
      result:
        command.target.kind === "task"
          ? {
              kind: "task",
              task: {
                id: command.target.task_id,
                goal: "Build",
                status: "cancelled",
                revision: command.target.expected_revision + 1,
                createdAt: "2026-10-07T04:00:00.000Z",
                updatedAt: "2026-10-07T04:02:00.000Z",
                checkpoints: [],
              },
            }
          : undefined,
    }),
  };
  return {
    api,
    subscribe,
    unsubscribe,
    push: (message: SayuriStateUpdateMessage) => push?.(message),
  };
}

describe("Sayuri cognitive state client", () => {
  test("shares one remote subscription and fans updates out to local watchers", async () => {
    const fake = transport();
    const client = new SayuriCognitiveStateClient(fake.api);
    const left: number[] = [];
    const right: number[] = [];
    const unwatchLeft = await client.watch("project-a", (value) => {
      left.push(value.tasks[0]?.revision ?? 0);
    });
    const unwatchRight = await client.watch("project-a", (value) => {
      right.push(value.tasks[0]?.revision ?? 0);
    });
    expect(fake.subscribe).toHaveBeenCalledTimes(1);
    expect(left).toEqual([1]);
    expect(right).toEqual([1]);

    fake.push({
      type: "sayuri_state_update",
      project_id: "project-a",
      snapshot: snapshot(2),
      event_seq: 1,
      emitted_at: "2026-10-07T04:03:00.000Z",
      idempotency_key: "update-1",
    });
    expect(left.at(-1)).toBe(2);
    expect(right.at(-1)).toBe(2);

    await unwatchLeft();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(0);
    await unwatchRight();
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  test("refreshes cached state and forwards revision-guarded mutations", async () => {
    const fake = transport();
    const client = new SayuriCognitiveStateClient(fake.api);
    const seen: number[] = [];
    const unwatch = await client.watch("project-a", (value) => {
      seen.push(value.tasks[0]?.revision ?? 0);
    });
    expect((await client.refresh("project-a")).tasks[0]?.revision).toBe(3);
    expect(seen.at(-1)).toBe(3);

    const confirmed = await client.confirmTask({
      projectId: "project-a",
      taskId: "task-1",
      expectedRevision: 3,
    });
    expect(confirmed.revision).toBe(4);
    const cancelled = await client.cancel("project-a", {
      kind: "task",
      task_id: "task-1",
      expected_revision: 4,
    });
    expect(cancelled.kind).toBe("task");
    await unwatch();
  });
});
