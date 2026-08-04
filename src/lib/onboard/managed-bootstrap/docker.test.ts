// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assert, describe, expect, it, vi } from "vitest";

import {
  ManagedBootstrapDurableCommitCleanupPendingError,
  ManagedBootstrapOwnerCleanupRequiredError,
} from "./adapter";
import { createDockerManagedBootstrapAdapter } from "./docker";
import {
  normalizeDockerManagedBootstrapLaunchSpec,
  parseDockerManagedBootstrapLaunchSpec,
} from "./docker-spec";
import {
  authority,
  completion,
  durablePreparation,
  fixture,
  heldArgv,
  IDENTITY,
  NEW_ID,
  OLD_ID,
  SUPPORTED_AGENTS,
} from "./docker-test-fixture";

function expectEventBefore(events: readonly string[], before: string, after: string): void {
  expect(events).toContain(before);
  expect(events).toContain(after);
  expect(events.indexOf(before)).toBeLessThan(events.indexOf(after));
}

describe("Docker managed bootstrap adapter", () => {
  it("publishes durable commit authority before deleting the rollback backup after lost acknowledgements", async () => {
    const fake = fixture({
      lostAcknowledgements: [
        "container:create",
        "container:remove",
        "container:rename",
        "container:start",
        "container:stop",
        "journal:create",
        "journal:cutover",
        "journal:completion",
        "journal:remove",
        "journal:shared-state-committed",
      ],
      sharedState: "pending",
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    expect(fake.journal).toBeNull();
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    fake.events.push("authority:recorded");
    const durable = durablePreparation(handle, snapshot, prepared);
    const reorderedDurable = {
      recordedAt: durable.recordedAt,
      recordId: durable.recordId,
      authorityFingerprint: durable.authorityFingerprint,
      bootstrapIdentity: durable.bootstrapIdentity,
      sandbox: {
        driverId: durable.sandbox.driverId,
        sandboxId: durable.sandbox.sandboxId,
        sandboxName: durable.sandbox.sandboxName,
      },
      schemaVersion: durable.schemaVersion,
    } satisfies typeof durable;
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: reorderedDurable,
    });
    const order = fake.events;
    expectEventBefore(order, "authority:recorded", "journal:staged");
    expectEventBefore(order, "journal:cutover", `stop:${OLD_ID}`);
    expect(fake.journal).toMatchObject({
      phase: "cutover",
      originalRuntimeId: OLD_ID,
      replacementRuntimeId: NEW_ID,
    });

    const commitReceipt = await adapter.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: 1,
    });
    const reorderedCommitReceipt = {
      completedAt: commitReceipt.completedAt,
      transactionPending: commitReceipt.transactionPending,
      bootstrapIdentity: commitReceipt.bootstrapIdentity,
      profileFingerprint: commitReceipt.profileFingerprint,
      replacementSpecHash: commitReceipt.replacementSpecHash,
      originalSpecHash: commitReceipt.originalSpecHash,
      runtimeImageContentId: commitReceipt.runtimeImageContentId,
      image: {
        manifestDigest: commitReceipt.image.manifestDigest,
        repository: commitReceipt.image.repository,
      },
      runtimeId: commitReceipt.runtimeId,
      sandbox: {
        driverId: commitReceipt.sandbox.driverId,
        sandboxId: commitReceipt.sandbox.sandboxId,
        sandboxName: commitReceipt.sandbox.sandboxName,
      },
      schemaVersion: commitReceipt.schemaVersion,
    } satisfies typeof commitReceipt;
    expect(fake.events).toContain("journal:completion");
    expect(fake.events).toContain(`start:${NEW_ID}`);
    expect(fake.events.indexOf("journal:completion")).toBeGreaterThan(
      fake.events.indexOf(`start:${NEW_ID}`),
    );
    const finalized = await adapter.finalizeBootstrap({
      outcome: "commit",
      handle,
      snapshot,
      prepared,
      durablePreparation: reorderedDurable,
      replacement,
      completion: reorderedCommitReceipt,
    });
    expect(finalized).toMatchObject({ outcome: "committed" });
    expectEventBefore(fake.events, "journal:shared-state-committed", `rm:${OLD_ID}`);
    expectEventBefore(fake.events, "finalization:committed", "journal:removed");
    expect(fake.journal).toBeNull();
    expect(fake.finalization).toMatchObject({ phase: "committed", commitReceipt });
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.Id).toBe(NEW_ID);

    const eventCount = fake.events.length;
    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        prepared,
        durablePreparation: reorderedDurable,
        replacement,
        completion: reorderedCommitReceipt,
      }),
    ).resolves.toEqual(finalized);
    expect(fake.events).toHaveLength(eventCount);
    expect(fake.events).toContain("journal:shared-state-committed");
    expect(fake.events).toContain(`rm:${OLD_ID}`);
    expect(fake.events.indexOf("journal:shared-state-committed")).toBeLessThan(
      fake.events.indexOf(`rm:${OLD_ID}`),
    );
    expect(fake.journal).toBeNull();
    expect(fake.sharedState).toBe("none");
    expect(fake.replacement?.Id).toBe(NEW_ID);

    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: reorderedDurable,
        replacement,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapDurableCommitCleanupPendingError);
    expect(fake.events).toHaveLength(eventCount);
    expect(fake.finalization).toMatchObject({ phase: "committed", commitReceipt });
  });

  it("preserves commit validation failure details when the replacement cannot be quiesced", async () => {
    const fake = fixture({
      sharedState: "pending",
      sharedStateCommitResult: { status: 1, stderr: "injected commit failure" },
    });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const commitReceipt = await adapter.awaitBootstrap({
      handle,
      snapshot,
      replacement,
      timeoutSecs: 1,
    });
    vi.mocked(fake.deps.dockerStop!).mockReturnValue({
      status: 1,
      stderr: "injected quiesce failure",
    });

    await expect(
      adapter.finalizeBootstrap({
        outcome: "commit",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: commitReceipt,
      }),
    ).rejects.toThrow(
      /logical commit validation failed: Managed-startup shared-state commit helper failed.*injected commit failure.*new workload could not be quiesced.*injected quiesce failure/u,
    );
    expect(fake.events).not.toContain("shared:rollback");
  });

  it("publishes durable rollback authority before deleting the replacement after restart", async () => {
    const fake = fixture({
      dockerStartResults: {
        [NEW_ID]: { status: 1, stderr: "injected start failure" },
      },
    });
    const first = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await first.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    await expect(
      first.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      }),
    ).rejects.toThrow("could not prove its exact replacement running");
    expect(fake.journal?.phase).toBe("cutover");

    const restarted = createDockerManagedBootstrapAdapter(fake.deps);
    await expect(
      restarted.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expectEventBefore(fake.events, "journal:rollback-authorized", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    expect(fake.replacement).toBeNull();
    expect(fake.original).not.toBeNull();
    expect(fake.original?.Name).toBe("/openshell-alpha");
    expect(fake.original?.State?.Running).toBe(false);
  });

  it("recovers the pre-stop cutover crash state after adapter restart", async () => {
    const fake = fixture({
      journalTransitionFailures: {
        cutover: new Error("injected crash after durable cutover fence"),
      },
    });
    const { handle, request: rootRequest, snapshot } = authority();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    await expect(
      adapter.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
      }),
    ).rejects.toThrow("crash after durable cutover fence");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    await expect(
      createDockerManagedBootstrapAdapter(fake.deps).finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expectEventBefore(fake.events, "journal:rollback-authorized", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
  });

  it("fences rollback when image-owned shared state is already committed", async () => {
    const fake = fixture({ sharedState: "committed" });
    const { handle, request: rootRequest, snapshot } = authority();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const eventCount = fake.events.length;
    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: null,
      }),
    ).rejects.toMatchObject({ name: "ManagedBootstrapDurableCommitCleanupPendingError" });
    expect(fake.journal?.phase).toBe("shared-state-committed");
    expect(fake.events.slice(eventCount)).toEqual(["journal:shared-state-committed"]);
  });

  it("rejects cutover before the exact durable authority receipt", async () => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority();
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const invalid = {
      ...durablePreparation(handle, snapshot, prepared),
      authorityFingerprint: "f".repeat(64),
    };
    await expect(
      adapter.activateBootstrapReplacement({
        handle,
        snapshot,
        prepared,
        durablePreparation: invalid,
      }),
    ).rejects.toThrow("exact durable prepared-authority receipt");
    expect(fake.journal).toBeNull();
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: null,
        replacement: null,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.replacement).toBeNull();
  });

  it.each(
    SUPPORTED_AGENTS,
  )("prepares, activates, and exactly rolls back the %s agent without a central switch", async (agent) => {
    const fake = fixture({ agent, sharedState: "pending" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request: rootRequest, snapshot } = authority(agent);
    const prepared = await adapter.prepareBootstrapReplacement({
      handle,
      snapshot,
      request: rootRequest,
      replacementOptions: { values: {} },
    });
    const durable = durablePreparation(handle, snapshot, prepared);
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    await expect(
      adapter.finalizeBootstrap({
        outcome: "rollback",
        handle,
        snapshot,
        prepared,
        durablePreparation: durable,
        replacement,
        completion: null,
      }),
    ).rejects.toBeInstanceOf(ManagedBootstrapOwnerCleanupRequiredError);
    expect(fake.journal?.phase).toBe("owner-cleanup-required");
    expect(fake.finalization).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(fake.original?.State?.Running).toBe(false);
    expectEventBefore(fake.events, "shared:rollback", `rm:${NEW_ID}`);
    expectEventBefore(fake.events, `rm:${NEW_ID}`, "journal:owner-cleanup-required");
    expect(
      vi.mocked(fake.deps.dockerRun!).mock.calls.some(([args]) => {
        const agentIndex = args.indexOf("--agent");
        return (
          args.includes("--shared-state-transaction-status") &&
          agentIndex >= 0 &&
          args[agentIndex + 1] === agent
        );
      }),
    ).toBe(true);
  });

  it("rejects an empty intended workload argv with a precise boundary error", async () => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const plan = { ...handle.plan, intendedWorkloadArgv: [] };
    const emptyArgvHandle = { ...handle, intendedWorkloadArgv: [], plan };
    await expect(
      adapter.prepareBootstrapReplacement({
        handle: emptyArgvHandle,
        snapshot,
        request,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow(
      "Managed bootstrap Docker replacement requires one bounded intended workload argv.",
    );
    expect(fake.events).toContain("create:replacement");
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
  });

  it.each([
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "BASH_ENV",
  ])("rejects hostile %s from the launch snapshot before replacement creation", async (key) => {
    const fake = fixture();
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, request, snapshot } = authority();
    const parsed = parseDockerManagedBootstrapLaunchSpec(snapshot.specCanonicalJson);
    const hostileInspect = structuredClone(parsed.inspect);
    hostileInspect.Config!.Env = [...(hostileInspect.Config!.Env ?? []), `${key}=/tmp/hostile`];
    const hostileSpec = normalizeDockerManagedBootstrapLaunchSpec(hostileInspect);

    await expect(
      adapter.prepareBootstrapReplacement({
        handle,
        snapshot: {
          ...snapshot,
          specHash: hostileSpec.hash,
          specCanonicalJson: hostileSpec.canonicalJson,
        },
        request,
        replacementOptions: { values: {} },
      }),
    ).rejects.toThrow(`Managed bootstrap refuses root-process injection environment '${key}'.`);
    expect(fake.events).not.toContain("create:replacement");
    expect(fake.replacement).toBeNull();
  });

  it("quiesces and retains an exact incomplete create when its mutable name is reused", async () => {
    const fake = fixture({ ownerId: "sandbox-alpha-recreated" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, plan } = authority();
    await expect(
      adapter.cleanupIncompleteCreate({
        plan,
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: heldArgv,
        createReceipt: handle.createReceipt,
      }),
    ).rejects.toMatchObject({
      name: "ManagedBootstrapOwnerCleanupRequiredError",
      sandboxId: "sandbox-alpha",
      runtimeId: OLD_ID,
    });
    expect(fake.original).not.toBeNull();
    expect(fake.original?.State?.Running).toBe(false);
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
    expect(vi.mocked(fake.deps.runOpenshell!)).not.toHaveBeenCalled();
  });

  it("retains a same-name workload that differs from the validated create receipt", async () => {
    const replacementSandboxId = "sandbox-alpha-recreated";
    const fake = fixture({ ownerId: replacementSandboxId });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { handle, plan } = authority();
    expect(fake.original).not.toBeNull();
    const labels = fake.original?.Config?.Labels;
    assert(labels, "fixture labels are required");
    labels["openshell.ai/sandbox-id"] = replacementSandboxId;

    await expect(
      adapter.cleanupIncompleteCreate({
        plan,
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: heldArgv,
        createReceipt: handle.createReceipt,
      }),
    ).rejects.toThrow(/does not match the exact validated create receipt/u);
    expect(fake.events).not.toContain(`stop:${OLD_ID}`);
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
  });
});
