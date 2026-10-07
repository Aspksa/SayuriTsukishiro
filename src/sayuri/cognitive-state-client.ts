import type {
  SayuriCancelCommand,
  SayuriCancelResponse,
  SayuriStateGetResponse,
  SayuriStateSubscribeResponse,
  SayuriStateUnsubscribeResponse,
  SayuriStateUpdateMessage,
  SayuriTaskConfirmResponse,
} from "@/types/sayuri-control-protocol";
import type { SayuriCognitiveControlSnapshot } from "./control-plane";
import type { SayuriTaskState } from "./task-lifecycle";

export interface SayuriCognitiveStateTransport {
  sayuriStateGet(command: {
    project_id: string;
    task_id?: string;
  }): Promise<SayuriStateGetResponse>;
  subscribeSayuriState(command: {
    project_id: string;
  }): Promise<SayuriStateSubscribeResponse>;
  unsubscribeSayuriState(command: {
    project_id: string;
  }): Promise<SayuriStateUnsubscribeResponse>;
  onSayuriStateUpdate(
    handler: (message: SayuriStateUpdateMessage) => void,
  ): () => void;
  confirmSayuriTask(command: {
    project_id: string;
    task_id: string;
    expected_revision: number;
  }): Promise<SayuriTaskConfirmResponse>;
  cancelSayuri(
    command: Omit<SayuriCancelCommand, "type" | "request_id">,
  ): Promise<SayuriCancelResponse>;
}

export type SayuriCognitiveStateListener = (
  snapshot: SayuriCognitiveControlSnapshot,
) => void;

type ProjectCacheEntry = {
  snapshot: SayuriCognitiveControlSnapshot | null;
  listeners: Set<SayuriCognitiveStateListener>;
  remoteSubscribed: boolean;
  subscribing: Promise<void> | null;
};

function projectId(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Sayuri projectId is required.");
  return normalized;
}

function responseError(
  response: { success: boolean; error?: string },
  fallback: string,
): Error {
  return new Error(response.error?.trim() || fallback);
}

export class SayuriCognitiveStateClient {
  readonly #transport: SayuriCognitiveStateTransport;
  readonly #projects = new Map<string, ProjectCacheEntry>();
  readonly #stopUpdates: () => void;
  #closed = false;

  constructor(transport: SayuriCognitiveStateTransport) {
    this.#transport = transport;
    this.#stopUpdates = transport.onSayuriStateUpdate((message) => {
      const id = projectId(message.project_id);
      const entry = this.#projects.get(id);
      if (!entry || !entry.remoteSubscribed) return;
      entry.snapshot = message.snapshot;
      this.notify(entry);
    });
  }

  getSnapshot(project: string): SayuriCognitiveControlSnapshot | null {
    return this.#projects.get(projectId(project))?.snapshot ?? null;
  }

  async watch(
    project: string,
    listener: SayuriCognitiveStateListener,
  ): Promise<() => Promise<void>> {
    if (this.#closed)
      throw new Error("Sayuri cognitive state client is closed.");
    const id = projectId(project);
    let entry = this.#projects.get(id);
    if (!entry) {
      entry = {
        snapshot: null,
        listeners: new Set(),
        remoteSubscribed: false,
        subscribing: null,
      };
      this.#projects.set(id, entry);
    }
    const alreadySubscribed = entry.remoteSubscribed;
    entry.listeners.add(listener);
    try {
      await this.ensureSubscribed(id, entry);
      if (alreadySubscribed && entry.snapshot) listener(entry.snapshot);
    } catch (error) {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.#projects.delete(id);
      throw error;
    }

    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      const current = this.#projects.get(id);
      if (!current) return;
      current.listeners.delete(listener);
      if (current.listeners.size > 0) return;
      this.#projects.delete(id);
      if (!current.remoteSubscribed) return;
      const response = await this.#transport.unsubscribeSayuriState({
        project_id: id,
      });
      if (!response.success) {
        throw responseError(
          response,
          `Failed to unsubscribe from Sayuri project "${id}".`,
        );
      }
    };
  }

  async refresh(project: string): Promise<SayuriCognitiveControlSnapshot> {
    const id = projectId(project);
    const response = await this.#transport.sayuriStateGet({ project_id: id });
    if (!response.success || !response.snapshot) {
      throw responseError(
        response,
        `Failed to refresh Sayuri project "${id}".`,
      );
    }
    const entry = this.#projects.get(id);
    if (entry) {
      entry.snapshot = response.snapshot;
      this.notify(entry);
    }
    return response.snapshot;
  }

  async confirmTask(input: {
    projectId: string;
    taskId: string;
    expectedRevision: number;
  }): Promise<SayuriTaskState> {
    const response = await this.#transport.confirmSayuriTask({
      project_id: projectId(input.projectId),
      task_id: input.taskId,
      expected_revision: input.expectedRevision,
    });
    if (!response.success || !response.task) {
      throw responseError(response, "Sayuri task confirmation failed.");
    }
    return response.task;
  }

  async cancel(
    project: string,
    target: Omit<
      SayuriCancelCommand,
      "type" | "request_id" | "project_id"
    >["target"],
  ): Promise<NonNullable<SayuriCancelResponse["result"]>> {
    const response = await this.#transport.cancelSayuri({
      project_id: projectId(project),
      target,
    });
    if (!response.success || !response.result) {
      throw responseError(response, "Sayuri cancellation failed.");
    }
    return response.result;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopUpdates();
    const projects = [...this.#projects.entries()];
    this.#projects.clear();
    const failures: Error[] = [];
    for (const [id, entry] of projects) {
      if (!entry.remoteSubscribed) continue;
      try {
        const response = await this.#transport.unsubscribeSayuriState({
          project_id: id,
        });
        if (!response.success) {
          failures.push(
            responseError(
              response,
              `Failed to unsubscribe from Sayuri project "${id}".`,
            ),
          );
        }
      } catch (error) {
        failures.push(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Failed to close Sayuri subscriptions.",
      );
    }
  }

  private async ensureSubscribed(
    id: string,
    entry: ProjectCacheEntry,
  ): Promise<void> {
    if (entry.remoteSubscribed) return;
    if (entry.subscribing) return entry.subscribing;
    entry.subscribing = (async () => {
      const response = await this.#transport.subscribeSayuriState({
        project_id: id,
      });
      if (!response.success || !response.snapshot) {
        throw responseError(
          response,
          `Failed to subscribe to Sayuri project "${id}".`,
        );
      }
      entry.remoteSubscribed = true;
      entry.snapshot = response.snapshot;
      this.notify(entry);
    })();
    try {
      await entry.subscribing;
    } finally {
      entry.subscribing = null;
    }
  }

  private notify(entry: ProjectCacheEntry): void {
    const snapshot = entry.snapshot;
    if (!snapshot) return;
    for (const listener of [...entry.listeners]) listener(snapshot);
  }
}
