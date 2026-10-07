import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { SayuriCognitiveStateClient } from "@/sayuri/cognitive-state-client";
import type { SayuriCognitiveControlSnapshot } from "@/sayuri/control-plane";
import { Text } from "./Text";

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface SayuriCognitiveControlPanelProps {
  projectId: string;
  client: SayuriCognitiveStateClient;
  focused?: boolean;
  maxItems?: number;
  onError?: (error: Error) => void;
}

export interface SayuriCognitiveControlView {
  task: {
    id: string;
    goal: string;
    status: string;
    revision: number;
  } | null;
  planSteps: Array<{
    id: string;
    title: string;
    status: string;
  }>;
  activeBackground: Array<{
    id: string;
    status: string;
    label: string;
  }>;
  pendingCronIntents: Array<{
    id: string;
    title: string;
  }>;
  canConfirm: boolean;
  canCancel: boolean;
}

export function buildSayuriCognitiveControlView(
  snapshot: SayuriCognitiveControlSnapshot,
  maxItems = 3,
): SayuriCognitiveControlView {
  const selected = snapshot.selectedTask;
  const task = selected?.task ?? null;
  const visible = Math.max(0, maxItems);
  return {
    task: task
      ? {
          id: task.id,
          goal: task.goal,
          status: task.status,
          revision: task.revision,
        }
      : null,
    planSteps: (selected?.plan.steps ?? []).slice(0, visible).map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
    })),
    activeBackground: snapshot.background
      .filter((item) => ["leased", "running", "orphaned"].includes(item.status))
      .slice(0, visible)
      .map((item) => ({
        id: item.id,
        status: item.status,
        label: item.assignment?.trim() || item.id,
      })),
    pendingCronIntents: snapshot.cronIntents
      .filter((intent) => intent.status === "pending")
      .slice(0, visible)
      .map((intent) => ({ id: intent.id, title: intent.title })),
    canConfirm: task?.status === "waiting-user",
    canCancel: Boolean(task && !TERMINAL_TASK_STATUSES.has(task.status)),
  };
}

function stepGlyph(status: string): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in-progress":
      return "→";
    case "blocked":
      return "!";
    case "cancelled":
      return "×";
    default:
      return "·";
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function SayuriCognitiveControlPanel({
  projectId,
  client,
  focused = false,
  maxItems = 3,
  onError,
}: SayuriCognitiveControlPanelProps) {
  const [snapshot, setSnapshot] =
    useState<SayuriCognitiveControlSnapshot | null>(() =>
      client.getSnapshot(projectId),
    );
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);

  useEffect(() => {
    let active = true;
    let stop: (() => Promise<void>) | null = null;
    void client
      .watch(projectId, (next) => {
        if (active) {
          setSnapshot(next);
          setError(null);
        }
      })
      .then((unsubscribe) => {
        if (!active) {
          void unsubscribe().catch(() => {});
          return;
        }
        stop = unsubscribe;
      })
      .catch((cause) => {
        const next = asError(cause);
        if (active) setError(next);
        onError?.(next);
      });
    return () => {
      active = false;
      if (stop) void stop().catch(() => {});
    };
  }, [client, onError, projectId]);

  const view = useMemo(
    () =>
      snapshot ? buildSayuriCognitiveControlView(snapshot, maxItems) : null,
    [maxItems, snapshot],
  );

  const reportError = useCallback(
    (cause: unknown) => {
      const next = asError(cause);
      setError(next);
      onError?.(next);
    },
    [onError],
  );

  const confirm = useCallback(async () => {
    const task = view?.task;
    if (!task || !view.canConfirm || busy) return;
    setBusy("confirm");
    setError(null);
    try {
      await client.confirmTask({
        projectId,
        taskId: task.id,
        expectedRevision: task.revision,
      });
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  }, [busy, client, projectId, reportError, view]);

  const cancel = useCallback(async () => {
    const task = view?.task;
    if (!task || !view.canCancel || busy) return;
    setBusy("cancel");
    setError(null);
    try {
      await client.cancel(projectId, {
        kind: "task",
        task_id: task.id,
        expected_revision: task.revision,
      });
    } catch (cause) {
      reportError(cause);
    } finally {
      setBusy(null);
    }
  }, [busy, client, projectId, reportError, view]);

  useInput((input) => {
    if (!focused || busy) return;
    const key = input.toLowerCase();
    if (key === "c" && view?.canConfirm) void confirm();
    if (key === "x" && view?.canCancel) void cancel();
  });

  return (
    <Box flexDirection="column">
      <Text bold>Sayuri · Cognitive Control</Text>
      <Text dimColor>Project: {projectId}</Text>

      {!snapshot && !error && <Text dimColor>Loading cognitive state…</Text>}
      {error && <Text color="red">State error: {error.message}</Text>}

      {view?.task ? (
        <>
          <Text>
            Task: <Text bold>{view.task.status}</Text> · r{view.task.revision}
          </Text>
          <Text dimColor>{view.task.goal}</Text>
        </>
      ) : (
        snapshot && <Text dimColor>No active task.</Text>
      )}

      {view && view.planSteps.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Plan</Text>
          {view.planSteps.map((step) => (
            <Text key={step.id}>
              {stepGlyph(step.status)} {step.title}{" "}
              <Text dimColor>[{step.status}]</Text>
            </Text>
          ))}
        </Box>
      )}

      {view && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            Background: <Text bold>{view.activeBackground.length}</Text> active
          </Text>
          {view.activeBackground.map((item) => (
            <Text key={item.id} dimColor>
              · {item.label} [{item.status}]
            </Text>
          ))}
          <Text>
            Cron: <Text bold>{view.pendingCronIntents.length}</Text> pending
          </Text>
          {view.pendingCronIntents.map((intent) => (
            <Text key={intent.id} dimColor>
              · {intent.title}
            </Text>
          ))}
        </Box>
      )}

      {focused && view?.task && (
        <Box marginTop={1}>
          {view.canConfirm && (
            <Text color="green">
              {busy === "confirm" ? "Confirming…" : "[c] confirm"}{" "}
            </Text>
          )}
          {view.canCancel && (
            <Text color="yellow">
              {busy === "cancel" ? "Cancelling…" : "[x] cancel"}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
