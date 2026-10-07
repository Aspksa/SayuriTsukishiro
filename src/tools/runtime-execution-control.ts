import type {
  RuntimeContextSnapshot,
  RuntimeToolExecutionControl,
  RuntimeToolExecutionKind,
  RuntimeToolExecutionRequest,
} from "@/runtime-context";

export interface RuntimeToolExecutionStart {
  allowed: boolean;
  reason?: string;
  executionId?: string;
  request: RuntimeToolExecutionRequest;
  control?: RuntimeToolExecutionControl;
  startedAt: number;
}

export async function beginRuntimeToolExecution(
  executionScope: RuntimeContextSnapshot,
  input: {
    toolName: string;
    toolKind: RuntimeToolExecutionKind;
    toolCallId?: string | null;
    args: Record<string, unknown>;
    workingDirectory: string;
  },
): Promise<RuntimeToolExecutionStart> {
  const request: RuntimeToolExecutionRequest = {
    toolName: input.toolName,
    toolKind: input.toolKind,
    toolCallId: input.toolCallId,
    args: { ...input.args },
    workingDirectory: input.workingDirectory,
    agentId: executionScope.agentId,
    conversationId: executionScope.conversationId,
  };
  const startedAt = Date.now();
  const control = executionScope.toolExecutionControl;
  if (!control) {
    return { allowed: true, request, startedAt };
  }

  try {
    const decision = await control.authorize(request);
    return {
      allowed: decision.decision === "allow",
      reason: decision.reason,
      executionId: decision.executionId,
      request,
      control,
      startedAt,
    };
  } catch (error) {
    return {
      allowed: false,
      reason: `Execution control failed closed: ${error instanceof Error ? error.message : String(error)}`,
      request,
      control,
      startedAt,
    };
  }
}

export async function finishRuntimeToolExecution(
  execution: RuntimeToolExecutionStart,
  status: "success" | "error",
  durationMs: number = Date.now() - execution.startedAt,
): Promise<string | null> {
  if (!execution.allowed || !execution.control?.record) {
    return null;
  }

  try {
    await execution.control.record({
      request: execution.request,
      executionId: execution.executionId,
      status,
      durationMs: Math.max(0, durationMs),
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
