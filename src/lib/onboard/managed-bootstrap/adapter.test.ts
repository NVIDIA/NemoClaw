// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapAdapter,
  type ManagedBootstrapCompletionReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapObservedSnapshot,
  type ManagedBootstrapReplacementHandle,
  renderManagedBootstrapHeldCommand,
  runManagedBootstrapSequence,
} from "./adapter";

const IDENTITY = "1".repeat(64);
const CONFIG_ID = `sha256:${"2".repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${"3".repeat(64)}` as const;
const SPEC_HASH = "4".repeat(64);
const REPLACEMENT_HASH = "5".repeat(64);
const RUNTIME_ID = "6".repeat(64);
const REPLACEMENT_ID = "7".repeat(64);

const request = createManagedStartupRootApplyRequest({
  agent: "hermes",
  encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile("hermes", false, false)),
});

function handle(): ManagedBootstrapHeldWorkloadHandle {
  const sandbox = {
    sandboxName: "alpha",
    sandboxId: "sandbox-alpha",
    driverId: "fake-runtime",
  };
  const intendedWorkloadArgv = ["env", "A=1", "nemoclaw-start"];
  const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
    request,
    IDENTITY,
    intendedWorkloadArgv,
  );
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox,
    bootstrapIdentity: IDENTITY,
    heldWorkloadArgv,
    intendedWorkloadArgv,
    plan: {
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      sandboxName: "alpha",
      driverId: "fake-runtime",
      image: {
        repository: "registry.example/nemoclaw/hermes",
        manifestDigest: MANIFEST_DIGEST,
      },
      profile: { agent: "hermes", fingerprint: request.profileFingerprint },
      agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
      intendedWorkloadArgv,
      expectedSupervisorArgv: ["/opt/openshell/bin/openshell-sandbox", "supervise", "--foreground"],
      metadata: { "nemoclaw.ai/managed-profile": request.profileFingerprint },
    },
    createReceipt: {
      sandbox,
      ready: true,
      readyAt: "2026-07-29T12:00:00.000Z",
    },
  };
}

function snapshot(created = handle()): ManagedBootstrapObservedSnapshot {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: created.sandbox,
    runtimeId: RUNTIME_ID,
    bootstrapIdentity: IDENTITY,
    image: created.plan.image,
    runtimeImageContentId: CONFIG_ID,
    specHash: SPEC_HASH,
    specCanonicalJson: "{}\n",
    agentIdentity: created.plan.agentIdentity,
    supervisorArgv: created.plan.expectedSupervisorArgv,
    heldWorkloadArgv: created.heldWorkloadArgv,
    metadata: created.plan.metadata,
  };
}

function replacement(created = handle()): ManagedBootstrapReplacementHandle {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: created.sandbox,
    bootstrapIdentity: IDENTITY,
    originalRuntimeId: RUNTIME_ID,
    replacementRuntimeId: REPLACEMENT_ID,
    image: created.plan.image,
    runtimeImageContentId: CONFIG_ID,
    originalSpecHash: SPEC_HASH,
    replacementSpecHash: REPLACEMENT_HASH,
    profileFingerprint: request.profileFingerprint,
  };
}

function completion(created = handle()): ManagedBootstrapCompletionReceipt {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: created.sandbox,
    runtimeId: REPLACEMENT_ID,
    image: created.plan.image,
    runtimeImageContentId: CONFIG_ID,
    originalSpecHash: SPEC_HASH,
    replacementSpecHash: REPLACEMENT_HASH,
    profileFingerprint: request.profileFingerprint,
    bootstrapIdentity: IDENTITY,
    transactionPending: true,
    completedAt: "2026-07-29T12:01:00.000Z",
  };
}

