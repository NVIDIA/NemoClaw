// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { ManagedBootstrapOwnerCleanupRequiredError } from "./adapter";
import { createDockerManagedBootstrapAdapter } from "./docker";
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

function reverseKeys<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).reverse()) as T;
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
    const replacement = await adapter.activateBootstrapReplacement({
      handle,
      snapshot,
      prepared,
      durablePreparation: durable,
    });
    const order = fake.events;
    expect(order.indexOf("journal:staged")).toBeGreaterThan(order.indexOf("authority:recorded"));
    expect(order.indexOf("journal:cutover")).toBeLessThan(order.indexOf(`stop:${OLD_ID}`));
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
    expect(fake.events.indexOf("journal:completion")).toBeGreaterThan(
      fake.events.indexOf(`start:${NEW_ID}`),
    );
    const reorderedDurable = reverseKeys({
      ...durable,
      sandbox: reverseKeys({ ...durable.sandbox }),
    });
    const reorderedCommitReceipt = reverseKeys({
      ...commitReceipt,
      image: reverseKeys({ ...commitReceipt.image }),
      sandbox: reverseKeys({ ...commitReceipt.sandbox }),
    });
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
    expect(fake.events.indexOf("journal:shared-state-committed")).toBeLessThan(
      fake.events.indexOf(`rm:${OLD_ID}`),
    );
    expect(fake.events.indexOf("finalization:committed")).toBeLessThan(
      fake.events.indexOf("journal:removed"),
    );
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
        durablePreparation: durable,
        replacement,
        completion: commitReceipt,
      }),
    ).resolves.toEqual(finalized);
    expect(fake.events).toHaveLength(eventCount);
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
    expect(fake.events.indexOf("journal:rollback-authorized")).toBeLessThan(
      fake.events.indexOf(`rm:${NEW_ID}`),
    );
    expect(fake.events.indexOf("finalization:rolled-back")).toBeLessThan(
      fake.events.indexOf("journal:removed"),
    );
    expect(fake.journal).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(fake.original.Name).toBe("/openshell-alpha");
    expect(fake.original.State?.Running).toBe(false);
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
    expect(fake.events.indexOf("journal:rollback-authorized")).toBeLessThan(
      fake.events.indexOf(`rm:${NEW_ID}`),
    );
    expect(fake.journal).toBeNull();
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
    expect(fake.journal).toBeNull();
    expect(fake.replacement).toBeNull();
    expect(
      vi.mocked(fake.deps.dockerRun!).mock.calls.some(([args]) => {
        const agentIndex = args.indexOf("--agent");
        return args.includes("--shared-state-transaction-status") && args[agentIndex + 1] === agent;
      }),
    ).toBe(true);
  });

  it("quiesces and retains an exact incomplete create when its mutable name is reused", async () => {
    const fake = fixture({ ownerId: "sandbox-alpha-recreated" });
    const adapter = createDockerManagedBootstrapAdapter(fake.deps);
    const { plan } = authority();
    await expect(
      adapter.cleanupIncompleteCreate({
        plan,
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: heldArgv,
      }),
    ).rejects.toMatchObject({
      name: "ManagedBootstrapOwnerCleanupRequiredError",
      sandboxId: "sandbox-alpha",
      runtimeId: OLD_ID,
    });
    expect(fake.original.State?.Running).toBe(false);
    expect(fake.events).not.toContain(`rm:${OLD_ID}`);
    expect(vi.mocked(fake.deps.runOpenshell!)).not.toHaveBeenCalled();
  });
});
