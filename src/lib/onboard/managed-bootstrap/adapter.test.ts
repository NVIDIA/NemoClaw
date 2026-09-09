// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  encodeManagedStartupProfile,
  MANAGED_STARTUP_AGENTS,
  type ManagedStartupAgent,
} from "../managed-startup/profile";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import {
  activateManagedBootstrapSequence,
  enforceManagedBootstrapRecoveryForSandbox,
  finalizeManagedBootstrapSequence,
  MANAGED_BOOTSTRAP_SCHEMA_VERSION,
  type ManagedBootstrapAdapter,
  type ManagedBootstrapAuthorityStore,
  type ManagedBootstrapCompletionReceipt,
  type ManagedBootstrapCreateReceipt,
  type ManagedBootstrapDurablePreparationReceipt,
  type ManagedBootstrapFinalizationReceipt,
  type ManagedBootstrapHeldWorkloadHandle,
  type ManagedBootstrapObservedSnapshot,
  type ManagedBootstrapPreparedReplacementHandle,
  ManagedBootstrapRecoveryBlockedError,
  type ManagedBootstrapReplacementHandle,
  prepareManagedBootstrapSequence,
  recoverManagedBootstrapTransactions,
  renderManagedBootstrapHeldCommand,
  sameManagedBootstrapCompletionReceipt,
  sameManagedBootstrapDurablePreparationReceipt,
} from "./adapter";
import { reverseKeys } from "./managed-bootstrap-test-fixture";

const IDENTITY = "1".repeat(64);
const CONFIG_ID = `sha256:${"2".repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${"3".repeat(64)}` as const;
const SPEC_JSON = "{}\n";
const SPEC_HASH = createHash("sha256").update(SPEC_JSON, "utf8").digest("hex");
const PREPARED_SPEC_JSON = '{"name":"prepared"}\n';
const PREPARED_HASH = createHash("sha256").update(PREPARED_SPEC_JSON, "utf8").digest("hex");
const ACTIVATED_SPEC_JSON = '{"name":"active"}\n';
const ACTIVATED_HASH = createHash("sha256").update(ACTIVATED_SPEC_JSON, "utf8").digest("hex");
const RUNTIME_ID = "7".repeat(64);
const PREPARED_ID = "8".repeat(64);

function requestFor(agent: ManagedStartupAgent) {
  return createManagedStartupRootApplyRequest({
    agent,
    encodedProfile: encodeManagedStartupProfile(managedStartupE2eProfile(agent, false, false)),
  });
}

function planFor(request: ReturnType<typeof requestFor>) {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandboxName: "alpha",
    driverId: "mxc-fixture",
    image: {
      repository: `registry.example/nemoclaw/${request.agent}`,
      manifestDigest: MANIFEST_DIGEST,
    },
    profile: { agent: request.agent, fingerprint: request.profileFingerprint },
    agentIdentity: { uid: 1000, gid: 1000, workdir: "/sandbox" },
    managedStateRoots: [],
    intendedWorkloadArgv: ["env", "A=1", "/usr/local/bin/nemoclaw-start"],
    expectedSupervisorArgv: ["/runtime/sandbox-supervisor", "supervise", "--foreground"],
    metadata: { "nemoclaw.ai/managed-profile": request.profileFingerprint },
  } as const;
}

function sandbox() {
  return {
    sandboxName: "alpha",
    sandboxId: "sandbox-alpha",
    driverId: "mxc-fixture",
  } as const;
}

function createReceipt() {
  return {
    sandbox: sandbox(),
    ready: true as const,
    readyAt: "2026-07-29T12:00:00.000Z",
  };
}

function handleFor(
  request: ReturnType<typeof requestFor>,
  receipt: ManagedBootstrapCreateReceipt = createReceipt(),
): ManagedBootstrapHeldWorkloadHandle {
  const plan = planFor(request);
  const heldWorkloadArgv = renderManagedBootstrapHeldCommand(
    request,
    IDENTITY,
    plan.intendedWorkloadArgv,
  );
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: receipt.sandbox,
    bootstrapIdentity: IDENTITY,
    heldWorkloadArgv,
    intendedWorkloadArgv: plan.intendedWorkloadArgv,
    plan,
    createReceipt: receipt,
  };
}

function snapshotFor(
  request: ReturnType<typeof requestFor>,
  handle = handleFor(request),
): ManagedBootstrapObservedSnapshot {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    runtimeId: RUNTIME_ID,
    bootstrapIdentity: IDENTITY,
    image: handle.plan.image,
    runtimeImageContentId: CONFIG_ID,
    specHash: SPEC_HASH,
    specCanonicalJson: SPEC_JSON,
    agentIdentity: handle.plan.agentIdentity,
    supervisorArgv: handle.plan.expectedSupervisorArgv,
    heldWorkloadArgv: handle.heldWorkloadArgv,
    metadata: handle.plan.metadata,
  };
}

function preparedFor(
  request: ReturnType<typeof requestFor>,
  handle = handleFor(request),
): ManagedBootstrapPreparedReplacementHandle {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    bootstrapIdentity: IDENTITY,
    originalRuntimeId: RUNTIME_ID,
    preparedRuntimeId: PREPARED_ID,
    image: handle.plan.image,
    runtimeImageContentId: CONFIG_ID,
    originalSpecHash: SPEC_HASH,
    preparedSpecHash: PREPARED_HASH,
    preparedSpecCanonicalJson: PREPARED_SPEC_JSON,
    expectedActivatedSpecHash: ACTIVATED_HASH,
    expectedActivatedSpecCanonicalJson: ACTIVATED_SPEC_JSON,
    profileFingerprint: request.profileFingerprint,
    rollbackAuthority: "mxc-opaque-rollback-authority",
  };
}

