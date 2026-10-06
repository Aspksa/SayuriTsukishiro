import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSayuriBackgroundLeaseRecord,
  FileSayuriBackgroundLeaseStore,
  transitionSayuriBackgroundLease,
} from "./background-lease";
import {
  canAutoResumeSayuriBackgroundLease,
  superviseSayuriBackgroundForSession,
} from "./background-supervisor";
import { createSayuriExecutionController } from "./execution-control";
import type { SayuriPrimarySession } from "./session";
import { createSayuriSubagentCapabilityLease } from "./subagent-lease";
import {
  FileSayuriTaskRegistry,
} from "./task-registry";
import { FileSayuriBrainStateStore } from "./state-store";
import { createSayuriTask, transitionSayuriTask } from "./task-lifecycle";

describe("Sayuri background work supervisor", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) =>
        rm(root, { recursive: true, force: true }),
      ),
    );
  });

  async function sessionFixture() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-bg-supervisor-"));
    roots.push(root);
    let task = createSayuriTask({
      id: "task-bg-supervisor",
      goal: "Supervise background work",
      now: "2026-10-06T12:30:00.000Z",
    });
    task = transitionSayuriTask(task, "planning", "2026-10-06T12:30:01.000Z");
    task = transitionSayuriTask(task, "ready", "2026-10-06T12:30:02.000Z");
    task = transitionSayuriTask(task, "running", "2026-10-06T12:30:03.000Z");

    const plan = {
      id: "plan-bg-supervisor",
      taskId: task.id,
      goal: task.goal,
      createdAt: "2026-10-06T12:30:00.000Z",
      steps: [
        {
          id: "delegate",
          title: "Delegate analysis",
          status: "in-progress" as const,
          risk: "read" as const,
          requiresEvidence: false,
        },
        {
          id: "inspect",
          title: "Inspect findings",
          intent: "Read the accepted child findings",
          toolName: "Read",
          status: "pending" as const,
          risk: "read" as const,
          requiresEvidence: false,
          dependsOnStepIds: ["delegate"],
        },
      ],
    };
    const stateStore = new FileSayuriBrainStateStore(root);
    const taskRegistry = new FileSayuriTaskRegistry(root);
    const controller = createSayuriExecutionController({
      task,
      plan,
      scopeRoot: join(root, "workspace"),
    });
    const session = {
      projectId: "project-a",
      agentId: "sayuri-primary",
      conversationId: "default",
      controller,
      stateStore,
      taskRegistry,
      modelRuntime: {} as never,
      resumed: true,
    } satisfies SayuriPrimarySession;

    return {
      root,
      task,
      plan,
      session,
      store: new FileSayuriBackgroundLeaseStore(root),
    };
  }

  test("auto-handoffs a completed result before parent work continues", async () => {
    const fixture = await sessionFixture();
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-completed",
      parentTaskId: fixture.task.id,
      parentPlanId: fixture.plan.id,
      parentStepId: "delegate",
      subagentId: "child-completed",
      subagentType: "general-purpose",
      allowedTools: ["Read"],
      scopeRoot: join(fixture.root, "workspace"),
      issuedAt: "2026-10-06T12:30:04.000Z",
      expiresAt: "2026-10-06T13:30:04.000Z",
    });
    let record = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease,
      deadlineAt: "2026-10-06T13:00:00.000Z",
      assignment: "Inspect safely.",
      now: "2026-10-06T12:30:04.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "running", {
      now: "2026-10-06T12:30:05.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "completed", {
      now: "2026-10-06T12:30:06.000Z",
      resultReceipt: {
        id: "receipt-lease-completed",
        executionId: "subagent-lease-completed",
        taskId: fixture.task.id,
        stepId: "delegate",
        kind: "tool-result",
        trust: "derived",
        outcome: "success",
        source: "sayuri-subagent:general-purpose",
        summary: "Child completed.",
        createdAt: "2026-10-06T12:30:06.000Z",
        metadata: {
          leaseId: lease.id,
          subagentId: lease.subagentId,
        },
      },
    });
    await fixture.store.save(record);

    const decision = await superviseSayuriBackgroundForSession({
      session: fixture.session,
      store: fixture.store,
      now: "2026-10-06T12:30:07.000Z",
    });

    expect(decision.kind).toBe("handoff-complete");
    expect(fixture.session.controller.task.status).toBe("checkpointed");
    expect(fixture.session.controller.plan.steps[0]?.status).toBe("completed");
    expect(fixture.session.controller.plan.steps[1]?.status).toBe("in-progress");
    expect(
      (await fixture.store.get("project-a", lease.id))?.status,
    ).toBe("handed-off");
  });

  test("never auto-resumes orphaned mutation work", async () => {
    const fixture = await sessionFixture();
    const lease = createSayuriSubagentCapabilityLease({
      id: "lease-mutation",
      parentTaskId: fixture.task.id,
      parentPlanId: fixture.plan.id,
      parentStepId: "delegate",
      subagentId: "child-mutation",
      subagentType: "general-purpose",
      mode: "scoped-project-mutation",
      allowedTools: ["Read", "Write"],
      scopeRoot: join(fixture.root, "workspace"),
      issuedAt: "2026-10-06T12:30:04.000Z",
      expiresAt: "2026-10-06T13:30:04.000Z",
    });
    let record = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease,
      deadlineAt: "2026-10-06T13:00:00.000Z",
      assignment: "Write only if explicitly re-approved.",
      now: "2026-10-06T12:30:04.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "running", {
      now: "2026-10-06T12:30:05.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "orphaned", {
      now: "2026-10-06T12:31:00.000Z",
    });
    await fixture.store.save(record);

    const decision = await superviseSayuriBackgroundForSession({
      session: fixture.session,
      store: fixture.store,
      now: "2026-10-06T12:31:01.000Z",
    });
    expect(decision.kind).toBe("background-blocked");
    if (decision.kind !== "background-blocked") {
      throw new Error("Expected background-blocked");
    }
    expect(decision.reason).toContain("mutation lease");
    expect(
      (await fixture.store.get("project-a", lease.id))?.status,
    ).toBe("orphaned");
  });

  test("only classifies durable read-only assignments as auto-resumable", async () => {
    const fixture = await sessionFixture();
    const readLease = createSayuriSubagentCapabilityLease({
      id: "lease-read-restart",
      parentTaskId: fixture.task.id,
      parentPlanId: fixture.plan.id,
      parentStepId: "delegate",
      subagentId: "child-read",
      subagentType: "general-purpose",
      allowedTools: ["Read"],
      scopeRoot: join(fixture.root, "workspace"),
      issuedAt: "2026-10-06T12:30:04.000Z",
      expiresAt: "2026-10-06T13:30:04.000Z",
    });
    let record = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease: readLease,
      deadlineAt: "2026-10-06T13:00:00.000Z",
      assignment: "Re-read project state safely.",
      now: "2026-10-06T12:30:04.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "running", {
      now: "2026-10-06T12:30:05.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "orphaned", {
      now: "2026-10-06T12:31:00.000Z",
    });

    expect(
      canAutoResumeSayuriBackgroundLease(
        record,
        "2026-10-06T12:31:01.000Z",
      ),
    ).toBe(true);
    expect(
      canAutoResumeSayuriBackgroundLease(
        { ...record, assignment: "" },
        "2026-10-06T12:31:01.000Z",
      ),
    ).toBe(false);
  });
});
