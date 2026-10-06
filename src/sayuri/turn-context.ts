import type { SendMessageStreamOptions } from "@/agent/message";
import type { RuntimeContextSnapshot } from "@/runtime-context";
import type { SayuriExecutionController } from "./execution-control";
import {
  buildSayuriRuntimeModelRoute,
} from "./model-runtime";
import { SAYURI_RUNTIME_MODEL_HANDLE } from "./model-gateway";
import { resolveSayuriWorkspaceSandbox } from "./workspace-sandbox";

/**
 * Produce the runtime patch that binds one prepared tool snapshot to the active
 * Sayuri execution controller. This is intentionally explicit: simply creating
 * a controller does not globally affect unrelated conversations.
 */
export function buildSayuriTurnRuntimeContext(input: {
  controller: SayuriExecutionController;
  agentId?: string | null;
  conversationId: string;
}): Partial<RuntimeContextSnapshot> {
  const { sandbox } = resolveSayuriWorkspaceSandbox(
    input.controller.scopeRoot,
  );
  return {
    toolExecutionControl: input.controller.runtimeControl,
    modelRoute: buildSayuriRuntimeModelRoute(),
    permissionMode: "standard",
    workingDirectory: input.controller.scopeRoot,
    conversationId: input.conversationId,
    ...(sandbox ? { workspaceSandbox: sandbox } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  };
}

export function withSayuriTurnOptions(
  options: SendMessageStreamOptions,
  input: {
    controller: SayuriExecutionController;
    agentId?: string | null;
    conversationId: string;
  },
): SendMessageStreamOptions {
  if (
    options.overrideModel !== undefined &&
    options.overrideModel !== SAYURI_RUNTIME_MODEL_HANDLE
  ) {
    throw new Error(
      `Sayuri turn cannot override model "${options.overrideModel}". Expected "${SAYURI_RUNTIME_MODEL_HANDLE}".`,
    );
  }

  return {
    ...options,
    overrideModel: SAYURI_RUNTIME_MODEL_HANDLE,
    workingDirectory: options.workingDirectory ?? input.controller.scopeRoot,
    agentId: options.agentId ?? input.agentId ?? undefined,
    runtimeContext: {
      ...(options.runtimeContext ?? {}),
      ...buildSayuriTurnRuntimeContext(input),
    },
  };
}
