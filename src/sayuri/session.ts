import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import {
  sendMessageStreamWithBackend,
  type SendMessageStreamOptions,
  type SendMessageStreamRequestOptions,
} from "@/agent/message";
import { getBackend, type Backend } from "@/backend";
import type { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  createDurableSayuriExecutionController,
  resumeSayuriExecutionController,
  type SayuriExecutionController,
} from "./execution-control";
import {
  configureSayuriModelRuntime,
  type ConfigureSayuriModelRuntimeInput,
  type SayuriModelRuntimeDescriptor,
  verifySayuriModelRuntime,
} from "./model-runtime";
import type { SayuriPlan } from "./planner";
import {
  FileSayuriBrainStateStore,
  type SayuriBrainStateStore,
} from "./state-store";
import {
  createSayuriTask,
  transitionSayuriTask,
} from "./task-lifecycle";
import { withSayuriTurnOptions } from "./turn-context";

export interface SayuriPrimarySession {
  agentId: string;
  conversationId: string;
  controller: SayuriExecutionController;
  stateStore: SayuriBrainStateStore;
  modelRuntime: SayuriModelRuntimeDescriptor;
  resumed: boolean;
}

export interface BootstrapSayuriPrimarySessionInput {
  agentId: string;
  conversationId: string;
  taskId: string;
  scopeRoot: string;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  stateStore?: SayuriBrainStateStore;
  modelsRuntime?: LocalPiModelsRuntime;
  goal?: string;
  plan?: SayuriPlan;
  now?: string;
}

function assertSessionIdentity(input: BootstrapSayuriPrimarySessionInput): void {
  if (!input.agentId.trim()) throw new Error("Sayuri session agentId is required.");
  if (!input.conversationId.trim()) {
    throw new Error("Sayuri session conversationId is required.");
  }
  if (!input.taskId.trim()) throw new Error("Sayuri session taskId is required.");
  if (!input.scopeRoot.trim()) {
    throw new Error("Sayuri session scopeRoot is required.");
  }
}

function assertNewTaskInput(
  input: BootstrapSayuriPrimarySessionInput,
): asserts input is BootstrapSayuriPrimarySessionInput & {
  goal: string;
  plan: SayuriPlan;
} {
  if (!input.goal?.trim()) {
    throw new Error("A new Sayuri session requires a task goal.");
  }
  if (!input.plan) {
    throw new Error("A new Sayuri session requires a validated plan.");
  }
  if (input.plan.taskId !== input.taskId) {
    throw new Error("New Sayuri plan taskId must match session taskId.");
  }
}

function createRunningTask(input: {
  taskId: string;
  goal: string;
  now?: string;
}) {
  const createdAt = input.now ?? new Date().toISOString();
  let task = createSayuriTask({
    id: input.taskId,
    goal: input.goal,
    now: createdAt,
  });
  task = transitionSayuriTask(task, "planning", createdAt);
  task = transitionSayuriTask(task, "ready", createdAt);
  return transitionSayuriTask(task, "running", createdAt);
}

export async function bootstrapSayuriPrimarySession(
  input: BootstrapSayuriPrimarySessionInput,
): Promise<SayuriPrimarySession> {
  assertSessionIdentity(input);

  const modelRuntime = await configureSayuriModelRuntime(input.modelGateway);
  await verifySayuriModelRuntime({
    storageDir: input.modelGateway.storageDir,
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
  });

  const stateStore = input.stateStore ?? new FileSayuriBrainStateStore();
  const snapshot = await stateStore.loadSnapshot(input.taskId);

  let controller: SayuriExecutionController;
  let resumed = false;
  if (snapshot) {
    if (input.goal && input.goal.trim() !== snapshot.task.goal) {
      throw new Error(
        "Refusing to resume Sayuri task with a different goal.",
      );
    }
    if (
      input.plan &&
      JSON.stringify(input.plan) !== JSON.stringify(snapshot.plan)
    ) {
      throw new Error(
        "Refusing to replace a durable Sayuri plan during session resume.",
      );
    }
    controller = await resumeSayuriExecutionController({
      stateStore,
      taskId: input.taskId,
      scopeRoot: input.scopeRoot,
    });
    resumed = true;
  } else {
    assertNewTaskInput(input);
    controller = await createDurableSayuriExecutionController({
      task: createRunningTask({
        taskId: input.taskId,
        goal: input.goal,
        ...(input.now ? { now: input.now } : {}),
      }),
      plan: input.plan,
      scopeRoot: input.scopeRoot,
      stateStore,
    });
  }

  return {
    agentId: input.agentId,
    conversationId: input.conversationId,
    controller,
    stateStore,
    modelRuntime,
    resumed,
  };
}

export async function sendSayuriSessionMessage(input: {
  session: SayuriPrimarySession;
  messages: Array<MessageCreate | ApprovalCreate>;
  options?: SendMessageStreamOptions;
  requestOptions?: SendMessageStreamRequestOptions;
  backend?: Backend;
}): Promise<Stream<LettaStreamingResponse>> {
  const backend = input.backend ?? getBackend();
  const options = withSayuriTurnOptions(input.options ?? {}, {
    controller: input.session.controller,
    agentId: input.session.agentId,
    conversationId: input.session.conversationId,
  });

  return sendMessageStreamWithBackend(
    backend,
    input.session.conversationId,
    input.messages,
    options,
    input.requestOptions,
  );
}
