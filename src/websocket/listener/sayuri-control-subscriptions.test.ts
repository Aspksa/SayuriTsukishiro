import { describe, expect, test } from "bun:test";
import {
  markListenerConnectionInitialized,
  openListenerConnection,
  suspendListenerConnection,
} from "./connection";
import { createRuntime } from "./lifecycle";
import {
  sayuriProjectSubscriptionKey,
  subscribeSayuriProject,
  unsubscribeSayuriProject,
} from "./sayuri-control-subscriptions";

function options() {
  return {
    connectionId: "connection-1",
    wsUrl: "ws://local",
    deviceId: "device-1",
    connectionName: "test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
}

function transport() {
  return {
    kind: "local" as const,
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

describe("Sayuri project state subscriptions", () => {
  test("reuses connection subscriptions so project subscriptions survive suspend/resume", () => {
    const runtime = createRuntime();
    openListenerConnection({
      runtime,
      connectionId: "connection-1",
      writer: transport(),
      options: options(),
    });
    markListenerConnectionInitialized(runtime, "connection-1");

    expect(
      subscribeSayuriProject(runtime, "connection-1", "project-a"),
    ).toBe(true);
    const key = sayuriProjectSubscriptionKey("project-a");
    expect(runtime.connectionIdsByRuntimeKey.get(key)?.has("connection-1")).toBe(
      true,
    );

    suspendListenerConnection(runtime, "connection-1");
    openListenerConnection({
      runtime,
      connectionId: "connection-1",
      writer: transport(),
      options: options(),
    });
    markListenerConnectionInitialized(runtime, "connection-1");
    expect(runtime.connectionIdsByRuntimeKey.get(key)?.has("connection-1")).toBe(
      true,
    );

    expect(
      unsubscribeSayuriProject(runtime, "connection-1", "project-a"),
    ).toBe(true);
    expect(runtime.connectionIdsByRuntimeKey.has(key)).toBe(false);
  });
});
