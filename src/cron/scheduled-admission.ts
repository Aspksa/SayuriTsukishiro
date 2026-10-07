import type { CronTask } from "./cron-file";
import type { CronPromptTiming } from "./prompt";

export interface ScheduledTaskAdmissionInput {
  task: CronTask;
  timing: CronPromptTiming;
  trigger: "automatic" | "manual";
}

export type ScheduledTaskAdmissionResult =
  | { handled: false }
  | {
      handled: true;
      accepted: boolean;
      referenceId?: string;
      summary?: string;
      error?: string;
    };

export type ScheduledTaskAdmissionHandler = (
  input: ScheduledTaskAdmissionInput,
) => Promise<ScheduledTaskAdmissionResult>;

let scheduledTaskAdmissionHandler: ScheduledTaskAdmissionHandler | null = null;

export function registerScheduledTaskAdmissionHandler(
  handler: ScheduledTaskAdmissionHandler,
): () => void {
  scheduledTaskAdmissionHandler = handler;
  return () => {
    if (scheduledTaskAdmissionHandler === handler) {
      scheduledTaskAdmissionHandler = null;
    }
  };
}

export async function tryAdmitScheduledTask(
  input: ScheduledTaskAdmissionInput,
): Promise<ScheduledTaskAdmissionResult> {
  if (!scheduledTaskAdmissionHandler) return { handled: false };
  return scheduledTaskAdmissionHandler(input);
}
