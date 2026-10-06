import { describe, expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import {
  getRuntimeContext,
  type RuntimeModelRoute,
} from "@/runtime-context";
import { sendMessageStreamWithBackend } from "./message";

describe("sendMessageStream model route propagation", () => {
  test("runs backend turn creation inside the captured runtime model route", async () => {
    const route: RuntimeModelRoute = {
      modelHandle: "openai-compatible/DeepSeek-V4-Flash",
      providerType: "openai-compatible",
      exact: true,
    };
    let observed: RuntimeModelRoute | undefined;
    const stream = {
      async *[Symbol.asyncIterator]() {},
    } as unknown as Stream<LettaStreamingResponse>;
    const backend = {
      createConversationMessageStream: async () => {
        observed = getRuntimeContext()?.modelRoute;
        return stream;
      },
    } as unknown as Backend;

    await sendMessageStreamWithBackend(
      backend,
      "conv-model-route",
      [{ role: "user", content: "hello" }],
      {
        agentId: "agent-model-route",
        skillSources: [],
        runtimeContext: { modelRoute: route },
      },
    );

    expect(observed).toEqual(route);
  });
});