function replacementFor(
  request: ReturnType<typeof requestFor>,
  handle = handleFor(request),
): ManagedBootstrapReplacementHandle {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    bootstrapIdentity: IDENTITY,
    originalRuntimeId: RUNTIME_ID,
    replacementRuntimeId: PREPARED_ID,
    image: handle.plan.image,
    runtimeImageContentId: CONFIG_ID,
    originalSpecHash: SPEC_HASH,
    replacementSpecHash: ACTIVATED_HASH,
    replacementSpecCanonicalJson: ACTIVATED_SPEC_JSON,
    profileFingerprint: request.profileFingerprint,
  };
}

function completionFor(
  request: ReturnType<typeof requestFor>,
  handle = handleFor(request),
): ManagedBootstrapCompletionReceipt {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    runtimeId: PREPARED_ID,
    image: handle.plan.image,
    runtimeImageContentId: CONFIG_ID,
    originalSpecHash: SPEC_HASH,
    replacementSpecHash: ACTIVATED_HASH,
    profileFingerprint: request.profileFingerprint,
    bootstrapIdentity: IDENTITY,
    transactionPending: true,
    completedAt: "2026-07-29T12:01:00.000Z",
  };
}

function rolledBackReceipt(
  handle: ManagedBootstrapHeldWorkloadHandle,
  snapshot: ManagedBootstrapObservedSnapshot | null,
): ManagedBootstrapFinalizationReceipt {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: handle.sandbox,
    bootstrapIdentity: IDENTITY,
    outcome: "rolled-back",
    restoredRuntimeId: snapshot?.runtimeId ?? null,
    restoredSpecHash: snapshot?.specHash ?? null,
    heldWorkloadRemoved: snapshot === null,
    alreadyRolledBack: false,
    finalizedAt: "2026-07-29T12:02:00.000Z",
  };
}

function cleanupReceipt(): ManagedBootstrapFinalizationReceipt {
  return {
    schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
    sandbox: sandbox(),
    bootstrapIdentity: IDENTITY,
    outcome: "rolled-back",
    restoredRuntimeId: null,
    restoredSpecHash: null,
    heldWorkloadRemoved: true,
    alreadyRolledBack: false,
    finalizedAt: "2026-07-29T12:02:00.000Z",
  };
}

interface Fixture {
  readonly adapter: ManagedBootstrapAdapter;
  readonly order: string[];
  readonly raw: {
    handle: ManagedBootstrapHeldWorkloadHandle | null;
    snapshot: ManagedBootstrapObservedSnapshot | null;
    prepared: ManagedBootstrapPreparedReplacementHandle | null;
  };
}

function adapterFor(agent: ManagedStartupAgent): Fixture {
  const request = requestFor(agent);
  const order: string[] = [];
  const raw: Fixture["raw"] = { handle: null, snapshot: null, prepared: null };
  const adapter: ManagedBootstrapAdapter = {
    recoverUnfinishedTransactions: vi.fn(async () => ({ receipts: [], failures: [] })),
    createHeldWorkload: vi.fn(async (input) => {
      order.push("create");
      const receipt = await input.launch({
        heldWorkloadArgv: renderManagedBootstrapHeldCommand(
          input.request,
          input.bootstrapIdentity as string,
          input.plan.intendedWorkloadArgv,
        ),
        bootstrapIdentity: input.bootstrapIdentity as string,
      });
      raw.handle = handleFor(request, receipt);
      return raw.handle;
    }),
    cleanupIncompleteCreate: vi.fn(async () => {
      order.push("cleanup-incomplete");
      return cleanupReceipt();
    }),
    discoverHeldWorkload: vi.fn(async (input) => {
      order.push("discover");
      return {
        sandbox: input.sandbox,
        runtimeId: RUNTIME_ID,
        bootstrapIdentity: IDENTITY,
      };
    }),
    inspectHeldWorkload: vi.fn(async ({ handle }) => {
      order.push("inspect");
      const observed = snapshotFor(request, handle);
      raw.snapshot = {
        ...observed,
        sandbox: { ...observed.sandbox },
        image: { ...observed.image },
        agentIdentity: { ...observed.agentIdentity },
        supervisorArgv: [...observed.supervisorArgv],
        heldWorkloadArgv: [...observed.heldWorkloadArgv],
        metadata: { ...observed.metadata },
      };
      return raw.snapshot;
    }),
    prepareBootstrapReplacement: vi.fn(async ({ handle }) => {
      order.push("prepare-replacement");
      raw.prepared = preparedFor(request, handle);
      return raw.prepared;
    }),
    activateBootstrapReplacement: vi.fn(async ({ handle }) => {
      order.push("activate");
      return replacementFor(request, handle);
    }),
    awaitBootstrap: vi.fn(async ({ handle }) => {
      order.push("await");
      return completionFor(request, handle);
    }),
    finalizeBootstrap: vi.fn(async (input) => {
      order.push(input.outcome);
      return input.outcome === "rollback"
        ? rolledBackReceipt(input.handle, input.snapshot)
        : {
            schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
            sandbox: input.handle.sandbox,
            bootstrapIdentity: IDENTITY,
            outcome: "committed" as const,
            restoredRuntimeId: null,
            restoredSpecHash: null,
            heldWorkloadRemoved: false,
            alreadyRolledBack: false,
            finalizedAt: "2026-07-29T12:03:00.000Z",
          };
    }),
  };
  return { adapter, order, raw };
}

