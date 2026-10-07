import { describe, expect, test } from "bun:test";
import {
  isSayuriCancelCommand,
  isSayuriControlCommand,
  isSayuriStateGetCommand,
  isSayuriStateSubscribeCommand,
  isSayuriStateUnsubscribeCommand,
  isSayuriTaskConfirmCommand,
} from "./sayuri-control-protocol-inbound";

describe("Sayuri control protocol validation", () => {
  test("accepts the explicit cognitive-control commands", () => {
    expect(
      isSayuriStateGetCommand({
        type: "sayuri_state_get",
        request_id: "r1",
        project_id: "p1",
      }),
    ).toBe(true);
    expect(
      isSayuriStateSubscribeCommand({
        type: "sayuri_state_subscribe",
        request_id: "r1s",
        project_id: "p1",
      }),
    ).toBe(true);
    expect(
      isSayuriStateUnsubscribeCommand({
        type: "sayuri_state_unsubscribe",
        request_id: "r1u",
        project_id: "p1",
      }),
    ).toBe(true);
    expect(
      isSayuriTaskConfirmCommand({
        type: "sayuri_task_confirm",
        request_id: "r2",
        project_id: "p1",
        task_id: "t1",
        expected_revision: 2,
      }),
    ).toBe(true);
    expect(
      isSayuriCancelCommand({
        type: "sayuri_cancel",
        request_id: "r3",
        project_id: "p1",
        target: { kind: "background", lease_id: "lease-1" },
      }),
    ).toBe(true);
  });

  test("rejects generic lifecycle/status mutation shapes", () => {
    expect(
      isSayuriControlCommand({
        type: "sayuri_task_confirm",
        request_id: "r4",
        project_id: "p1",
        task_id: "t1",
        expected_revision: 2,
        status: "completed",
      }),
    ).toBe(false);
    expect(
      isSayuriControlCommand({
        type: "sayuri_set_task_status",
        request_id: "r5",
        project_id: "p1",
        task_id: "t1",
        status: "completed",
      }),
    ).toBe(false);
    expect(
      isSayuriCancelCommand({
        type: "sayuri_cancel",
        request_id: "r6",
        project_id: "p1",
        target: { kind: "task", task_id: "t1", expected_revision: -1 },
      }),
    ).toBe(false);
  });
});
