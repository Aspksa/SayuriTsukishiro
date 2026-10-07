import { resolvePiModelForAgent } from "@/backend/dev/pi-model-factory";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  createOrUpdateLocalProvider,
  getLocalProviderRecordByName,
} from "@/backend/local/local-provider-auth-store";
import type { RuntimeModelRoute } from "@/runtime-context";
import {
  createSayuriModelGatewayConfig,
  type RedactedSayuriModelGatewayConfig,
  redactSayuriModelGatewayConfig,
  SAYURI_MODEL_ID,
  SAYURI_RUNTIME_MODEL_HANDLE,
  SAYURI_RUNTIME_PROVIDER_NAME,
  SAYURI_RUNTIME_PROVIDER_TYPE,
  type SayuriModelGatewayInput,
} from "./model-gateway";

export interface ConfigureSayuriModelRuntimeInput
  extends SayuriModelGatewayInput {
  storageDir?: string;
}

export interface SayuriModelRuntimeDescriptor {
  gateway: RedactedSayuriModelGatewayConfig;
  modelHandle: typeof SAYURI_RUNTIME_MODEL_HANDLE;
  modelSettings: {
    provider_type: typeof SAYURI_RUNTIME_PROVIDER_TYPE;
  };
}

export function buildSayuriRuntimeModelRoute(): RuntimeModelRoute {
  return {
    modelHandle: SAYURI_RUNTIME_MODEL_HANDLE,
    providerType: SAYURI_RUNTIME_PROVIDER_TYPE,
    exact: true,
  };
}

export async function configureSayuriModelRuntime(
  input: ConfigureSayuriModelRuntimeInput,
): Promise<SayuriModelRuntimeDescriptor> {
  const config = createSayuriModelGatewayConfig(input);
  await createOrUpdateLocalProvider({
    providerType: SAYURI_RUNTIME_PROVIDER_TYPE,
    providerName: SAYURI_RUNTIME_PROVIDER_NAME,
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    ...(input.storageDir ? { storageDir: input.storageDir } : {}),
  });

  return {
    gateway: redactSayuriModelGatewayConfig(config),
    modelHandle: SAYURI_RUNTIME_MODEL_HANDLE,
    modelSettings: { provider_type: SAYURI_RUNTIME_PROVIDER_TYPE },
  };
}

export async function verifySayuriModelRuntime(input: {
  storageDir?: string;
  modelsRuntime?: LocalPiModelsRuntime;
}): Promise<{
  provider: typeof SAYURI_RUNTIME_PROVIDER_TYPE;
  model: typeof SAYURI_MODEL_ID;
  modelHandle: typeof SAYURI_RUNTIME_MODEL_HANDLE;
  baseUrl: string;
}> {
  const record = getLocalProviderRecordByName(
    SAYURI_RUNTIME_PROVIDER_NAME,
    input.storageDir,
  );
  if (!record) {
    throw new Error("Sayuri Cloud.ru runtime is not configured.");
  }
  if (
    record.provider_type !== SAYURI_RUNTIME_PROVIDER_TYPE ||
    !record.base_url?.trim()
  ) {
    throw new Error("Sayuri Cloud.ru runtime configuration is invalid.");
  }

  const modelsRuntime =
    input.modelsRuntime ??
    new LocalPiModelsRuntime({
      ...(input.storageDir ? { storageDir: input.storageDir } : {}),
    });
  const resolved = await resolvePiModelForAgent(
    SAYURI_RUNTIME_MODEL_HANDLE,
    { provider_type: SAYURI_RUNTIME_PROVIDER_TYPE },
    {
      localProviderAuthStorageDir: input.storageDir,
      modelsRuntime,
    },
  );

  if (
    resolved.provider !== SAYURI_RUNTIME_PROVIDER_TYPE ||
    resolved.model.provider !== SAYURI_RUNTIME_PROVIDER_TYPE ||
    resolved.model.id !== SAYURI_MODEL_ID
  ) {
    throw new Error(
      `Sayuri model route resolved unexpectedly to ${resolved.model.provider}/${resolved.model.id}.`,
    );
  }

  return {
    provider: SAYURI_RUNTIME_PROVIDER_TYPE,
    model: SAYURI_MODEL_ID,
    modelHandle: SAYURI_RUNTIME_MODEL_HANDLE,
    baseUrl: record.base_url,
  };
}