function authorityStore(order: string[]): ManagedBootstrapAuthorityStore {
  return {
    recordPreparedAuthority: vi.fn(async (authority) => {
      order.push("record");
      return {
        schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
        sandbox: authority.sandbox,
        bootstrapIdentity: authority.bootstrapIdentity,
        authorityFingerprint: authority.authorityFingerprint,
        recordId: "durable-record-alpha",
        recordedAt: "2026-07-29T12:00:30.000Z",
      };
    }),
  };
}

function preparationInput(agent: ManagedStartupAgent) {
  const request = requestFor(agent);
  return {
    create: {
      plan: planFor(request),
      request,
      bootstrapIdentity: IDENTITY,
      launch: vi.fn(async () => createReceipt()),
    },
    request,
    replacementOptions: { values: { mode: "native", groups: ["44", "109"] } },
  } as const;
}

async function prepareAndActivate(agent: ManagedStartupAgent, fixture = adapterFor(agent)) {
  const prepared = await prepareManagedBootstrapSequence(fixture.adapter, preparationInput(agent));
  const activated = await activateManagedBootstrapSequence(fixture.adapter, {
    transaction: prepared,
    authorityStore: authorityStore(fixture.order),
    timeoutSecs: 30,
  });
  return { ...fixture, prepared, activated };
}

async function captureFailure<T>(promise: Promise<T>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & {
      managedBootstrapRollback?: ManagedBootstrapFinalizationReceipt;
      managedBootstrapRollbackError?: unknown;
    };
  }
  throw new Error("Expected managed bootstrap operation to fail.");
}

