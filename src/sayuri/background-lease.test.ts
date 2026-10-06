import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSayuriBackgroundLeaseRecord,
  FileSayuriBackgroundLeaseStore,
  recoverSayuriBackgroundLeases,
  transitionSayuriBackgroundLease,
} from "./background-lease";
import { createSayuriSubagentCapabilityLease } from "./subagent-lease";

describe("Sayuri durable background leases", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function setup() {
    const root = await mkdtemp(join(tmpdir(), "sayuri-background-lease-"));
    roots.push(root);
    return {
      store: new FileSayuriBackgroundLeaseStore(root),
      lease: createSayuriSubagentCapabilityLease({
        id: "lease-bg",
        parentTaskId: "task-parent",
        parentPlanId: "plan-parent",
        parentStepId: "step-parent",
        subagentId: "child-bg",
        subagentType: "general-purpose",
        allowedTools: ["Read"],
        scopeRoot: "/workspace",
        issuedAt: "2026-10-06T12:00:00.000Z",
        expiresAt: "2026-10-06T13:00:00.000Z",
      }),
    };
  }

  test("marks a live running lease orphaned on restart instead of duplicating it", async () => {
    const { store, lease } = await setup();
    let record = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease,
      deadlineAt: "2026-10-06T12:30:00.000Z",
      now: "2026-10-06T12:00:01.000Z",
    });
    record = transitionSayuriBackgroundLease(record, "running", {
      now: "2026-10-06T12:00:02.000Z",
    });
    await store.save(record);

    const recovered = await recoverSayuriBackgroundLeases({
      projectId: "project-a",
      store,
      now: "2026-10-06T12:05:00.000Z",
    });
    expect(recovered[0]?.status).toBe("orphaned");
    expect((await store.get("project-a", lease.id))?.status).toBe("orphaned");
  });

  test("expires unfinished leases past their deadline and preserves completed work for handoff", async () => {
    const { store, lease } = await setup();
    let running = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease,
      deadlineAt: "2026-10-06T12:10:00.000Z",
      now: "2026-10-06T12:00:01.000Z",
    });
    running = transitionSayuriBackgroundLease(running, "running", {
      now: "2026-10-06T12:00:02.000Z",
    });
    await store.save(running);

    const recovered = await recoverSayuriBackgroundLeases({
      projectId: "project-a",
      store,
      now: "2026-10-06T12:11:00.000Z",
    });
    expect(recovered[0]?.status).toBe("expired");
  });

  test("requires completed background work to carry a result receipt", async () => {
    const { lease } = await setup();
    const record = createSayuriBackgroundLeaseRecord({
      projectId: "project-a",
      ownerAgentId: "sayuri-primary",
      ownerConversationId: "default",
      lease,
      deadlineAt: "2026-10-06T12:30:00.000Z",
      now: "2026-10-06T12:00:01.000Z",
    });
    const running = transitionSayuriBackgroundLease(record, "running", {
      now: "2026-10-06T12:00:02.000Z",
    });
    expect(() =>
      transitionSayuriBackgroundLease(running, "completed", {
        now: "2026-10-06T12:00:03.000Z",
      }),
    ).toThrow("requires a result receipt");
  });
});
