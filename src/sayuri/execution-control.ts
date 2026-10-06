import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type RuntimeToolApprovalGrant,
  type RuntimeToolExecutionControl,
  type RuntimeToolExecutionOutcome,
  type RuntimeToolExecutionRequest,
  runWithRuntimeContext,
} from "@/runtime-context";
import {
  decideSayuriAction,
  type SayuriActionRisk,
} from "./action-broker";
import {
  SayuriEvidenceLedger,
  type SayuriEvidenceKind,
  type SayuriEvidenceReceipt,
  type SayuriEvidenceTrust,
} from "./evidence-ledger";
import { type SayuriPlan, validateSayuriPlan } from "./planner";
import { progressSayuriPlanFromVerifiedStep } from "./plan-progress";
import {
  type SayuriVerificationResult,
  verifySayuriResult,
} from "./result-verifier";
import type { SayuriBrainStateStore } from "./state-store";
import {
  checkpointSayuriTask,
  type SayuriTaskState,
  type SayuriTaskStatus,
  transitionSayuriTask,
} from "./task-lifecycle";
import { resolveSayuriWorkspaceSandbox } from "./workspace-sandbox";

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

const SYSTEM_MUTATION_TOOLS = new Set([
  "Bash",
  "exec_command",
  "write_stdin",
]);

const DESTRUCTIVE_TOOLS = new Set(["TaskStop"]);

const RISK_RANK: Readonly<Record<SayuriActionRisk, number>> = {
  read: 0,
  "low-risk-write": 1,
  "project-mutation": 2,
  "external-action": 3,
  "system-mutation": 4,
  destructive: 5,
  "secret-access": 5,
};

export interface SayuriPlannedToolAuthorization {
  toolCallId: string;
  stepId: string;
  scopeApproved: boolean;
  approvalGranted: boolean;
  toolName?: string;
  argsFingerprint?: string;
}

export interface SayuriExecutionControllerOptions {
  task: SayuriTaskState;
  plan: SayuriPlan;
  scopeRoot: string;
  ledger?: SayuriEvidenceLedger;
  stateStore?: SayuriBrainStateStore;
  authorizations?: readonly SayuriPlannedToolAuthorization[];
}

interface SayuriExecutionMetadata {
  stepId?: string;
  toolCallId?: string | null;
}

