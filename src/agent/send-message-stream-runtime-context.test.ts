import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import type { RuntimeToolExecutionControl } from "@/runtime-context";
import {
  getExecutionContextById,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  getStreamToolContextId,
  sendMessageStreamWithBackend,
} from "./message";

describe("sendMessageStream runtime execution control propagation", () => {
  test("captures turn-scoped execution control in the tool context", async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {},
    } as unknown as Stream<LettaStreamingResponse>;
    const backend = {
      createConversationMessageStream: async () => stream,
    } as unknown as Backend;
    const control: RuntimeToolExecutionControl = {
      authorize: () => ({
        decision: "deny",
        reason: "test boundary",
      }),
    };

    const returned = await sendMessageStreamWithBackend(
      backend,
      "conv-sayuri",
      [{ role: "user", content: "hello" }],
      {
        agentId: "agent-sayuri",
        skillSources: [],
        runtimeContext: {
          toolExecutionControl: control,
          permissionMode: "standard",
        },
      },
    );

    const contextId = getStreamToolContextId(returned);
    expect(contextId).not.toBeNull();
    if (!contextId) throw new Error("Expected tool execution context id");

    try {
      const captured = getExecutionContextById(contextId)?.runtimeContext;
      expect(captured?.toolExecutionControl).toBe(control);
      expect(captured?.conversationId).toBe("conv-sayuri");
      expect(captured?.agentId).toBe("agent-sayuri");
      expect(captured?.permissionMode).toBe("standard");
    } finally {
      releaseToolExecutionContext(contextId);
    }
  });
});
