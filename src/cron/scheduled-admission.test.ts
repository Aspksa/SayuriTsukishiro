import { describe, expect, test } from "bun:test";
import type { CronTask } from "./cron-file";
import {
  registerScheduledTaskAdmissionHandler,
  tryAdmitScheduledTask,
} from "./scheduled-admission";

const task = {
  id: "cron-test",
  agent_id: "agent",
  conversation_id: "default",
  name: "test",
  description: "",
  cron: "* * * * *",
  timezone: "UTC",
  recurring: true,
  prompt: "hello",
  status: "active",
  created_at: "2026-10-06T12:00:00.000Z",
  expires_at: null,
  last_fired_at: null,
  fire_count: 0,
  cancel_reason: null,
  jitter_offset_ms: 0,
  last_run_at: null,
  last_run_outcome: null,
  last_run_reason: null,
  last_run_error: null,
  last_missed_at: null,
  missed_count: 0,
  failed_count: 0,
  scheduled_for: null,
  fired_at: null,
  missed_at: null,
} satisfies CronTask;

describe("scheduled task admission hook", () => {
  test("is a no-op when no admission handler is installed", async () => {
    expect(
      await tryAdmitScheduledTask({
        task,
        timing: {
          intendedOccurrence: new Date("2026-10-06T13:00:00.000Z"),
          schedulerNow: new Date("2026-10-06T13:00:01.000Z"),
        },
        trigger: "automatic",
      }),
    ).toEqual({ handled: false });
  });

  test("allows a registered handler to consume a trigger without executing it", async () => {
    const dispose = registerScheduledTaskAdmissionHandler(async () => ({
      handled: true,
      accepted: true,
      referenceId: "intent-1",
    }));
    try {
      expect(
        await tryAdmitScheduledTask({
          task,
          timing: {
            intendedOccurrence: new Date("2026-10-06T13:00:00.000Z"),
            schedulerNow: new Date("2026-10-06T13:00:01.000Z"),
          },
          trigger: "automatic",
        }),
      ).toMatchObject({
        handled: true,
        accepted: true,
        referenceId: "intent-1",
      });
    } finally {
      dispose();
    }
  });
});
