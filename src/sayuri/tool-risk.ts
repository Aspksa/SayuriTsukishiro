import type { SayuriActionRisk } from "./action-broker";

const READ_ONLY_TOOLS = new Set([
  "Glob",
  "Grep",
  "LS",
  "Monitor",
  "Read",
  "ReadLSP",
  "Skill",
  "TaskGet",
  "TaskList",
  "ViewImage",
  "read_artifact_file",
]);

const PROJECT_MUTATION_TOOLS = new Set([
  "ApplyPatch",
  "Edit",
  "EnterWorktree",
  "ExitWorktree",
  "SetWorkingDirectory",
  "TaskCreate",
  "TaskUpdate",
  "Write",
  "write_artifact_file",
]);

const SYSTEM_MUTATION_TOOLS = new Set(["Bash", "exec_command", "write_stdin"]);

const DESTRUCTIVE_TOOLS = new Set(["TaskStop"]);

export function classifySayuriToolRisk(toolName: string): SayuriActionRisk {
  if (READ_ONLY_TOOLS.has(toolName)) return "read";
  if (PROJECT_MUTATION_TOOLS.has(toolName)) return "project-mutation";
  if (SYSTEM_MUTATION_TOOLS.has(toolName)) return "system-mutation";
  if (DESTRUCTIVE_TOOLS.has(toolName)) return "destructive";
  return "external-action";
}