function adapterFor(order: string[]): ManagedBootstrapAdapter {
  const created = handle();
  const observed = snapshot(created);
  const replaced = replacement(created);
  return {
    createHeldWorkload: vi.fn(async () => {
      order.push("create-ready");
      return created;
    }),
    cleanupIncompleteCreate: vi.fn(),
    discoverHeldWorkload: vi.fn(async () => {
      order.push("discover");
      return {
        sandbox: created.sandbox,
        runtimeId: RUNTIME_ID,
        bootstrapIdentity: IDENTITY,
      };
    }),
    inspectHeldWorkload: vi.fn(async () => {
      order.push("inspect");
      return observed;
    }),
    replaceForBootstrap: vi.fn(async () => {
      order.push("replace");
      return replaced;
    }),
    awaitBootstrap: vi.fn(async () => {
      order.push("await");
      return completion(created);
    }),
    finalizeBootstrap: vi.fn(async () => {
      order.push("rollback");
      return {
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: created.sandbox,
        bootstrapIdentity: IDENTITY,
        outcome: "rolled-back" as const,
        restoredRuntimeId: RUNTIME_ID,
        restoredSpecHash: SPEC_HASH,
        heldWorkloadRemoved: false,
        alreadyRolledBack: false,
        finalizedAt: "2026-07-29T12:02:00.000Z",
      };
    }),
  };
}

function sequenceInput() {
  return {
    create: {
      plan: handle().plan,
      request,
      bootstrapIdentity: IDENTITY,
      launch: vi.fn(),
    },
    request,
    replacementOptions: { values: {} },
    timeoutSecs: 30,
  } as const;
}

