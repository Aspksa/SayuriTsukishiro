import { resolvePiModelForAgent } from "@/backend/dev/pi-model-factory";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import type { SayuriPlannerSeed } from "./goal-manager";
import {
  SAYURI_RUNTIME_MODEL_HANDLE,
  SAYURI_RUNTIME_PROVIDER_TYPE,
} from "./model-gateway";
import {
  type ConfigureSayuriModelRuntimeInput,
  configureSayuriModelRuntime,
} from "./model-runtime";
import type { SayuriPlan } from "./planner";
import {
  buildSayuriPlannerV1Prompt,
  compileSayuriPlannerV1Plan,
  parseSayuriPlannerV1Proposal,
} from "./planner-v1";
import type { SayuriBrainStateStore } from "./state-store";
import {
  createSayuriTask,
  type SayuriTaskState,
  transitionSayuriTask,
} from "./task-lifecycle";

export interface SayuriPlannerRuntimeResult {
  task: SayuriTaskState;
  plan: SayuriPlan;
  rawProposal: unknown;
}

function assistantText(message: {
  content: ReadonlyArray<
    { type: "text"; text: string } | { type: string; [key: string]: unknown }
  >;
}): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

export async function requestSayuriPlannerV1Proposal(input: {
  seed: SayuriPlannerSeed;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  modelsRuntime?: LocalPiModelsRuntime;
}): Promise<unknown> {
  await configureSayuriModelRuntime(input.modelGateway);
  const runtime =
    input.modelsRuntime ??
    new LocalPiModelsRuntime({
      ...(input.modelGateway.storageDir
        ? { storageDir: input.modelGateway.storageDir }
        : {}),
    });
  const resolved = await resolvePiModelForAgent(
    SAYURI_RUNTIME_MODEL_HANDLE,
    { provider_type: SAYURI_RUNTIME_PROVIDER_TYPE },
    {
      localProviderAuthStorageDir: input.modelGateway.storageDir,
      modelsRuntime: runtime,
    },
  );
  if (
    resolved.provider !== SAYURI_RUNTIME_PROVIDER_TYPE ||
    resolved.model.provider !== SAYURI_RUNTIME_PROVIDER_TYPE ||
    resolved.model.id !== "DeepSeek-V4-Flash"
  ) {
    throw new Error(
      `Planner runtime resolved unexpected model ${resolved.model.provider}/${resolved.model.id}.`,
    );
  }

  const response = await runtime
    .streamSimple(
      resolved.model as never,
      {
        systemPrompt:
          "You are Sayuri Planner v1. Produce exactly one JSON proposal and no prose.",
        messages: [
          {
            role: "user",
            content: buildSayuriPlannerV1Prompt(input.seed),
            timestamp: Date.now(),
          },
        ],
      },
      {
        ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
        ...(resolved.timeout !== false ? { timeoutMs: resolved.timeout } : {}),
        ...(resolved.headers ? { headers: resolved.headers } : {}),
        maxRetries: 0,
      },
    )
    .result();

  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(
      `Sayuri planner model stopped with "${response.stopReason}".`,
    );
  }
  const text = assistantText(response as never);
  if (!text) throw new Error("Sayuri planner model returned no JSON text.");

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Sayuri planner model response is not strict JSON.");
  }
}

export async function planAndPersistSayuriTask(input: {
  seed: SayuriPlannerSeed;
  modelGateway: ConfigureSayuriModelRuntimeInput;
  stateStore: SayuriBrainStateStore;
  modelsRuntime?: LocalPiModelsRuntime;
  now?: string;
  planId?: string;
}): Promise<SayuriPlannerRuntimeResult> {
  const createdAt = input.now ?? new Date().toISOString();
  let task = createSayuriTask({
    id: input.seed.taskId,
    goal: input.seed.goal,
    now: createdAt,
  });
  task = transitionSayuriTask(task, "planning", createdAt);

  const rawProposal = await requestSayuriPlannerV1Proposal({
    seed: input.seed,
    modelGateway: input.modelGateway,
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
  });
  const proposal = parseSayuriPlannerV1Proposal(rawProposal, input.seed);
  const plan = compileSayuriPlannerV1Plan({
    seed: input.seed,
    proposal,
    ...(input.planId ? { planId: input.planId } : {}),
    createdAt,
  });

  task = transitionSayuriTask(task, "ready", createdAt);

  // Persistence happens only after strict parse + deterministic compilation.
  // A caller cannot obtain a ready task/plan pair from this function before it
  // has been durably written.
  await input.stateStore.saveSnapshot(task, plan);

  return { task, plan, rawProposal };
}
