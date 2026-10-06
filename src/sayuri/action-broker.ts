export type SayuriActionRisk =
  | "read"
  | "low-risk-write"
  | "project-mutation"
  | "system-mutation"
  | "external-action"
  | "destructive"
  | "secret-access";

export type SayuriBrokerDecision = "allow" | "ask" | "deny";

export interface SayuriActionRequest {
  toolName: string;
  risk: SayuriActionRisk;
  taskId?: string;
  planned: boolean;
  scopeApproved: boolean;
  approvalGranted?: boolean;
}

export interface SayuriActionDecision {
  decision: SayuriBrokerDecision;
  reason: string;
}

export interface SayuriActionPolicy {
  autoAllowReadOnly: boolean;
  requireTaskForMutation: boolean;
}

export const DEFAULT_SAYURI_ACTION_POLICY: Readonly<SayuriActionPolicy> = {
  autoAllowReadOnly: true,
  requireTaskForMutation: true,
};

const MUTATING_RISKS = new Set<SayuriActionRisk>([
  "low-risk-write",
  "project-mutation",
  "system-mutation",
  "external-action",
  "destructive",
  "secret-access",
]);

/**
 * Conservative first policy for Sayuri.
 *
 * Read-only work may proceed automatically. Mutations must be tied to a planned
 * task and an approved scope; high-impact operations additionally require an
 * explicit approval boundary before execution.
 */
export function decideSayuriAction(
  request: SayuriActionRequest,
  policy: SayuriActionPolicy = DEFAULT_SAYURI_ACTION_POLICY,
): SayuriActionDecision {
  if (!request.toolName.trim()) {
    return { decision: "deny", reason: "Tool name is required." };
  }

  if (request.risk === "read") {
    if (!request.scopeApproved) {
      return {
        decision: "deny",
        reason: "Read is outside the approved execution scope.",
      };
    }
    return policy.autoAllowReadOnly
      ? { decision: "allow", reason: "Read-only action inside approved scope." }
      : {
          decision: "ask",
          reason: "Policy requires approval for read access.",
        };
  }

  if (
    MUTATING_RISKS.has(request.risk) &&
    policy.requireTaskForMutation &&
    !request.taskId
  ) {
    return {
      decision: "deny",
      reason: "Mutating actions require an active Sayuri task.",
    };
  }

  if (!request.planned) {
    return {
      decision: "deny",
      reason: "Action is not attached to a validated plan step.",
    };
  }

  if (!request.scopeApproved) {
    return {
      decision: "deny",
      reason: "Action is outside the approved execution scope.",
    };
  }

  if (request.approvalGranted === true) {
    return {
      decision: "allow",
      reason: "Planned action passed the explicit approval boundary.",
    };
  }

  return {
    decision: "ask",
    reason: "Mutating action requires explicit approval before execution.",
  };
}