describe("managed bootstrap adapter contract", () => {
  it("preserves environment assignments and binds one bootstrap identity to the hold", () => {
    expect(
      renderManagedBootstrapHeldCommand(request, IDENTITY, [
        "env",
        "A=1",
        "B=two words",
        "nemoclaw-start",
      ]),
    ).toEqual([
      "env",
      "A=1",
      "B=two words",
      "/usr/local/bin/nemoclaw-managed-startup-hold",
      "--agent",
      "hermes",
      "--profile-fingerprint",
      request.profileFingerprint,
      "--bootstrap-identity",
      IDENTITY,
    ]);
  });

  it.each([
    "BASH_ENV=/sandbox/attacker",
    "ENV=/sandbox/attacker",
    "LD_PRELOAD=/sandbox/attacker.so",
    "LD_AUDIT=/sandbox/attacker.so",
    "LD_LIBRARY_PATH=/sandbox/lib",
    "SHELLOPTS=xtrace",
    "PS4=$(touch /sandbox/bypass)",
    "BASH_FUNC_attacker%%=() { touch /sandbox/bypass; }",
  ])("rejects a process-control assignment before rendering the held command: %s", (assignment) => {
    expect(() =>
      renderManagedBootstrapHeldCommand(request, IDENTITY, ["env", assignment, "nemoclaw-start"]),
    ).toThrow("process-control environment assignment");
  });

  it("coordinates exact supervisor argv and identity-bound receipts through a fake provider", async () => {
    const order: string[] = [];
    const adapter = adapterFor(order);

    const result = await runManagedBootstrapSequence(adapter, sequenceInput());

    expect(order).toEqual(["create-ready", "discover", "inspect", "replace", "await"]);
    expect(adapter.discoverHeldWorkload).toHaveBeenCalledWith({
      sandbox: handle().sandbox,
      bootstrapIdentity: IDENTITY,
      expectedImage: handle().plan.image,
      metadata: handle().plan.metadata,
    });
    expect(adapter.replaceForBootstrap).toHaveBeenCalledWith({
      handle: expect.objectContaining({ bootstrapIdentity: IDENTITY }),
      snapshot: expect.objectContaining({
        runtimeId: RUNTIME_ID,
        supervisorArgv: handle().plan.expectedSupervisorArgv,
      }),
      request,
      replacementOptions: { values: {} },
    });
    expect(result.completion).toMatchObject({
      bootstrapIdentity: IDENTITY,
      runtimeId: REPLACEMENT_ID,
      runtimeImageContentId: CONFIG_ID,
      replacementSpecHash: REPLACEMENT_HASH,
    });
  });

  it("rejects supervisor drift before replacement and rolls back the exact held runtime", async () => {
    const order: string[] = [];
    const adapter = adapterFor(order);
    vi.mocked(adapter.inspectHeldWorkload).mockResolvedValueOnce({
      ...snapshot(),
      supervisorArgv: ["/bin/sh", "-c", "attacker"],
    });

    await expect(runManagedBootstrapSequence(adapter, sequenceInput())).rejects.toThrow(
      "supervisor argv does not match the transaction authority",
    );
    expect(order).toEqual(["create-ready", "discover", "rollback"]);
    expect(adapter.replaceForBootstrap).not.toHaveBeenCalled();
    expect(adapter.finalizeBootstrap).toHaveBeenCalledWith({
      outcome: "rollback",
      handle: expect.objectContaining({ bootstrapIdentity: IDENTITY }),
      snapshot: expect.objectContaining({ runtimeId: RUNTIME_ID }),
      replacement: null,
      completion: null,
    });
  });

  it.each([
    ["bootstrapIdentity", "8".repeat(64)],
    ["runtimeId", "9".repeat(64)],
    ["replacementSpecHash", "a".repeat(64)],
    ["profileFingerprint", "b".repeat(64)],
  ] as const)("rejects completion receipt drift in %s", async (field, value) => {
    const order: string[] = [];
    const adapter = adapterFor(order);
    vi.mocked(adapter.awaitBootstrap).mockResolvedValueOnce({
      ...completion(),
      [field]: value,
    });

    await expect(runManagedBootstrapSequence(adapter, sequenceInput())).rejects.toThrow(
      "completion receipt changed immutable transaction authority",
    );
    expect(order).toEqual(["create-ready", "discover", "inspect", "replace", "rollback"]);
    expect(adapter.finalizeBootstrap).toHaveBeenCalledWith({
      outcome: "rollback",
      handle: expect.objectContaining({ bootstrapIdentity: IDENTITY }),
      snapshot: expect.objectContaining({ runtimeId: RUNTIME_ID }),
      replacement: expect.objectContaining({ replacementRuntimeId: REPLACEMENT_ID }),
      completion: null,
    });
  });

  it("preserves the primary failure and attaches an idempotent rollback receipt", async () => {
    const order: string[] = [];
    const adapter = adapterFor(order);
    const primary = new Error("replacement failed");
    vi.mocked(adapter.replaceForBootstrap).mockRejectedValueOnce(primary);

    await expect(runManagedBootstrapSequence(adapter, sequenceInput())).rejects.toBe(primary);
    expect(order).toEqual(["create-ready", "discover", "inspect", "rollback"]);
    expect(
      (primary as Error & { managedBootstrapRollback?: unknown }).managedBootstrapRollback,
    ).toMatchObject({
      bootstrapIdentity: IDENTITY,
      restoredRuntimeId: RUNTIME_ID,
    });
  });

  it("preserves the primary failure when rollback also fails", async () => {
    const order: string[] = [];
    const adapter = adapterFor(order);
    const primary = new Error("completion failed");
    const rollback = new Error("rollback failed");
    vi.mocked(adapter.awaitBootstrap).mockRejectedValueOnce(primary);
    vi.mocked(adapter.finalizeBootstrap).mockImplementationOnce(async () => {
      await Promise.resolve();
      throw rollback;
    });

    await expect(runManagedBootstrapSequence(adapter, sequenceInput())).rejects.toBe(primary);
    expect(
      (primary as Error & { managedBootstrapRollbackError?: unknown })
        .managedBootstrapRollbackError,
    ).toBe(rollback);
    expect(primary.message).toContain(
      "Managed bootstrap rollback requires attention: rollback failed",
    );
  });

  it.each([
    "discoverHeldWorkload",
    "inspectHeldWorkload",
  ] as const)("finalizes the held workload when %s fails before a snapshot is available", async (method) => {
    const order: string[] = [];
    const adapter = adapterFor(order);
    const primary = new Error(`${method} failed`);
    vi.mocked(adapter[method]).mockRejectedValueOnce(primary);

    await expect(runManagedBootstrapSequence(adapter, sequenceInput())).rejects.toBe(primary);

    expect(adapter.finalizeBootstrap).toHaveBeenCalledWith({
      outcome: "rollback",
      handle: expect.objectContaining({ bootstrapIdentity: IDENTITY }),
      snapshot: null,
      replacement: null,
      completion: null,
    });
  });
});
