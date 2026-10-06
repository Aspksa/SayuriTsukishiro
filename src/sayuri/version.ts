import { SAYURI_MODULE_VERSIONS } from "./module-versions";

/**
 * Sayuri overlay versioning.
 *
 * The imported Letta runtime keeps its own package version. Sayuri is versioned
 * independently so the upstream-compatible execution layer can evolve without
 * conflating its release number with Sayuri's cognitive architecture.
 */
export const SAYURI_PROJECT_VERSION = "0.1.58";
export const SAYURI_COGNITIVE_CORE_VERSION =
  SAYURI_MODULE_VERSIONS.cognitiveCore;
