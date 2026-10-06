import { dirname, resolve } from "node:path";
import { resolveWorkspaceSandbox } from "@/permissions/workspace-sandbox";
import type { RuntimeWorkspaceSandbox } from "@/runtime-context";
import {
  detectSandboxBackend,
  type SandboxAvailability,
} from "@/sandbox/availability";

export interface SayuriWorkspaceSandboxResolution {
  sandbox: RuntimeWorkspaceSandbox | null;
  availability: SandboxAvailability;
}

export function resolveSayuriWorkspaceSandbox(
  scopeRoot: string,
  availability: SandboxAvailability = detectSandboxBackend(),
): SayuriWorkspaceSandboxResolution {
  if (!availability.backend) {
    return { sandbox: null, availability };
  }

  const root = resolve(scopeRoot);
  const isolationRoot = dirname(root);
  if (root === isolationRoot) {
    throw new Error("Sayuri workspace sandbox cannot use a filesystem root.");
  }

  return {
    sandbox: resolveWorkspaceSandbox(
      { root, isolationRoot },
      { availability },
    ),
    availability,
  };
}