function isWithinRoot(root: string, target: string): boolean {
  const path = resolve(target);
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function requestPath(request: RuntimeToolExecutionRequest): string | null {
  for (const key of ["file_path", "path", "notebook_path"] as const) {
    const value = request.args[key];
    if (typeof value === "string" && value.trim()) {
      return isAbsolute(value)
        ? resolve(value)
        : resolve(request.workingDirectory, value);
    }
  }
  return null;
}

function requestInsideScope(
  request: RuntimeToolExecutionRequest,
  scopeRoot: string,
): boolean {
  const target = requestPath(request);
  return target ? isWithinRoot(scopeRoot, target) : true;
}

function receiptKind(
  request: RuntimeToolExecutionRequest,
): SayuriEvidenceKind {
  if (request.toolKind === "external") return "external-response";
  if (
    ["ApplyPatch", "Edit", "Write", "write_artifact_file"].includes(
      request.toolName,
    )
  ) {
    return "file-change";
  }
  return "tool-result";
}

function receiptTrust(
  request: RuntimeToolExecutionRequest,
): SayuriEvidenceTrust {
  return request.toolKind === "builtin" ? "direct" : "reported";
}

function fingerprintArgs(args: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(args);
}

function executablePlanSteps(plan: SayuriPlan) {
  return plan.steps.filter(
    (step) => step.status === "in-progress" || step.status === "pending",
  );
}

export function classifySayuriToolRisk(toolName: string): SayuriActionRisk {
  if (READ_ONLY_TOOLS.has(toolName)) return "read";
  if (PROJECT_MUTATION_TOOLS.has(toolName)) return "project-mutation";
  if (SYSTEM_MUTATION_TOOLS.has(toolName)) return "system-mutation";
  if (DESTRUCTIVE_TOOLS.has(toolName)) return "destructive";
  return "external-action";
}

export class SayuriExecutionController {
  readonly #scopeRoot: string;
  #plan: SayuriPlan;
  readonly #ledger: SayuriEvidenceLedger;
  readonly #stateStore?: SayuriBrainStateStore;
  readonly #authorizations = new Map<
    string,
    SayuriPlannedToolAuthorization
  >();
  readonly #executionByToolCall = new Map<string, string>();
  readonly #metadataByExecution = new Map<string, SayuriExecutionMetadata>();
  readonly #consumedApprovalToolCallIds = new Set<string>();
  #task: SayuriTaskState;

  readonly runtimeControl: RuntimeToolExecutionControl;

  constructor(options: SayuriExecutionControllerOptions) {
    const validation = validateSayuriPlan(options.plan);
    if (!validation.valid) {
      throw new Error(
        `Cannot start Sayuri execution control with an invalid plan: ${validation.errors.join(" ")}`,
      );
    }
    if (options.plan.taskId !== options.task.id) {
      throw new Error("Plan taskId must match the active Sayuri task.");
    }
    if (
      !["running", "verifying", "checkpointed"].includes(options.task.status)
    ) {
      throw new Error(
        `Sayuri execution requires an active task, got "${options.task.status}".`,
      );
    }

    this.#task = options.task;
    this.#plan = options.plan;
    this.#scopeRoot = resolve(options.scopeRoot);
    this.#ledger = options.ledger ?? new SayuriEvidenceLedger();
    this.#stateStore = options.stateStore;
    for (const receipt of this.#ledger.snapshot()) {
      const toolCallId = receipt.metadata?.toolCallId;
      if (typeof toolCallId === "string" && toolCallId.trim()) {
        this.#executionByToolCall.set(toolCallId, receipt.executionId);
        if (receipt.outcome !== "denied") {
          this.#consumedApprovalToolCallIds.add(toolCallId);
        }
      }
    }
    for (const authorization of options.authorizations ?? []) {
      this.registerAuthorization(authorization);
    }

    this.runtimeControl = {
      authorize: (request) => this.authorize(request),
      grantApproval: (grant) => this.grantApproval(grant),
      record: (outcome) => this.record(outcome),
    };
  }

  get scopeRoot(): string {
    return this.#scopeRoot;
  }

  get plan(): SayuriPlan {
    return {
      ...this.#plan,
      steps: this.#plan.steps.map((step) => ({
        ...step,
        ...(step.receiptIds ? { receiptIds: [...step.receiptIds] } : {}),
      })),
    };
  }

  get task(): SayuriTaskState {
    return {
      ...this.#task,
      checkpoints: this.#task.checkpoints.map((checkpoint) => ({
        ...checkpoint,
        verifiedReceiptIds: [...checkpoint.verifiedReceiptIds],
      })),
    };
  }

  registerAuthorization(authorization: SayuriPlannedToolAuthorization): void {
    if (!authorization.toolCallId.trim()) {
      throw new Error("Tool authorization requires toolCallId.");
    }
    if (!authorization.stepId.trim()) {
      throw new Error("Tool authorization requires stepId.");
    }
    const step = this.#plan.steps.find(
      (candidate) => candidate.id === authorization.stepId,
    );
    if (!step) {
      throw new Error(
        `Plan step "${authorization.stepId}" does not exist.`,
      );
    }
    if (step.status === "completed" || step.status === "cancelled") {
      throw new Error(
        `Plan step "${authorization.stepId}" is not executable in status "${step.status}".`,
      );
    }
    this.#authorizations.set(authorization.toolCallId, {
      ...authorization,
    });
  }

  revokeAuthorization(toolCallId: string): void {
    this.#authorizations.delete(toolCallId);
  }

  private grantApproval(grant: RuntimeToolApprovalGrant) {
    if (!["running", "verifying", "checkpointed"].includes(this.#task.status)) {
      return {
        decision: "deny" as const,
        reason: `Task lifecycle status "${this.#task.status}" is not executable.`,
      };
    }
    if (this.#consumedApprovalToolCallIds.has(grant.toolCallId)) {
      return {
        decision: "deny" as const,
        reason: "This tool-call approval has already been consumed.",
      };
    }

    const risk = classifySayuriToolRisk(grant.toolName);
    const sandboxMatchesScope =
      grant.workspaceSandbox !== undefined &&
      resolve(grant.workspaceSandbox.root) === this.#scopeRoot &&
      isWithinRoot(this.#scopeRoot, grant.workingDirectory);
    const bridgeable =
      risk === "project-mutation" ||
      (risk === "system-mutation" && sandboxMatchesScope);
    if (!bridgeable) {
      return {
        decision: "deny" as const,
        reason:
          risk === "system-mutation"
            ? "System mutation requires an active Sayuri workspace sandbox."
            : "Automatic approval bridging is limited to scoped project/system mutations.",
      };
    }

    const syntheticRequest: RuntimeToolExecutionRequest = {
      toolName: grant.toolName,
      toolKind: "builtin",
      toolCallId: grant.toolCallId,
      args: grant.args,
      workingDirectory: grant.workingDirectory,
    };
    if (
      risk === "project-mutation" &&
      !requestInsideScope(syntheticRequest, this.#scopeRoot)
    ) {
      return {
        decision: "deny" as const,
        reason: "Approved mutation is outside the Sayuri workspace scope.",
      };
    }

    const candidates = executablePlanSteps(this.#plan).filter(
      (step) =>
        RISK_RANK[step.risk] >= RISK_RANK[risk] &&
        (step.toolName === undefined || step.toolName === grant.toolName),
    );
    const inProgress = candidates.filter(
      (step) => step.status === "in-progress",
    );
    const selected =
      inProgress.length === 1
        ? inProgress[0]
        : inProgress.length === 0 && candidates.length === 1
          ? candidates[0]
          : undefined;
    if (!selected) {
      return {
        decision: "deny" as const,
        reason:
          "Human approval could not be mapped unambiguously to one executable plan step.",
      };
    }

    this.registerAuthorization({
      toolCallId: grant.toolCallId,
      stepId: selected.id,
      scopeApproved:
        risk === "project-mutation" ? true : sandboxMatchesScope,
      approvalGranted: true,
      toolName: grant.toolName,
      argsFingerprint: fingerprintArgs(grant.args),
    });
    return {
      decision: "allow" as const,
      reason: `Human approval bridged to plan step "${selected.id}".`,
    };
  }

  evidenceSnapshot(): SayuriEvidenceReceipt[] {
    return this.#ledger.snapshot();
  }

  executionIdForToolCall(toolCallId: string): string | null {
    return this.#executionByToolCall.get(toolCallId) ?? null;
  }

  verifyToolCall(toolCallId: string): SayuriVerificationResult {
    const executionId = this.executionIdForToolCall(toolCallId);
    if (!executionId) {
      return {
        verdict: "insufficient-evidence",
        reason: `No execution is registered for tool call "${toolCallId}".`,
        receipts: [],
      };
    }
    const receiptIds = this.#ledger
      .listForExecution(executionId)
      .map((receipt) => receipt.id);
    return verifySayuriResult({ executionId, receiptIds }, this.#ledger);
  }

  async checkpointToolCall(input: {
    toolCallId: string;
    summary: string;
    nextAction: string;
    createdAt?: string;
  }): Promise<SayuriTaskState> {
    const executionId = this.executionIdForToolCall(input.toolCallId);
    if (!executionId) {
      throw new Error(
        `Cannot checkpoint unknown tool call "${input.toolCallId}".`,
      );
    }
    const verification = this.verifyToolCall(input.toolCallId);
    if (verification.verdict !== "verified") {
      throw new Error(
        `Cannot checkpoint unverified execution: ${verification.reason}`,
      );
    }
    const stepIds = [
      ...new Set(
        verification.receipts
          .map((receipt) => receipt.stepId)
          .filter((stepId): stepId is string => Boolean(stepId)),
      ),
    ];
    if (stepIds.length !== 1) {
      throw new Error(
        "Verified tool call must be bound to exactly one Sayuri plan step.",
      );
    }
    const progression = progressSayuriPlanFromVerifiedStep({
      plan: this.#plan,
      stepId: stepIds[0]!,
      receiptIds: verification.receipts.map((receipt) => receipt.id),
    });
    this.#plan = progression.plan;
    this.#task = checkpointSayuriTask(this.#task, {
      id: `checkpoint-${randomUUID()}`,
      createdAt: input.createdAt ?? new Date().toISOString(),
      summary: input.summary,
      nextAction:
        progression.nextStep?.intent ??
        progression.nextStep?.title ??
        (progression.planComplete
          ? "Verify overall task completion."
          : input.nextAction),
      verifiedReceiptIds: verification.receipts.map((receipt) => receipt.id),
    });
    await this.persistState();
    return this.task;
  }

  async transitionTask(
    nextStatus: SayuriTaskStatus,
    now: string = new Date().toISOString(),
  ): Promise<SayuriTaskState> {
    this.#task = transitionSayuriTask(this.#task, nextStatus, now);
    await this.persistState();
    return this.task;
  }

  async persistState(): Promise<void> {
    await this.#stateStore?.saveSnapshot(this.#task, this.#plan);
  }

  private async appendReceipt(
    receipt: SayuriEvidenceReceipt,
  ): Promise<void> {
    this.#ledger.append(receipt);
    try {
      await this.#stateStore?.appendReceipt(this.#task.id, receipt);
    } catch (error) {
      throw new Error(
        `Failed to persist Sayuri evidence receipt "${receipt.id}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async authorize(request: RuntimeToolExecutionRequest) {
    const risk = classifySayuriToolRisk(request.toolName);
    if (!["running", "verifying", "checkpointed"].includes(this.#task.status)) {
      const executionId = `sayuri-exec-${randomUUID()}`;
      if (request.toolCallId) {
        this.#executionByToolCall.set(request.toolCallId, executionId);
      }
      await this.appendReceipt({
        id: `receipt-${randomUUID()}`,
        executionId,
        taskId: this.#task.id,
        kind: "tool-result",
        trust: "direct",
        outcome: "denied",
        source: "sayuri-task-lifecycle",
        summary: `Task lifecycle status "${this.#task.status}" is not executable.`,
        createdAt: new Date().toISOString(),
        metadata: {
          tool: request.toolName,
          risk,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        },
      });
      return {
        decision: "deny" as const,
        executionId,
        reason: `Task lifecycle status "${this.#task.status}" is not executable.`,
      };
    }
    const authorization = request.toolCallId
      ? this.#authorizations.get(request.toolCallId)
      : undefined;
    const authorizedStep = authorization
      ? this.#plan.steps.find(
          (candidate) => candidate.id === authorization.stepId,
        )
      : undefined;
    const implicitReadStep =
      risk === "read"
        ? this.#plan.steps.find(
            (candidate) =>
              candidate.status === "in-progress" &&
              candidate.risk === "read" &&
              (candidate.toolName === undefined ||
                candidate.toolName === request.toolName),
          )
        : undefined;
    const step = authorizedStep ?? implicitReadStep;
    const scopeApproved =
      requestInsideScope(request, this.#scopeRoot) &&
      (risk === "read" || authorization?.scopeApproved === true);
    const stepCoversRisk =
      step !== undefined && RISK_RANK[step.risk] >= RISK_RANK[risk];
    const stepToolMatches =
      step?.toolName === undefined || step.toolName === request.toolName;
    const approvedToolMatches =
      authorization?.toolName === undefined ||
      authorization.toolName === request.toolName;
    const approvedArgsMatch =
      authorization?.argsFingerprint === undefined ||
      authorization.argsFingerprint === fingerprintArgs(request.args);
    const planned =
      authorization !== undefined &&
      step !== undefined &&
      stepCoversRisk &&
      stepToolMatches &&
      approvedToolMatches &&
      approvedArgsMatch &&
      step.status !== "completed" &&
      step.status !== "cancelled";

    const decision = decideSayuriAction({
      toolName: request.toolName,
      risk,
      taskId: risk === "read" ? undefined : this.#task.id,
      planned,
      scopeApproved,
      approvalGranted: authorization?.approvalGranted,
    });
    const executionId = `sayuri-exec-${randomUUID()}`;
    if (request.toolCallId) {
      this.#executionByToolCall.set(request.toolCallId, executionId);
    }
    this.#metadataByExecution.set(executionId, {
      stepId: step?.id,
      toolCallId: request.toolCallId,
    });

    if (decision.decision !== "allow") {
      await this.appendReceipt({
        id: `receipt-${randomUUID()}`,
        executionId,
        taskId: this.#task.id,
        stepId: step?.id,
        kind: "tool-result",
        trust: "direct",
        outcome: "denied",
        source: "sayuri-action-broker",
        summary: decision.reason,
        createdAt: new Date().toISOString(),
        metadata: {
          tool: request.toolName,
          risk,
          planned,
          scopeApproved,
          ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
        },
      });
      return {
        decision: "deny" as const,
        executionId,
        reason:
          decision.decision === "ask"
            ? `Approval is required before execution. ${decision.reason}`
            : decision.reason,
      };
    }

    if (request.toolCallId && authorization?.approvalGranted === true) {
      this.#consumedApprovalToolCallIds.add(request.toolCallId);
      this.#authorizations.delete(request.toolCallId);
    }

    return {
      decision: "allow" as const,
      executionId,
      reason: decision.reason,
    };
  }

  private async record(
    outcome: RuntimeToolExecutionOutcome,
  ): Promise<void> {
    const executionId = outcome.executionId;
    if (!executionId) {
      throw new Error("Controlled tool execution is missing executionId.");
    }
    const metadata = this.#metadataByExecution.get(executionId);
    await this.appendReceipt({
      id: `receipt-${randomUUID()}`,
      executionId,
      taskId: this.#task.id,
      stepId: metadata?.stepId,
      kind: receiptKind(outcome.request),
      trust: receiptTrust(outcome.request),
      outcome: outcome.status,
      source: `${outcome.request.toolKind}:${outcome.request.toolName}`,
      summary: `${outcome.request.toolName} finished with status ${outcome.status}.`,
      createdAt: new Date().toISOString(),
      metadata: {
        tool: outcome.request.toolName,
        toolKind: outcome.request.toolKind,
        durationMs: outcome.durationMs,
        ...(metadata?.toolCallId
          ? { toolCallId: metadata.toolCallId }
          : {}),
      },
    });
  }
}

export function createSayuriExecutionController(
  options: SayuriExecutionControllerOptions,
): SayuriExecutionController {
  return new SayuriExecutionController(options);
}

export async function createDurableSayuriExecutionController(
  options: SayuriExecutionControllerOptions & {
    stateStore: SayuriBrainStateStore;
  },
): Promise<SayuriExecutionController> {
  const controller = new SayuriExecutionController(options);
  await controller.persistState();
  return controller;
}

export async function resumeSayuriExecutionController(input: {
  stateStore: SayuriBrainStateStore;
  taskId: string;
  scopeRoot: string;
}): Promise<SayuriExecutionController> {
  const snapshot = await input.stateStore.loadSnapshot(input.taskId);
  if (!snapshot) {
    throw new Error(
      `No durable Sayuri state found for task "${input.taskId}".`,
    );
  }
  const ledger = new SayuriEvidenceLedger();
  for (const receipt of await input.stateStore.loadReceipts(input.taskId)) {
    ledger.append(receipt);
  }
  return new SayuriExecutionController({
    task: snapshot.task,
    plan: snapshot.plan,
    scopeRoot: input.scopeRoot,
    ledger,
    stateStore: input.stateStore,
  });
}

export function runWithSayuriExecutionController<T>(
  controller: SayuriExecutionController,
  fn: () => T,
): T {
  const { sandbox } = resolveSayuriWorkspaceSandbox(controller.scopeRoot);
  return runWithRuntimeContext(
    {
      workingDirectory: controller.scopeRoot,
      permissionMode: "standard",
      toolExecutionControl: controller.runtimeControl,
      ...(sandbox ? { workspaceSandbox: sandbox } : {}),
    },
    fn,
  );
}
