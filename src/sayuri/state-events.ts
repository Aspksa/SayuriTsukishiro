import { debugWarn } from "@/utils/debug";

export type SayuriProjectStateChangeSource =
  | "task"
  | "background"
  | "cron-intent";

export interface SayuriProjectStateChange {
  projectId: string;
  source: SayuriProjectStateChangeSource;
  changedAt: string;
}

export type SayuriProjectStateChangeListener = (
  change: SayuriProjectStateChange,
) => void;

const listeners = new Set<SayuriProjectStateChangeListener>();

export function subscribeToSayuriProjectStateChanges(
  listener: SayuriProjectStateChangeListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishSayuriProjectStateChanged(input: {
  projectId: string;
  source: SayuriProjectStateChangeSource;
  changedAt?: string;
}): void {
  const projectId = input.projectId.trim();
  if (!projectId) throw new Error("Sayuri state event projectId is required.");
  const event: SayuriProjectStateChange = {
    projectId,
    source: input.source,
    changedAt: input.changedAt ?? new Date().toISOString(),
  };
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      debugWarn(
        "Sayuri state event",
        `Observer failed for project "${projectId}"`,
        error,
      );
    }
  }
}
