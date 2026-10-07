import { describe, expect, test } from "bun:test";
import {
  publishSayuriProjectStateChanged,
  subscribeToSayuriProjectStateChanges,
} from "./state-events";

describe("Sayuri project state events", () => {
  test("publishes durable project changes and supports deterministic unsubscribe", () => {
    const seen: unknown[] = [];
    const unsubscribe = subscribeToSayuriProjectStateChanges((change) => {
      seen.push(change);
    });
    publishSayuriProjectStateChanged({
      projectId: "project-a",
      source: "task",
      changedAt: "2026-10-07T04:00:00.000Z",
    });
    unsubscribe();
    publishSayuriProjectStateChanged({
      projectId: "project-a",
      source: "background",
      changedAt: "2026-10-07T04:00:01.000Z",
    });
    expect(seen).toEqual([
      {
        projectId: "project-a",
        source: "task",
        changedAt: "2026-10-07T04:00:00.000Z",
      },
    ]);
  });
});
