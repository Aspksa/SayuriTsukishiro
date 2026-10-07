import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import { getLocalProviderRecordByName } from "@/backend/local/local-provider-auth-store";
import {
  SAYURI_MODEL_ID,
  SAYURI_RUNTIME_MODEL_HANDLE,
  SAYURI_RUNTIME_PROVIDER_NAME,
  SAYURI_RUNTIME_PROVIDER_TYPE,
} from "./model-gateway";
import {
  buildSayuriRuntimeModelRoute,
  configureSayuriModelRuntime,
  verifySayuriModelRuntime,
} from "./model-runtime";

describe("Sayuri Cloud.ru model runtime", () => {
  const storageDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      storageDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test("persists one exact OpenAI-compatible Cloud.ru route without exposing the key", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "sayuri-cloudru-"));
    storageDirs.push(storageDir);

    const descriptor = await configureSayuriModelRuntime({
      baseUrl: "https://cloud.example.test/v1/",
      apiKey: "cloud-secret-api-key",
      storageDir,
    });

    expect(descriptor.modelHandle).toBe(SAYURI_RUNTIME_MODEL_HANDLE);
    expect(descriptor.gateway.apiKey).not.toBe("cloud-secret-api-key");
    expect(descriptor.gateway.model).toBe(SAYURI_MODEL_ID);
    expect(buildSayuriRuntimeModelRoute()).toEqual({
      modelHandle: SAYURI_RUNTIME_MODEL_HANDLE,
      providerType: SAYURI_RUNTIME_PROVIDER_TYPE,
      exact: true,
    });
    expect(
      getLocalProviderRecordByName(SAYURI_RUNTIME_PROVIDER_NAME, storageDir),
    ).toMatchObject({
      provider_type: SAYURI_RUNTIME_PROVIDER_TYPE,
      base_url: "https://cloud.example.test/v1",
      auth: { type: "api", key: "cloud-secret-api-key" },
    });
  });

  test("resolves only DeepSeek-V4-Flash and passes no fallback model id", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "sayuri-cloudru-"));
    storageDirs.push(storageDir);
    await configureSayuriModelRuntime({
      baseUrl: "https://cloud.example.test/v1",
      apiKey: "cloud-key",
      storageDir,
    });

    const requested: string[] = [];
    const runtime = new LocalPiModelsRuntime({
      storageDir,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [
              { id: SAYURI_MODEL_ID, object: "model" },
              { id: "some-other-model", object: "model" },
            ],
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });

    let fallback: string | undefined = "not-called";
    const originalResolveTurn = runtime.resolveTurn.bind(runtime);
    runtime.resolveTurn = async (
      providerId,
      modelId,
      fallbackModelId,
      abortSignal,
    ) => {
      fallback = fallbackModelId;
      return originalResolveTurn(
        providerId,
        modelId,
        fallbackModelId,
        abortSignal,
      );
    };

    const verified = await verifySayuriModelRuntime({
      storageDir,
      modelsRuntime: runtime,
    });

    expect(verified).toMatchObject({
      provider: SAYURI_RUNTIME_PROVIDER_TYPE,
      model: SAYURI_MODEL_ID,
      modelHandle: SAYURI_RUNTIME_MODEL_HANDLE,
    });
    expect(fallback).toBeUndefined();
    expect(requested).toContain("/v1/models");
  });

  test("fails closed when the exact Sayuri model is absent", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "sayuri-cloudru-"));
    storageDirs.push(storageDir);
    await configureSayuriModelRuntime({
      baseUrl: "https://cloud.example.test/v1",
      apiKey: "cloud-key",
      storageDir,
    });

    const runtime = new LocalPiModelsRuntime({
      storageDir,
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/models") {
          return Response.json({
            data: [{ id: "wrong-model", object: "model" }],
          });
        }
        return new Response("not found", { status: 404 });
      }) as typeof fetch,
    });

    await expect(
      verifySayuriModelRuntime({ storageDir, modelsRuntime: runtime }),
    ).rejects.toThrow(SAYURI_MODEL_ID);
  });
});
