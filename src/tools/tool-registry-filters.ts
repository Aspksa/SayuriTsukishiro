import type { ModToolDefinition } from "@/mods/tool-registry";
import type { RuntimeContextSnapshot } from "@/runtime-context";
import type { ExternalToolDefinition } from "./external-tool-types";
import { getServerToolName } from "./tool-name-mapping";

function matchesClientToolAllowlistEntry(
  allowSet: Set<string> | null,
  serverToolName: string,
  internalToolName?: string,
): boolean {
  if (!allowSet) {
    return true;
  }

  return (
    allowSet.has(serverToolName) ||
    (internalToolName !== undefined && allowSet.has(internalToolName))
  );
}

export function filterBuiltInToolNamesByClientAllowlist<T extends string>(
  toolNames: T[],
  clientToolAllowlist?: string[],
): T[] {
  if (clientToolAllowlist === undefined) {
    return toolNames;
  }

  const allowSet = new Set(clientToolAllowlist);
  return toolNames.filter((toolName) =>
    matchesClientToolAllowlistEntry(
      allowSet,
      getServerToolName(toolName),
      toolName,
    ),
  );
}

export function filterExternalToolsByClientAllowlist(
  externalTools: Map<string, ExternalToolDefinition>,
  clientToolAllowlist?: string[],
): Map<string, ExternalToolDefinition> {
  if (clientToolAllowlist === undefined) {
    return new Map(externalTools);
  }

  const allowSet = new Set(clientToolAllowlist);
  return new Map(
    Array.from(externalTools.entries()).filter(([internalName, tool]) =>
      matchesClientToolAllowlistEntry(allowSet, tool.name, internalName),
    ),
  );
}

export function filterToolRegistryByClientAllowlist<T>(
  registry: Map<string, T>,
  clientToolAllowlist?: string[],
): Map<string, T> {
  if (clientToolAllowlist === undefined) {
    return new Map(registry);
  }

  const allowSet = new Set(clientToolAllowlist);
  return new Map(
    Array.from(registry.entries()).filter(([internalName]) =>
      matchesClientToolAllowlistEntry(
        allowSet,
        getServerToolName(internalName),
        internalName,
      ),
    ),
  );
}

export function filterExternalToolsByRuntimeContext(
  externalTools: Map<string, ExternalToolDefinition>,
  runtimeContext: RuntimeContextSnapshot,
): Map<string, ExternalToolDefinition> {
  return new Map(
    Array.from(externalTools.entries()).filter(([, tool]) => {
      const matchesRuntime =
        !tool.runtime ||
        ((tool.runtime.agentId ?? null) === (runtimeContext.agentId ?? null) &&
          tool.runtime.conversationId === runtimeContext.conversationId);
      const matchesConnection =
        tool.connectionId === undefined ||
        tool.connectionId === runtimeContext.connectionId ||
        (tool.runtime !== undefined && tool.scopeId === undefined);
      return matchesRuntime && matchesConnection;
    }),
  );
}

export function filterExternalToolsByScopeIds(
  externalTools: Map<string, ExternalToolDefinition>,
  externalToolScopeIds?: string[],
): Map<string, ExternalToolDefinition> {
  const selectedScopes = new Set(externalToolScopeIds ?? []);
  return new Map(
    Array.from(externalTools.entries()).filter(([, tool]) => {
      if (tool.scopeId === undefined) {
        return true;
      }
      return selectedScopes.has(tool.scopeId);
    }),
  );
}

export function filterModToolsByClientAllowlist(
  modTools: Map<string, ModToolDefinition>,
  clientToolAllowlist?: string[],
): Map<string, ModToolDefinition> {
  if (clientToolAllowlist === undefined) {
    return new Map(modTools);
  }

  const allowSet = new Set(clientToolAllowlist);
  return new Map(
    Array.from(modTools.entries()).filter(([name, tool]) =>
      matchesClientToolAllowlistEntry(allowSet, tool.name, name),
    ),
  );
}