describe("managed bootstrap adapter contract", () => {
  it("compares provider-neutral durable receipts by canonical value", () => {
    const handle = handleFor(requestFor("hermes"));
    const preparation: ManagedBootstrapDurablePreparationReceipt = {
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      sandbox: handle.sandbox,
      bootstrapIdentity: handle.bootstrapIdentity,
      authorityFingerprint: "a".repeat(64),
      recordId: "mxc-durable-authority",
      recordedAt: "2026-07-29T12:00:30.000Z",
    };
    const reorderedPreparation = reverseKeys({
      ...preparation,
      sandbox: reverseKeys({ ...preparation.sandbox }),
    });
    expect(sameManagedBootstrapDurablePreparationReceipt(preparation, reorderedPreparation)).toBe(
      true,
    );
    expect(
      sameManagedBootstrapDurablePreparationReceipt(preparation, {
        ...reorderedPreparation,
        recordId: "changed-authority",
      }),
    ).toBe(false);

    const completion = completionFor(requestFor("hermes"), handle);
    const reorderedCompletion = reverseKeys({
      ...completion,
      image: reverseKeys({ ...completion.image }),
      sandbox: reverseKeys({ ...completion.sandbox }),
    });
    expect(sameManagedBootstrapCompletionReceipt(completion, reorderedCompletion)).toBe(true);
    expect(
      sameManagedBootstrapCompletionReceipt(completion, {
        ...reorderedCompletion,
        transactionPending: false,
      }),
    ).toBe(false);
  });

  it.each(MANAGED_STARTUP_AGENTS)(
    "prepares, durably records, and only then activates %s through a provider-neutral adapter",
    async (agent) => {
      const result = await prepareAndActivate(agent);

      expect(result.order).toEqual([
        "create",
        "discover",
        "inspect",
        "prepare-replacement",
        "record",
        "activate",
        "await",
      ]);
      expect(result.activated.completion).toMatchObject({
        bootstrapIdentity: IDENTITY,
        runtimeId: PREPARED_ID,
        profileFingerprint: requestFor(agent).profileFingerprint,
      });
      expect(Object.isFrozen(result.prepared)).toBe(true);
      expect(Object.isFrozen(result.prepared.handle.plan.metadata)).toBe(true);
      expect(Object.isFrozen(result.prepared.prepared)).toBe(true);
      expect(Object.isFrozen(result.activated.durablePreparation)).toBe(true);
      const prepareInput = vi.mocked(result.adapter.prepareBootstrapReplacement).mock.calls[0]?.[0];
      expect(Object.isFrozen(prepareInput?.replacementOptions.values)).toBe(true);
      expect(Object.isFrozen(prepareInput?.replacementOptions.values.groups)).toBe(true);
    },
  );

  it.each(MANAGED_STARTUP_AGENTS)(
    "renders one exact identity-bound %s hold and preserves only the intended startup tail",
    (agent) => {
      const request = requestFor(agent);
      expect(
        renderManagedBootstrapHeldCommand(request, IDENTITY, [
          "env",
          "A=1",
          "/usr/local/bin/nemoclaw-start",
          "/bin/sh",
          "-c",
          "printf tail",
        ]),
      ).toEqual([
        "env",
        "A=1",
        "/usr/local/bin/nemoclaw-managed-startup-hold",
        "--agent",
        agent,
        "--profile-fingerprint",
        request.profileFingerprint,
        "--bootstrap-identity",
        IDENTITY,
        "--",
        "/bin/sh",
        "-c",
        "printf tail",
      ]);
    },
  );

  it.each(["nemoclaw-start", "/bin/sh", "/tmp/nemoclaw-start"])(
    "rejects non-canonical intended startup executable %s",
    (executable) => {
      expect(() =>
        renderManagedBootstrapHeldCommand(requestFor("openclaw"), IDENTITY, ["env", executable]),
      ).toThrow("intended workload executable must be /usr/local/bin/nemoclaw-start");
    },
  );

  it("stops after non-destructive preparation until durable activation is requested", async () => {
    const fixture = adapterFor("openclaw");
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("openclaw"),
    );

    expect(fixture.order).toEqual(["create", "discover", "inspect", "prepare-replacement"]);
    expect(fixture.adapter.activateBootstrapReplacement).not.toHaveBeenCalled();
    expect(prepared.prepared.originalRuntimeId).toBe(RUNTIME_ID);
    expect(prepared.prepared.preparedRuntimeId).toBe(PREPARED_ID);
  });

  it("rejects independent discovered-versus-inspected runtime disagreement before preparation", async () => {
    const fixture = adapterFor("openclaw");
    const request = requestFor("openclaw");
    const discoveryProbe = vi.fn(async () => RUNTIME_ID);
    const inspectionProbe = vi.fn(async () => "9".repeat(64));
    vi.mocked(fixture.adapter.discoverHeldWorkload).mockImplementationOnce(async (input) => ({
      sandbox: input.sandbox,
      runtimeId: await discoveryProbe(),
      bootstrapIdentity: IDENTITY,
    }));
    vi.mocked(fixture.adapter.inspectHeldWorkload).mockImplementationOnce(async ({ handle }) => ({
      ...snapshotFor(request, handle),
      runtimeId: await inspectionProbe(),
    }));

    const failure = await captureFailure(
      prepareManagedBootstrapSequence(fixture.adapter, preparationInput("openclaw")),
    );

    expect(discoveryProbe).toHaveBeenCalledTimes(1);
    expect(inspectionProbe).toHaveBeenCalledTimes(1);
    expect(failure.message).toContain("observed runtime identity changed after discovery");
    expect(fixture.adapter.prepareBootstrapReplacement).not.toHaveBeenCalled();
    expect(fixture.adapter.activateBootstrapReplacement).not.toHaveBeenCalled();
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenCalledWith({
      outcome: "rollback",
      handle: fixture.raw.handle,
      snapshot: null,
      prepared: null,
      durablePreparation: null,
      replacement: null,
      completion: null,
    });
    expect(failure.managedBootstrapRollback).toMatchObject({
      outcome: "rolled-back",
      sandbox: sandbox(),
      heldWorkloadRemoved: true,
    });
  });

  it.each([
    {
      label: "plan metadata",
      expected: "metadata must be a plain string record",
      invalidate: (input: Parameters<typeof prepareManagedBootstrapSequence>[1]) => ({
        ...input,
        create: {
          ...input.create,
          plan: {
            ...input.create.plan,
            metadata: Object.assign(
              Object.create({ inherited: "attacker" }) as Record<string, string>,
              input.create.plan.metadata,
            ),
          },
        },
      }),
    },
    {
      label: "replacement option values",
      expected: "replacement options must be a plain value record",
      invalidate: (input: Parameters<typeof prepareManagedBootstrapSequence>[1]) => ({
        ...input,
        replacementOptions: {
          values: Object.assign(
            Object.create({ inherited: "attacker" }) as Record<
              string,
              string | number | boolean | readonly string[]
            >,
            input.replacementOptions.values,
          ),
        },
      }),
    },
  ])(
    "rejects custom-prototype $label before provider invocation",
    async ({ expected, invalidate }) => {
      const fixture = adapterFor("openclaw");
      const input = invalidate(preparationInput("openclaw"));

      await expect(prepareManagedBootstrapSequence(fixture.adapter, input)).rejects.toThrow(
        expected,
      );
      expect(fixture.adapter.createHeldWorkload).not.toHaveBeenCalled();
      expect(input.create.launch).not.toHaveBeenCalled();
      expect(fixture.order).toEqual([]);
    },
  );

  it("consumes prepared authority exactly once and rejects a second activation", async () => {
    const fixture = adapterFor("openclaw");
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("openclaw"),
    );
    await activateManagedBootstrapSequence(fixture.adapter, {
      transaction: prepared,
      authorityStore: authorityStore(fixture.order),
      timeoutSecs: 30,
    });

    await expect(
      activateManagedBootstrapSequence(fixture.adapter, {
        transaction: prepared,
        authorityStore: authorityStore(fixture.order),
        timeoutSecs: 30,
      }),
    ).rejects.toThrow("exact prepared transaction");
    expect(fixture.order.filter((event) => event === "activate")).toHaveLength(1);
  });

  it("deeply clones authority so later provider mutation cannot change the transaction", async () => {
    const fixture = adapterFor("hermes");
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("hermes"),
    );
    const rawHandle = fixture.raw.handle as ManagedBootstrapHeldWorkloadHandle;
    const rawSnapshot = fixture.raw.snapshot as ManagedBootstrapObservedSnapshot;
    const rawPrepared = fixture.raw.prepared as ManagedBootstrapPreparedReplacementHandle;

    (rawHandle.plan.metadata as Record<string, string>)["nemoclaw.ai/managed-profile"] = "changed";
    (rawSnapshot.supervisorArgv as string[])[0] = "/attacker";
    (rawPrepared as { preparedRuntimeId: string }).preparedRuntimeId = "future-runtime";

    expect(prepared.handle.plan.metadata["nemoclaw.ai/managed-profile"]).toBe(
      requestFor("hermes").profileFingerprint,
    );
    expect(prepared.snapshot.supervisorArgv[0]).toBe("/runtime/sandbox-supervisor");
    expect(prepared.prepared.preparedRuntimeId).toBe(PREPARED_ID);
    expect(() => {
      (prepared.handle.plan.intendedWorkloadArgv as string[]).push("attacker");
    }).toThrow(TypeError);
  });

  it.each([
    [
      "throws before launch",
      (adapter: ManagedBootstrapAdapter) => {
        vi.mocked(adapter.createHeldWorkload).mockRejectedValueOnce(
          new Error("create failed before materialization"),
        );
      },
    ],
    [
      "returns without launch",
      (adapter: ManagedBootstrapAdapter) => {
        vi.mocked(adapter.createHeldWorkload).mockResolvedValueOnce(
          handleFor(requestFor("langchain-deepagents-code")),
        );
      },
    ],
  ] as const)("does not clean up when createHeldWorkload %s", async (_, arrange) => {
    const fixture = adapterFor("langchain-deepagents-code");
    arrange(fixture.adapter);

    const failure = await captureFailure(
      prepareManagedBootstrapSequence(
        fixture.adapter,
        preparationInput("langchain-deepagents-code"),
      ),
    );

    expect(fixture.adapter.cleanupIncompleteCreate).not.toHaveBeenCalled();
    expect(failure.managedBootstrapRollback).toBeUndefined();
    expect(failure.managedBootstrapRollbackError).toBeUndefined();
  });

  it.each(["throws after launch", "returns an invalid handle"] as const)(
    "runs exact cleanup when createHeldWorkload %s",
    async (failureMode) => {
      const fixture = adapterFor("langchain-deepagents-code");
      const original = fixture.adapter.createHeldWorkload;
      switch (failureMode) {
        case "throws after launch":
          vi.mocked(original).mockImplementationOnce(async (input) => {
            await input.launch({
              heldWorkloadArgv: renderManagedBootstrapHeldCommand(
                input.request,
                input.bootstrapIdentity as string,
                input.plan.intendedWorkloadArgv,
              ),
              bootstrapIdentity: input.bootstrapIdentity as string,
            });
            throw new Error("create failed after materialization");
          });
          break;
        default:
          vi.mocked(original).mockImplementationOnce(async (input) => {
            const receipt = await input.launch({
              heldWorkloadArgv: renderManagedBootstrapHeldCommand(
                input.request,
                input.bootstrapIdentity as string,
                input.plan.intendedWorkloadArgv,
              ),
              bootstrapIdentity: input.bootstrapIdentity as string,
            });
            return {
              ...handleFor(requestFor("langchain-deepagents-code"), receipt),
              sandbox: { ...receipt.sandbox, sandboxId: "wrong-owner" },
            };
          });
      }

      const failure = await captureFailure(
        prepareManagedBootstrapSequence(
          fixture.adapter,
          preparationInput("langchain-deepagents-code"),
        ),
      );

      expect(fixture.adapter.cleanupIncompleteCreate).toHaveBeenCalledWith({
        plan: expect.objectContaining({ sandboxName: "alpha", driverId: "mxc-fixture" }),
        bootstrapIdentity: IDENTITY,
        heldWorkloadArgv: expect.arrayContaining([IDENTITY]),
        createReceipt: expect.objectContaining({ sandbox: sandbox(), ready: true }),
      });
      expect(failure.managedBootstrapRollback).toMatchObject({
        outcome: "rolled-back",
        heldWorkloadRemoved: true,
        bootstrapIdentity: IDENTITY,
      });
    },
  );

  it("rejects post-launch createHeldWorkload cleanup for a different sandbox", async () => {
    const fixture = adapterFor("langchain-deepagents-code");
    vi.mocked(fixture.adapter.createHeldWorkload).mockImplementationOnce(async (input) => {
      await input.launch({
        heldWorkloadArgv: renderManagedBootstrapHeldCommand(
          input.request,
          input.bootstrapIdentity as string,
          input.plan.intendedWorkloadArgv,
        ),
        bootstrapIdentity: input.bootstrapIdentity as string,
      });
      throw new Error("create failed after materialization");
    });
    vi.mocked(fixture.adapter.cleanupIncompleteCreate).mockResolvedValueOnce({
      ...cleanupReceipt(),
      sandbox: { ...sandbox(), sandboxId: "unrelated-sandbox" },
    });

    const failure = await captureFailure(
      prepareManagedBootstrapSequence(
        fixture.adapter,
        preparationInput("langchain-deepagents-code"),
      ),
    );

    expect(failure.managedBootstrapRollback).toBeUndefined();
    expect(failure.message).toContain("incomplete-create cleanup sandbox");
  });

  it("cleans only the exact failed prepared replacement and port before retry", async () => {
    const fixture = adapterFor("openclaw");
    const request = requestFor("openclaw");
    const replacementPort = 18_000;
    const unrelatedPort = 18_001;
    const retryPreparedId = "9".repeat(64);
    const authorityKeyFor = (sandboxId: string, bootstrapIdentity: string) =>
      `${sandboxId}:${bootstrapIdentity}`;
    const targetAuthorityKey = authorityKeyFor(sandbox().sandboxId, IDENTITY);
    const unrelatedAuthorityKey = authorityKeyFor(sandbox().sandboxId, "e".repeat(64));
    const unrelatedOwnership = { port: unrelatedPort, runtimeId: "8".repeat(64) };
    const ownedByAuthority = new Map<string, { port: number; runtimeId: string }>([
      [unrelatedAuthorityKey, unrelatedOwnership],
    ]);
    const reservedPorts = new Map<number, string>([[unrelatedPort, unrelatedAuthorityKey]]);
    const stateBeforePreparation: Array<{
      authorityKey: string;
      ownedRuntimeId: string | null;
      portOwner: string | null;
    }> = [];
    const input = {
      ...preparationInput("openclaw"),
      replacementOptions: {
        values: { mode: "native", groups: ["44", "109"], port: replacementPort },
      },
    } as const;
    const allocate = (
      prepareInput: Parameters<ManagedBootstrapAdapter["prepareBootstrapReplacement"]>[0],
      runtimeId: string,
    ) => {
      const authorityKey = authorityKeyFor(
        prepareInput.handle.sandbox.sandboxId,
        prepareInput.handle.bootstrapIdentity,
      );
      stateBeforePreparation.push({
        authorityKey,
        ownedRuntimeId: ownedByAuthority.get(authorityKey)?.runtimeId ?? null,
        portOwner: reservedPorts.get(replacementPort) ?? null,
      });
      expect(prepareInput.replacementOptions.values.port).toBe(replacementPort);
      ownedByAuthority.set(authorityKey, { port: replacementPort, runtimeId });
      reservedPorts.set(replacementPort, authorityKey);
      return { ...preparedFor(request, prepareInput.handle), preparedRuntimeId: runtimeId };
    };

    vi.mocked(fixture.adapter.prepareBootstrapReplacement)
      .mockImplementationOnce(async (prepareInput) => {
        allocate(prepareInput, PREPARED_ID);
        throw new Error("preparation failed after replacement creation");
      })
      .mockImplementationOnce(async (prepareInput) => allocate(prepareInput, retryPreparedId));
    vi.mocked(fixture.adapter.finalizeBootstrap).mockImplementation(async (finalizeInput) => {
      expect(finalizeInput.outcome).toBe("rollback");
      const authorityKey = authorityKeyFor(
        finalizeInput.handle.sandbox.sandboxId,
        finalizeInput.handle.bootstrapIdentity,
      );
      ownedByAuthority.delete(authorityKey);
      expect(reservedPorts.get(replacementPort)).toBe(authorityKey);
      reservedPorts.delete(replacementPort);
      return rolledBackReceipt(finalizeInput.handle, finalizeInput.snapshot);
    });

    const failure = await captureFailure(prepareManagedBootstrapSequence(fixture.adapter, input));

    expect(failure.message).toContain("preparation failed after replacement creation");
    expect(failure.managedBootstrapRollback).toMatchObject({ outcome: "rolled-back" });
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenCalledWith({
      outcome: "rollback",
      handle: expect.objectContaining({ sandbox: sandbox() }),
      snapshot: expect.objectContaining({ runtimeId: RUNTIME_ID, specHash: SPEC_HASH }),
      prepared: null,
      durablePreparation: null,
      replacement: null,
      completion: null,
    });
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenCalledTimes(1);
    expect(ownedByAuthority.has(targetAuthorityKey)).toBe(false);
    expect(reservedPorts.has(replacementPort)).toBe(false);
    expect(ownedByAuthority.get(unrelatedAuthorityKey)).toEqual(unrelatedOwnership);
    expect(reservedPorts.get(unrelatedPort)).toBe(unrelatedAuthorityKey);

    const retried = await prepareManagedBootstrapSequence(fixture.adapter, input);

    expect(stateBeforePreparation).toEqual([
      { authorityKey: targetAuthorityKey, ownedRuntimeId: null, portOwner: null },
      { authorityKey: targetAuthorityKey, ownedRuntimeId: null, portOwner: null },
    ]);
    expect(retried.prepared.preparedRuntimeId).toBe(retryPreparedId);
    expect(ownedByAuthority.get(targetAuthorityKey)).toEqual({
      port: replacementPort,
      runtimeId: retryPreparedId,
    });
    expect(reservedPorts.get(replacementPort)).toBe(targetAuthorityKey);

    await finalizeManagedBootstrapSequence(fixture.adapter, {
      outcome: "rollback",
      transaction: retried,
    });
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenCalledTimes(2);
    expect(ownedByAuthority.has(targetAuthorityKey)).toBe(false);
    expect(reservedPorts.has(replacementPort)).toBe(false);
    expect(ownedByAuthority).toEqual(new Map([[unrelatedAuthorityKey, unrelatedOwnership]]));
    expect(reservedPorts).toEqual(new Map([[unrelatedPort, unrelatedAuthorityKey]]));
  });

  it("rolls back a prepared bootstrap replacement when durable recording fails, before activation", async () => {
    const fixture = adapterFor("openclaw");
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("openclaw"),
    );
    const failure = await captureFailure(
      activateManagedBootstrapSequence(fixture.adapter, {
        transaction: prepared,
        authorityStore: {
          recordPreparedAuthority: vi.fn(async () => {
            throw new Error("durable store unavailable");
          }),
        },
        timeoutSecs: 30,
      }),
    );

    expect(failure.message).toContain("durable store unavailable");
    expect(fixture.adapter.activateBootstrapReplacement).not.toHaveBeenCalled();
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenCalledWith({
      outcome: "rollback",
      handle: prepared.handle,
      snapshot: prepared.snapshot,
      prepared: prepared.prepared,
      durablePreparation: null,
      replacement: null,
      completion: null,
    });
  });

  it("rejects a durable receipt that is not bound to the complete prepared authority", async () => {
    const fixture = adapterFor("hermes");
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("hermes"),
    );
    const failure = await captureFailure(
      activateManagedBootstrapSequence(fixture.adapter, {
        transaction: prepared,
        authorityStore: {
          recordPreparedAuthority: vi.fn(async (authority) => ({
            schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
            sandbox: authority.sandbox,
            bootstrapIdentity: authority.bootstrapIdentity,
            authorityFingerprint: "f".repeat(64),
            recordId: "wrong-record",
            recordedAt: "2026-07-29T12:00:30.000Z",
          })),
        },
        timeoutSecs: 30,
      }),
    );

    expect(failure.message).toContain("changed prepared authority");
    expect(fixture.adapter.activateBootstrapReplacement).not.toHaveBeenCalled();
    expect(failure.managedBootstrapRollback).toMatchObject({ outcome: "rolled-back" });
  });

  it("rejects activated-runtime drift and rolls back from the prepared authority", async () => {
    const fixture = adapterFor("openclaw");
    vi.mocked(fixture.adapter.activateBootstrapReplacement).mockImplementationOnce(
      async ({ handle }) => ({
        ...replacementFor(requestFor("openclaw"), handle),
        replacementRuntimeId: "9".repeat(64),
      }),
    );
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("openclaw"),
    );
    const failure = await captureFailure(
      activateManagedBootstrapSequence(fixture.adapter, {
        transaction: prepared,
        authorityStore: authorityStore(fixture.order),
        timeoutSecs: 30,
      }),
    );

    expect(failure.message).toContain("changed immutable prepared authority");
    expect(fixture.adapter.finalizeBootstrap).toHaveBeenLastCalledWith({
      outcome: "rollback",
      handle: prepared.handle,
      snapshot: prepared.snapshot,
      prepared: prepared.prepared,
      durablePreparation: expect.objectContaining({ bootstrapIdentity: IDENTITY }),
      replacement: null,
      completion: null,
    });
  });

  it("rejects completion drift and retains the primary failure when rollback also fails", async () => {
    const fixture = adapterFor("hermes");
    const rollbackFailure = new Error("rollback unavailable");
    vi.mocked(fixture.adapter.awaitBootstrap).mockImplementationOnce(async ({ handle }) => ({
      ...completionFor(requestFor("hermes"), handle),
      bootstrapIdentity: "a".repeat(64),
    }));
    vi.mocked(fixture.adapter.finalizeBootstrap).mockRejectedValueOnce(rollbackFailure);
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("hermes"),
    );
    const failure = await captureFailure(
      activateManagedBootstrapSequence(fixture.adapter, {
        transaction: prepared,
        authorityStore: authorityStore(fixture.order),
        timeoutSecs: 30,
      }),
    );

    expect(failure.message).toContain("completion receipt changed");
    expect(failure.message).toContain("rollback unavailable");
    expect(failure.managedBootstrapRollbackError).toBe(rollbackFailure);
  });

  it("binds rollback to the snapshot and commit to the activated transaction", async () => {
    const result = await prepareAndActivate("langchain-deepagents-code");
    vi.mocked(result.adapter.finalizeBootstrap).mockResolvedValueOnce({
      ...rolledBackReceipt(result.activated.handle, result.activated.snapshot),
      restoredRuntimeId: "b".repeat(64),
    });
    await expect(
      finalizeManagedBootstrapSequence(result.adapter, {
        outcome: "rollback",
        transaction: result.activated,
      }),
    ).rejects.toThrow("does not restore the exact captured runtime and spec");

    const commitResult = await prepareAndActivate("langchain-deepagents-code");
    const committed = await finalizeManagedBootstrapSequence(commitResult.adapter, {
      outcome: "commit",
      transaction: commitResult.activated,
    });
    expect(committed).toMatchObject({
      outcome: "committed",
      bootstrapIdentity: IDENTITY,
      restoredRuntimeId: null,
    });
  });

  it("refuses commit before activation has produced an exact completion receipt", async () => {
    const fixture = adapterFor("openclaw");
    const prepared = await prepareManagedBootstrapSequence(
      fixture.adapter,
      preparationInput("openclaw"),
    );
    await expect(
      finalizeManagedBootstrapSequence(fixture.adapter, {
        outcome: "commit",
        transaction: prepared,
      }),
    ).rejects.toThrow("commit requires a completed activated transaction");
    expect(fixture.adapter.finalizeBootstrap).not.toHaveBeenCalled();
  });

  it("normalizes, freezes, and orders provider-owned restart recovery receipts", async () => {
    const fixture = adapterFor("openclaw");
    const receipt = cleanupReceipt();
    const candidate = (bootstrapIdentity: string) => ({
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      providerId: receipt.sandbox.driverId,
      sourcePhase: "cutover",
      sandbox: receipt.sandbox,
      bootstrapIdentity,
      outcome: "rolled-back" as const,
      finalization: { ...receipt, bootstrapIdentity },
    });
    vi.mocked(fixture.adapter.recoverUnfinishedTransactions).mockResolvedValueOnce({
      receipts: [candidate("b".repeat(64)), candidate("a".repeat(64))],
      failures: [],
    });

    const recovered = await recoverManagedBootstrapTransactions(fixture.adapter);

    expect(recovered.receipts.map(({ bootstrapIdentity }) => bootstrapIdentity)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(Object.isFrozen(recovered)).toBe(true);
    expect(Object.isFrozen(recovered.receipts)).toBe(true);
    expect(recovered.receipts.every((entry) => Object.isFrozen(entry.finalization))).toBe(true);
  });

  it("rejects recovery evidence whose provider does not own the durable sandbox", async () => {
    const fixture = adapterFor("openclaw");
    const receipt = cleanupReceipt();
    vi.mocked(fixture.adapter.recoverUnfinishedTransactions).mockResolvedValueOnce({
      receipts: [
        {
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          providerId: "mxc",
          sourcePhase: "cutover",
          sandbox: receipt.sandbox,
          bootstrapIdentity: IDENTITY,
          outcome: "rolled-back",
          finalization: receipt,
        },
      ],
      failures: [],
    });

    await expect(recoverManagedBootstrapTransactions(fixture.adapter)).rejects.toThrow(
      "recovery provider does not own",
    );
  });

  it("normalizes provider-neutral failures and preserves bounded MXC-style diagnostics", async () => {
    const fixture = adapterFor("hermes");
    const failure = (bootstrapIdentity: string, sandboxName: string | null) => ({
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      providerId: "mxc",
      sourcePhase: "provider-owned-cleanup",
      sandbox:
        sandboxName === null
          ? null
          : { sandboxName, sandboxId: `mxc-${sandboxName}`, driverId: "mxc" },
      bootstrapIdentity,
      code: "provider-owned-retry",
      blockingScope: "sandbox" as const,
      retryable: true,
      detail: "opaque MXC recovery evidence",
    });
    vi.mocked(fixture.adapter.recoverUnfinishedTransactions).mockResolvedValueOnce({
      receipts: [],
      failures: [failure("b".repeat(64), "bravo"), failure("a".repeat(64), null)],
    });

    const recovered = await recoverManagedBootstrapTransactions(fixture.adapter);

    expect(recovered.failures.map(({ bootstrapIdentity }) => bootstrapIdentity)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(recovered.failures[0]).toMatchObject({ sandbox: null, providerId: "mxc" });
    expect(Object.isFrozen(recovered.failures)).toBe(true);
    expect(recovered.failures.every(Object.isFrozen)).toBe(true);
  });

  it("rejects duplicate identities across recovered receipts and failures", async () => {
    const fixture = adapterFor("openclaw");
    const receipt = cleanupReceipt();
    vi.mocked(fixture.adapter.recoverUnfinishedTransactions).mockResolvedValueOnce({
      receipts: [
        {
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          providerId: receipt.sandbox.driverId,
          sourcePhase: "cutover",
          sandbox: receipt.sandbox,
          bootstrapIdentity: IDENTITY,
          outcome: "rolled-back",
          finalization: receipt,
        },
      ],
      failures: [
        {
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          providerId: receipt.sandbox.driverId,
          sourcePhase: "cleanup",
          sandbox: receipt.sandbox,
          bootstrapIdentity: IDENTITY,
          code: "retry",
          blockingScope: "sandbox",
          retryable: true,
          detail: "retained",
        },
      ],
    });

    await expect(recoverManagedBootstrapTransactions(fixture.adapter)).rejects.toThrow(
      "duplicate bootstrap identities",
    );
  });

  it("rejects an unbounded provider recovery result before normalizing records", async () => {
    const fixture = adapterFor("hermes");
    const candidate = {
      schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
      providerId: "mxc",
      sourcePhase: "provider-owned-cleanup",
      sandbox: null,
      bootstrapIdentity: IDENTITY,
      code: "provider-owned-retry",
      blockingScope: "sandbox",
      retryable: true,
      detail: "opaque MXC recovery evidence",
    } as const;
    vi.mocked(fixture.adapter.recoverUnfinishedTransactions).mockResolvedValueOnce({
      receipts: [],
      failures: Array.from({ length: 4097 }, () => candidate),
    });

    await expect(recoverManagedBootstrapTransactions(fixture.adapter)).rejects.toThrow(
      "provider recovery returned too many records",
    );
  });

  it.each([
    { scenario: "same-name failure" },
    { scenario: "unknown-identity failure" },
    { scenario: "provider-wide failure" },
  ])(
    "blocks same-name, identity-unknown, and provider-wide failures while warning for unrelated sandboxes [$scenario]",
    ({ scenario }) => {
      const failure = (bootstrapIdentity: string, sandboxName: string | null) =>
        Object.freeze({
          schemaVersion: MANAGED_BOOTSTRAP_SCHEMA_VERSION,
          providerId: "mxc",
          sourcePhase: "cleanup",
          sandbox:
            sandboxName === null
              ? null
              : Object.freeze({ sandboxName, sandboxId: `mxc-${sandboxName}`, driverId: "mxc" }),
          bootstrapIdentity,
          code: "provider-owned-retry",
          blockingScope: "sandbox",
          retryable: true,
          detail: "opaque provider detail",
        });
      const warn = vi.fn();
      const unrelated = failure("a".repeat(64), "bravo");
      const sameName = failure("b".repeat(64), "alpha");
      const identityUnknown = failure("c".repeat(64), null);
      const providerWide = Object.freeze({
        ...failure("d".repeat(64), "bravo"),
        blockingScope: "provider" as const,
      });

      expect(
        enforceManagedBootstrapRecoveryForSandbox(
          Object.freeze({ receipts: Object.freeze([]), failures: Object.freeze([unrelated]) }),
          "alpha",
          warn,
        ),
      ).toMatchObject({ failures: [unrelated] });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("unrelated sandbox 'bravo'"));

      const blocking = (
        {
          "same-name failure": sameName,
          "unknown-identity failure": identityUnknown,
          "provider-wide failure": providerWide,
        } as const
      )[scenario]!;
      expect(() =>
        enforceManagedBootstrapRecoveryForSandbox(
          Object.freeze({ receipts: Object.freeze([]), failures: Object.freeze([blocking]) }),
          "alpha",
          warn,
        ),
      ).toThrow(ManagedBootstrapRecoveryBlockedError);
    },
  );

  it.each([
    "BASHOPTS=extdebug",
    "BASH_ENV=/sandbox/attacker",
    "ENV=/sandbox/attacker",
    "LD_AUDIT=/sandbox/attacker.so",
    "LD_LIBRARY_PATH=/sandbox/lib",
    "LD_PRELOAD=/sandbox/attacker.so",
    "NODE_OPTIONS=--require=/sandbox/attacker.cjs",
    "NODE_PATH=/sandbox/attacker-modules",
    "PS4=$(touch /sandbox/bypass)",
    "SHELLOPTS=xtrace",
    "BASH_FUNC_attacker%%=() { touch /sandbox/bypass; }",
  ])("rejects a process-control assignment before rendering the held command: %s", (assignment) => {
    const request = requestFor("hermes");
    expect(() =>
      renderManagedBootstrapHeldCommand(request, IDENTITY, [
        "env",
        assignment,
        "/usr/local/bin/nemoclaw-start",
      ]),
    ).toThrow("process-control environment assignment");
  });
});
