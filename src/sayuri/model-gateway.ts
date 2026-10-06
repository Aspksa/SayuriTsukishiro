export const SAYURI_MODEL_PROVIDER = "cloud.ru";
export const SAYURI_MODEL_ID = "DeepSeek-V4-Flash";
export const SAYURI_RUNTIME_PROVIDER_TYPE = "openai-compatible";
export const SAYURI_RUNTIME_PROVIDER_NAME = "openai-compatible";
export const SAYURI_RUNTIME_MODEL_HANDLE =
  `${SAYURI_RUNTIME_PROVIDER_TYPE}/${SAYURI_MODEL_ID}`;

export interface SayuriModelGatewayInput {
  baseUrl: string;
  apiKey: string;
  provider?: string;
  model?: string;
  allowFallbacks?: boolean;
}

export interface SayuriModelGatewayConfig {
  provider: typeof SAYURI_MODEL_PROVIDER;
  model: typeof SAYURI_MODEL_ID;
  baseUrl: string;
  apiKey: string;
  allowFallbacks: false;
}

export interface RedactedSayuriModelGatewayConfig {
  provider: typeof SAYURI_MODEL_PROVIDER;
  model: typeof SAYURI_MODEL_ID;
  baseUrl: string;
  apiKey: string;
  allowFallbacks: false;
}

function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "");
  if (!value) throw new Error("Cloud.ru base URL is required.");

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Cloud.ru base URL must be an absolute HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Cloud.ru base URL must use HTTP or HTTPS.");
  }
  return value;
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "••••••••";
  return `${secret.slice(0, 4)}••••••••${secret.slice(-4)}`;
}

/**
 * Build the only supported external LLM route for Sayuri.
 *
 * Provider/model fallbacks are intentionally rejected: model selection is a
 * product policy owned by Sayuri, not an ambient provider-catalog default.
 */
export function createSayuriModelGatewayConfig(
  input: SayuriModelGatewayInput,
): SayuriModelGatewayConfig {
  if (input.provider && input.provider !== SAYURI_MODEL_PROVIDER) {
    throw new Error(
      `Sayuri only supports provider "${SAYURI_MODEL_PROVIDER}".`,
    );
  }
  if (input.model && input.model !== SAYURI_MODEL_ID) {
    throw new Error(`Sayuri only supports model "${SAYURI_MODEL_ID}".`);
  }
  if (input.allowFallbacks === true) {
    throw new Error("Sayuri does not allow automatic LLM fallbacks.");
  }

  const apiKey = input.apiKey.trim();
  if (!apiKey) throw new Error("Cloud.ru API key is required.");

  return {
    provider: SAYURI_MODEL_PROVIDER,
    model: SAYURI_MODEL_ID,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    apiKey,
    allowFallbacks: false,
  };
}

export function redactSayuriModelGatewayConfig(
  config: SayuriModelGatewayConfig,
): RedactedSayuriModelGatewayConfig {
  return {
    ...config,
    apiKey: maskSecret(config.apiKey),
  };
}
