// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  captureSandboxRebuildAuthority,
  type SandboxRebuildAuthoritySwapResult,
  swapSandboxRebuildAuthorityInRegistry,
} from "../state/registry/rebuild-authority";
import type { SandboxEntry, SandboxRegistry } from "../state/registry/types";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
  type ShippedManagedImageAgent,
} from "./managed-image/contract";
import type { BuiltManagedStartupOnboardProfile } from "./managed-startup/onboard-profile";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
} from "./managed-startup/profile";
import {
  type ManagedWorkloadRebuildProviderOperations,
  ManagedWorkloadRebuildTransactionError,
  type PreparedManagedWorkloadReplacement,
  type ReadyManagedWorkloadReplacement,
  type ReboundManagedWorkloadReplacement,
  type RestoredManagedWorkloadReplacement,
  type StagedManagedWorkloadReplacement,
} from "./managed-workload/rebuild/contract";
import { createManagedWorkloadReplacementRollback } from "./managed-workload/rebuild/rollback";
import { runManagedWorkloadRebuildTransaction } from "./managed-workload/rebuild/transaction";
import type { RuntimeProviderBundle } from "./runtime-provider/contract";
import { RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION } from "./runtime-provider/contract";
import { createRuntimeProviderBundleRegistry } from "./runtime-provider/registry";
import type { ManagedWorkloadRebuildHandoff, ManagedWorkloadReceipt } from "./workload/rebuild";

const AGENTS = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
const PROVIDERS = ["docker", "mxc"] as const;
const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
const OLD_RELEASE = "v0.0.99";
const NEW_RELEASE = "v0.0.100";

function raiseInjectedFailure(message: string): never {
  throw new Error(message);
}

function failWhenInjected(condition: boolean, message: string): void {
  condition ? raiseInjectedFailure(message) : undefined;
}

function contract(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
  platform: (typeof PLATFORMS)[number] = "linux/amd64",
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digit = generation === "old" ? "a" : "b";
  const digest = `sha256:${digit.repeat(64)}` as const;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform,
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: digit.repeat(40),
      release: generation === "old" ? OLD_RELEASE : NEW_RELEASE,
      cohort: generation === "old" ? "ghrun-100-1" : "ghrun-200-2",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function profileTransport(agent: ShippedManagedImageAgent): BuiltManagedStartupOnboardProfile {
  const profile = managedStartupE2eProfile(agent);
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    profile,
    encodedProfile: encodedProfile as BuiltManagedStartupOnboardProfile["encodedProfile"],
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    credentialProxyReplayRequired: false,
  };
}

function workloadReceipt(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
  platform: (typeof PLATFORMS)[number] = "linux/amd64",
): ManagedWorkloadReceipt {
  const image = contract(agent, generation, platform);
  const transport = profileTransport(agent);
  return {
    schemaVersion: 1,
    kind: "managed-image",
    reference: image.reference,
    platform: image.platform,
    release: image.source.release,
    sourceRevision: image.source.revision,
    sourceCohort: image.source.cohort,
    capabilityContractVersion: image.capabilityContractVersion,
    startupProfileContractVersion: image.startupProfileContractVersion,
    encodedProfile: transport.encodedProfile,
    startupProfileSha256: transport.startupProfileSha256,
    credentialProxyReplayRequired: false,
    shared: true,
  };
}

function previousEntry(
  agent: ShippedManagedImageAgent,
  providerId: string,
  platform: (typeof PLATFORMS)[number] = "linux/amd64",
): SandboxEntry {
  const workload = workloadReceipt(agent, "old", platform);
  return {
    name: `rebuild-${agent}`,
    agent,
    openshellDriver: providerId,
    provider: "ollama-local",
    model: "nvidia/nemotron",
    imageTag: workload.reference,
    workload,
    lifecycleGeneration: "generation-old",
    lifecycleLiveIdentityFingerprint: "fingerprint-old",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
  };
}

function handoff(
  agent: ShippedManagedImageAgent,
  providerId: string,
  platform: (typeof PLATFORMS)[number] = "linux/amd64",
): ManagedWorkloadRebuildHandoff {
  const previousContract = contract(agent, "old", platform);
  const replacementContract = contract(agent, "new", platform);
  const previousProfile = decodeManagedStartupProfile(
    encodeManagedStartupProfile(managedStartupE2eProfile(agent)),
  );
  return {
    schemaVersion: 1,
    providerId,
    agent,
    previousReceipt: workloadReceipt(agent, "old", platform),
    previousContract,
    previousProfile,
    replacement: {
      source: {
        kind: "managed-image",
        reference: replacementContract.reference,
        contract: replacementContract,
      },
      release: NEW_RELEASE,
      fallbackDiagnostic: null,
    },
    corporateCa: null,
    replacementProfile: profileTransport(agent),
  };
}

function unsupported(providerId: string) {
  return {
    providerId,
    supported: false as const,
    reason: "not used by the rebuild transaction contract test",
  };
}

function bundle(providerId: string): RuntimeProviderBundle {
  const candidate: RuntimeProviderBundle = {
    identity: {
      contractVersion: RUNTIME_PROVIDER_BUNDLE_CONTRACT_VERSION,
      id: providerId,
      displayName: `In-memory ${providerId}`,
    },
    plan: { providerId, supported: true, gatewayLauncher: "nemoclaw" },
    capabilities: {
      providerId,
      supported: true,
      hostLocalInference: false,
      directLifecycle: false,
      legacyGatewayContainerInspection: false,
      workloadImageCleanup: false,
      readOnlyHostMounts: {
        supported: false,
        reason: "not used by the rebuild transaction contract test",
      },
    },
    preflightDoctor: {
      providerId,
      supported: true,
      inspectHost: () => ({
        group: "Host",
        label: `${providerId} in-memory provider`,
        status: "ok",
        detail: "socket-free",
      }),
      validateSandboxGpu: () => undefined,
      preflightLifecycle: () => null,
    },
    gateway: {
      providerId,
      supported: true,
      launcher: "nemoclaw",
      inspectLegacyContainer: false,
      prepareHostRuntime: () => ({
        providerId,
        openShellDriver: "memory",
        bindAddress: "127.0.0.1",
        grpcHost: "127.0.0.1",
        sshGatewayHost: "127.0.0.1",
        portCheckHost: "127.0.0.1",
        socketPath: null,
        requiredServerIpSans: [],
        sandboxHostAddress: null,
        usesHostGatewayRoute: false,
        resourceOwnership: { label: "test.managed", value: providerId },
        gatewayConfig: {
          sandboxNamespace: "scoped",
          hostGatewayIp: null,
          includeSupervisorBin: true,
          processOwnership: "scoped-namespace",
        },
        network: {
          sandboxSourceCidrs: () => [],
          inspect: () => undefined,
          usesHostGatewayRoute: () => false,
          run: () => ({ status: 0 }),
          ensureProbeImageCached: () => ({ ok: true, alreadyCached: true }),
        },
      }),
    },
    workload: {
      providerId,
      supported: true,
      profile: {
        support: {
          exactDigestReferences: true,
          platforms: ["linux/amd64", "linux/arm64"],
          startupProfileContractVersions: [1],
          capabilityContractVersions: [1],
        },
        hostArchitectures: ["amd64", "arm64"],
        managedImageSelectionPolicy: "require-managed",
        legacyDockerfileBuilds: false,
      },
      acceptsReceipt: (receipt) => receipt?.kind === "managed-image",
    },
    hostLocalInference: unsupported(providerId),
    lifecycle: unsupported(providerId),
    mutationAuthority: {
      providerId,
      supported: true,
      operations: ["rebuild"],
    },
    stateMutation: unsupported(providerId),
    bootstrap: unsupported(providerId),
    snapshot: unsupported(providerId),
    recovery: unsupported(providerId),
    cleanup: unsupported(providerId),
    containerEngine: unsupported(providerId),
  };
  return createRuntimeProviderBundleRegistry([[providerId, candidate]])[providerId]!;
}

type FailurePhase =
  | "prepare"
  | "create"
  | "readiness"
  | "restore"
  | "provider-rebind"
  | "registry-commit"
  | "registry-commit-before-persist"
  | "registry-commit-after-persist"
  | "registry-commit-after-persist-read-fails"
  | "registry-read-after-prepare"
  | "retire-previous"
  | "abort-preparation"
  | null;

function operationsHarness(
  providerId: string,
  events: string[],
  failAt: FailurePhase = null,
  previousLiveIdentityFingerprint = "fingerprint-old",
): ManagedWorkloadRebuildProviderOperations {
  const bound = {
    schemaVersion: 1 as const,
    providerId,
    transactionId: "transaction-1",
  };
  const prepared: PreparedManagedWorkloadReplacement = {
    ...bound,
    previousRuntimeHandle: "runtime-old-exact",
    preparationHandle: "preparation-exact",
    previousLiveIdentityFingerprint,
  };
  const staged: StagedManagedWorkloadReplacement = {
    ...bound,
    previousRuntimeHandle: prepared.previousRuntimeHandle,
    stagingHandle: "runtime-new-staged-exact",
    lifecycleGeneration: "generation-new",
    liveIdentityFingerprint: "fingerprint-new",
  };
  const ready: ReadyManagedWorkloadReplacement = {
    ...staged,
    readinessReceipt: "ready-exact",
  };
  const restored: RestoredManagedWorkloadReplacement = {
    ...ready,
    restoreReceipt: "restore-exact",
  };
  const rebound: ReboundManagedWorkloadReplacement = {
    ...restored,
    providerRebindReceipt: "provider-rebind-exact",
  };
  const result = <T>(phase: Exclude<FailurePhase, null>, value: T): Promise<T> =>
    failAt === phase
      ? Promise.reject(new Error(`${phase} injected failure`))
      : Promise.resolve(value);

  return {
    providerId,
    prepare: vi.fn(async () => {
      events.push("prepare");
      return result("prepare", prepared);
    }),
    create: vi.fn(async () => {
      events.push("create");
      return result("create", staged);
    }),
    abortPreparation: vi.fn(async (plan) => {
      events.push(`abort-preparation:${plan.transactionId}`);
      return result("abort-preparation", undefined);
    }),
    waitUntilReady: vi.fn(async () => {
      events.push("readiness");
      return failAt === "readiness"
        ? { state: "not-ready" as const, reason: "replacement is not Ready" }
        : { state: "ready" as const, replacement: ready };
    }),
    restoreState: vi.fn(async () => {
      events.push("restore");
      return result("restore", restored);
    }),
    rebindProviders: vi.fn(async () => {
      events.push("provider-rebind");
      return result("provider-rebind", rebound);
    }),
    rollback: vi.fn(async (_plan, value) => {
      events.push(`rollback:${value.stagingHandle}`);
    }),
    retirePrevious: vi.fn(async (_plan, value) => {
      events.push(`retire:${value.previousRuntimeHandle}`);
      return result("retire-previous", undefined);
    }),
  };
}

function transactionHarness(
  agent: ShippedManagedImageAgent,
  providerId: string,
  failAt: FailurePhase = null,
  platform: (typeof PLATFORMS)[number] = "linux/amd64",
  previousEntryOverrides: Partial<SandboxEntry> = {},
) {
  const events: string[] = [];
  const oldEntry = { ...previousEntry(agent, providerId, platform), ...previousEntryOverrides };
  let currentEntry = structuredClone(oldEntry);
  let providerPreparationCompleted = false;
  let ambiguousPersistenceReadback = false;
  const operations = operationsHarness(
    providerId,
    events,
    failAt,
    oldEntry.lifecycleLiveIdentityFingerprint,
  );
  const prepare = operations.prepare;
  operations.prepare = vi.fn(async (plan) => {
    const prepared = await prepare(plan);
    providerPreparationCompleted = true;
    return prepared;
  });
  const commitAuthority = (
    expected: ReturnType<typeof captureSandboxRebuildAuthority>,
    replacement: SandboxEntry,
  ): SandboxRebuildAuthoritySwapResult => {
    events.push("registry-commit");
    failWhenInjected(
      failAt === "registry-commit-before-persist",
      "registry write failed before persistence",
    );
    const currentRegistry: SandboxRegistry = {
      sandboxes: { [oldEntry.name]: currentEntry },
      defaultSandbox: oldEntry.name,
    };
    const swapped =
      failAt === "registry-commit"
        ? {
            registry: currentRegistry,
            result: {
              status: "stale-authority" as const,
              entry: structuredClone(currentEntry),
            },
          }
        : swapSandboxRebuildAuthorityInRegistry(currentRegistry, expected, replacement);
    currentEntry =
      swapped.result.status === "committed" ? structuredClone(swapped.result.entry) : currentEntry;
    ambiguousPersistenceReadback = failAt === "registry-commit-after-persist-read-fails";
    failWhenInjected(
      failAt === "registry-commit-after-persist" ||
        failAt === "registry-commit-after-persist-read-fails",
      "registry acknowledgement lost after persistence",
    );
    return swapped.result;
  };
  return {
    events,
    oldEntry,
    operations,
    currentEntry: () => currentEntry,
    run: () =>
      runManagedWorkloadRebuildTransaction(
        {
          previousEntry: oldEntry,
          provider: bundle(providerId),
          handoff: handoff(agent, providerId, platform),
          operations,
          replacementMetadata: { model: "nvidia/nemotron-new" },
          transactionId: "transaction-1",
        },
        {
          getSandbox: () => {
            failWhenInjected(
              failAt === "registry-read-after-prepare" && providerPreparationCompleted,
              "registry read failed after provider preparation",
            );
            providerPreparationCompleted = false;
            failWhenInjected(
              failAt === "registry-commit-after-persist-read-fails" && ambiguousPersistenceReadback,
              "registry readback failed after ambiguous persistence",
            );
            ambiguousPersistenceReadback = false;
            return structuredClone(currentEntry);
          },
          commitAuthority,
        },
      ),
  };
}

type RebuildOperationName =
  | "create"
  | "waitUntilReady"
  | "restoreState"
  | "rebindProviders"
  | "retirePrevious";

interface InvalidProviderArtifactCase {
  readonly name: string;
  readonly phase: Exclude<FailurePhase, null>;
  readonly install: (operations: ManagedWorkloadRebuildProviderOperations) => void;
  readonly events: readonly string[];
  readonly notCalled: readonly RebuildOperationName[];
  readonly abortCalls: number;
  readonly rollbackCalls: number;
}

const INVALID_PROVIDER_ARTIFACT_CASES: readonly InvalidProviderArtifactCase[] = [
  {
    name: "rejects a prepared artifact bound to another provider",
    phase: "prepare",
    install: (operations) => {
      const prepare = operations.prepare;
      operations.prepare = vi.fn(async (plan) => ({
        ...(await prepare(plan)),
        providerId: "other-provider",
      }));
    },
    events: ["prepare", "abort-preparation:transaction-1"],
    notCalled: ["create", "waitUntilReady", "restoreState", "rebindProviders", "retirePrevious"],
    abortCalls: 1,
    rollbackCalls: 0,
  },
  {
    name: "rejects a prepared artifact with a NUL-bearing preparation handle",
    phase: "prepare",
    install: (operations) => {
      const prepare = operations.prepare;
      operations.prepare = vi.fn(async (plan) => ({
        ...(await prepare(plan)),
        preparationHandle: "preparation\0invalid",
      }));
    },
    events: ["prepare", "abort-preparation:transaction-1"],
    notCalled: ["create", "waitUntilReady", "restoreState", "rebindProviders", "retirePrevious"],
    abortCalls: 1,
    rollbackCalls: 0,
  },
  {
    name: "rejects a staged artifact that changes the exact old handle",
    phase: "create",
    install: (operations) => {
      const create = operations.create;
      operations.create = vi.fn(async (plan, prepared) => ({
        ...(await create(plan, prepared)),
        previousRuntimeHandle: "runtime-old-substituted",
      }));
    },
    events: ["prepare", "create", "abort-preparation:transaction-1"],
    notCalled: ["waitUntilReady", "restoreState", "rebindProviders", "retirePrevious"],
    abortCalls: 1,
    rollbackCalls: 0,
  },
  {
    name: "rejects a staged artifact with an oversized staging handle",
    phase: "create",
    install: (operations) => {
      const create = operations.create;
      operations.create = vi.fn(async (plan, prepared) => ({
        ...(await create(plan, prepared)),
        stagingHandle: "x".repeat(16 * 1024 + 1),
      }));
    },
    events: ["prepare", "create", "abort-preparation:transaction-1"],
    notCalled: ["waitUntilReady", "restoreState", "rebindProviders", "retirePrevious"],
    abortCalls: 1,
    rollbackCalls: 0,
  },
  {
    name: "rejects a ready artifact that changes the exact staging handle",
    phase: "readiness",
    install: (operations) => {
      const waitUntilReady = operations.waitUntilReady;
      operations.waitUntilReady = vi.fn(async (plan, staged) => {
        const result = await waitUntilReady(plan, staged);
        const ready = result as Extract<typeof result, { readonly state: "ready" }>;
        return {
          state: "ready" as const,
          replacement: {
            ...ready.replacement,
            stagingHandle: "runtime-new-substituted",
          },
        };
      });
    },
    events: ["prepare", "create", "readiness", "rollback:runtime-new-staged-exact"],
    notCalled: ["restoreState", "rebindProviders", "retirePrevious"],
    abortCalls: 0,
    rollbackCalls: 1,
  },
  {
    name: "rejects a ready artifact with a NUL-bearing readiness receipt",
    phase: "readiness",
    install: (operations) => {
      const waitUntilReady = operations.waitUntilReady;
      operations.waitUntilReady = vi.fn(async (plan, staged) => {
        const result = await waitUntilReady(plan, staged);
        const ready = result as Extract<typeof result, { readonly state: "ready" }>;
        return {
          state: "ready" as const,
          replacement: {
            ...ready.replacement,
            readinessReceipt: "ready\0invalid",
          },
        };
      });
    },
    events: ["prepare", "create", "readiness", "rollback:runtime-new-staged-exact"],
    notCalled: ["restoreState", "rebindProviders", "retirePrevious"],
    abortCalls: 0,
    rollbackCalls: 1,
  },
  {
    name: "rejects a restored artifact that alters the readiness receipt",
    phase: "restore",
    install: (operations) => {
      const restoreState = operations.restoreState;
      operations.restoreState = vi.fn(async (plan, ready) => ({
        ...(await restoreState(plan, ready)),
        readinessReceipt: "ready-substituted",
      }));
    },
    events: ["prepare", "create", "readiness", "restore", "rollback:runtime-new-staged-exact"],
    notCalled: ["rebindProviders", "retirePrevious"],
    abortCalls: 0,
    rollbackCalls: 1,
  },
  {
    name: "rejects a restored artifact with an oversized restore receipt",
    phase: "restore",
    install: (operations) => {
      const restoreState = operations.restoreState;
      operations.restoreState = vi.fn(async (plan, ready) => ({
        ...(await restoreState(plan, ready)),
        restoreReceipt: "x".repeat(16 * 1024 + 1),
      }));
    },
    events: ["prepare", "create", "readiness", "restore", "rollback:runtime-new-staged-exact"],
    notCalled: ["rebindProviders", "retirePrevious"],
    abortCalls: 0,
    rollbackCalls: 1,
  },
  {
    name: "rejects a rebound artifact that alters the restore receipt",
    phase: "provider-rebind",
    install: (operations) => {
      const rebindProviders = operations.rebindProviders;
      operations.rebindProviders = vi.fn(async (plan, restored) => ({
        ...(await rebindProviders(plan, restored)),
        restoreReceipt: "restore-substituted",
      }));
    },
    events: [
      "prepare",
      "create",
      "readiness",
      "restore",
      "provider-rebind",
      "rollback:runtime-new-staged-exact",
    ],
    notCalled: ["retirePrevious"],
    abortCalls: 0,
    rollbackCalls: 1,
  },
  {
    name: "rejects a rebound artifact bound to another transaction",
    phase: "provider-rebind",
    install: (operations) => {
      const rebindProviders = operations.rebindProviders;
      operations.rebindProviders = vi.fn(async (plan, restored) => ({
        ...(await rebindProviders(plan, restored)),
        transactionId: "other-transaction",
      }));
    },
    events: [
      "prepare",
      "create",
      "readiness",
      "restore",
      "provider-rebind",
      "rollback:runtime-new-staged-exact",
    ],
    notCalled: ["retirePrevious"],
    abortCalls: 0,
    rollbackCalls: 1,
  },
];

describe("managed workload rebuild transaction", () => {
  it.each(
    AGENTS.flatMap((agent) =>
      PROVIDERS.flatMap((provider) =>
        PLATFORMS.map((platform) => [agent, provider, platform] as const),
      ),
    ),
  )(
    "atomically rebuilds %s through the socket-free %s provider contract on %s",
    async (agent, provider, platform) => {
      const harness = transactionHarness(agent, provider, null, platform);

      const result = await harness.run();

      expect(result).toMatchObject({
        status: "committed",
        previousCleanup: "complete",
        entry: {
          agent,
          openshellDriver: provider,
          model: "nvidia/nemotron-new",
          fromDockerfile: null,
          lifecycleGeneration: "generation-new",
          lifecycleLiveIdentityFingerprint: "fingerprint-new",
          workload: {
            kind: "managed-image",
            platform,
            release: NEW_RELEASE,
            shared: true,
          },
        },
      });
      expect(harness.events).toEqual([
        "prepare",
        "create",
        "readiness",
        "restore",
        "provider-rebind",
        "registry-commit",
        "retire:runtime-old-exact",
      ]);
      expect(harness.currentEntry()).toEqual(result.entry);
      expect(harness.currentEntry().imageTag).not.toBe(harness.oldEntry.imageTag);
    },
  );

  it.each([
    ["prepare", false],
    ["create", false],
    ["readiness", true],
    ["restore", true],
    ["provider-rebind", true],
    ["registry-commit", true],
  ] as const)("keeps old authority when %s fails", async (phase, expectsRollback) => {
    const harness = transactionHarness("openclaw", "mxc", phase);

    await expect(harness.run()).rejects.toMatchObject({ phase });

    expect(harness.currentEntry()).toEqual(harness.oldEntry);
    expect(harness.events.some((event) => event === "retire:runtime-old-exact")).toBe(false);
    expect(harness.events.some((event) => event === "rollback:runtime-new-staged-exact")).toBe(
      expectsRollback,
    );
    expect(harness.events.some((event) => event === "abort-preparation:transaction-1")).toBe(
      phase === "prepare" || phase === "create",
    );
  });

  it("rolls back a not-ready replacement by exact staged handle", async () => {
    const harness = transactionHarness("hermes", "docker", "readiness");

    await expect(harness.run()).rejects.toMatchObject({
      phase: "readiness",
      message: expect.stringContaining("replacement is not Ready"),
    });
    expect(harness.events).toEqual([
      "prepare",
      "create",
      "readiness",
      "rollback:runtime-new-staged-exact",
    ]);
    expect(harness.currentEntry().lifecycleGeneration).toBe("generation-old");
  });

  it.each(INVALID_PROVIDER_ARTIFACT_CASES)(
    "$name and stops at the invalid transition",
    async ({ phase, install, events, notCalled, abortCalls, rollbackCalls }) => {
      const harness = transactionHarness("langchain-deepagents-code", "mxc");
      install(harness.operations);

      await expect(harness.run()).rejects.toMatchObject({ phase });

      expect(harness.currentEntry()).toEqual(harness.oldEntry);
      expect(harness.events).toEqual(events);
      expect(harness.operations.abortPreparation).toHaveBeenCalledTimes(abortCalls);
      expect(harness.operations.rollback).toHaveBeenCalledTimes(rollbackCalls);
      notCalled.forEach((operation) => {
        expect(harness.operations[operation]).not.toHaveBeenCalled();
      });
    },
  );

  it("aborts preparation when durable registry metadata drifts during preparation", async () => {
    const events: string[] = [];
    const oldEntry = previousEntry("openclaw", "mxc");
    let currentEntry = structuredClone(oldEntry);
    const operations = operationsHarness("mxc", events);
    const prepare = operations.prepare;
    operations.prepare = vi.fn(async (plan) => {
      const prepared = await prepare(plan);
      currentEntry = {
        ...currentEntry,
        model: "concurrently-updated",
      };
      return prepared;
    });

    await expect(
      runManagedWorkloadRebuildTransaction(
        {
          previousEntry: oldEntry,
          provider: bundle("mxc"),
          handoff: handoff("openclaw", "mxc"),
          operations,
          transactionId: "transaction-1",
        },
        { getSandbox: () => structuredClone(currentEntry) },
      ),
    ).rejects.toMatchObject({ phase: "prepare" });
    expect(events).toEqual(["prepare", "abort-preparation:transaction-1"]);
    expect(operations.create).not.toHaveBeenCalled();
    expect(operations.rollback).not.toHaveBeenCalled();
  });

  it("aborts preparation when the post-prepare registry read fails", async () => {
    const harness = transactionHarness("openclaw", "mxc", "registry-read-after-prepare");

    await expect(harness.run()).rejects.toMatchObject({ phase: "prepare" });

    expect(harness.events).toEqual(["prepare", "abort-preparation:transaction-1"]);
    expect(harness.operations.create).not.toHaveBeenCalled();
    expect(harness.operations.rollback).not.toHaveBeenCalled();
    expect(harness.currentEntry()).toEqual(harness.oldEntry);
  });

  it("preserves the original phase and message when preparation abort also fails", async () => {
    const harness = transactionHarness("openclaw", "mxc", "abort-preparation");
    const prepare = harness.operations.prepare;
    harness.operations.prepare = vi.fn(async (plan) => {
      await prepare(plan);
      throw new ManagedWorkloadRebuildTransactionError("prepare", "original prepare failure");
    });

    let failure: unknown;
    try {
      await harness.run();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const transactionFailure = failure as Error & {
      readonly phase: string;
      readonly rollbackError: unknown;
    };
    expect(transactionFailure.phase).toBe("prepare");
    expect(transactionFailure.message).toContain("original prepare failure");
    expect(transactionFailure.rollbackError).toMatchObject({
      message: "abort-preparation injected failure",
    });
    expect(harness.events).toEqual(["prepare", "abort-preparation:transaction-1"]);
    expect(harness.operations.create).not.toHaveBeenCalled();
    expect(harness.operations.rollback).not.toHaveBeenCalled();
  });

  it("reports exact-old cleanup as pending without undoing a committed replacement", async () => {
    const harness = transactionHarness("langchain-deepagents-code", "mxc", "retire-previous");

    const result = await harness.run();

    expect(result).toMatchObject({
      status: "committed",
      previousCleanup: "pending",
      cleanupError: expect.any(Error),
      recoveryTask: {
        owner: "durable-managed-workload-recovery",
        operation: "retire-previous",
        previousRuntimeHandle: "runtime-old-exact",
        stagingHandle: "runtime-new-staged-exact",
      },
    });
    expect(harness.currentEntry().lifecycleGeneration).toBe("generation-new");
    expect(harness.events.at(-1)).toBe("retire:runtime-old-exact");
    expect(harness.operations.rollback).not.toHaveBeenCalled();
  });

  it("reconciles a persisted replacement when the CAS acknowledgement throws", async () => {
    const harness = transactionHarness(
      "openclaw",
      "mxc",
      "registry-commit-after-persist",
      "linux/arm64",
    );

    const result = await harness.run();

    expect(result).toMatchObject({
      status: "committed",
      entry: {
        lifecycleGeneration: "generation-new",
        workload: { platform: "linux/arm64" },
      },
    });
    expect(harness.currentEntry()).toEqual(result.entry);
    expect(harness.operations.rollback).not.toHaveBeenCalled();
    expect(harness.events.at(-1)).toBe("retire:runtime-old-exact");
  });

  it("never rolls back an ambiguously published replacement when readback also fails", async () => {
    const harness = transactionHarness(
      "openclaw",
      "mxc",
      "registry-commit-after-persist-read-fails",
    );

    await expect(harness.run()).rejects.toMatchObject({
      name: "ManagedWorkloadRebuildIndeterminatePublicationError",
      phase: "registry-commit",
      recoveryTask: {
        owner: "durable-managed-workload-recovery",
        operation: "reconcile-publication",
        previousRuntimeHandle: "runtime-old-exact",
        stagingHandle: "runtime-new-staged-exact",
      },
    });

    expect(harness.currentEntry().lifecycleGeneration).toBe("generation-new");
    expect(harness.operations.rollback).not.toHaveBeenCalled();
    expect(harness.operations.retirePrevious).not.toHaveBeenCalled();
  });

  it("rolls back only after an ambiguous write is reconciled to exact old authority", async () => {
    const harness = transactionHarness("openclaw", "mxc", "registry-commit-before-persist");

    await expect(harness.run()).rejects.toMatchObject({ phase: "registry-commit" });

    expect(harness.currentEntry()).toEqual(harness.oldEntry);
    expect(harness.operations.rollback).toHaveBeenCalledOnce();
  });

  it("coalesces repeated rollback calls onto one exact-handle operation", async () => {
    const events: string[] = [];
    const providerOperations = operationsHarness("mxc", events);
    const plan = {
      schemaVersion: 1 as const,
      transactionId: "transaction-1",
      sandboxName: "alpha",
      providerId: "mxc",
      agent: "openclaw" as const,
      previousAuthority: captureSandboxRebuildAuthority(previousEntry("openclaw", "mxc"), "mxc"),
      handoff: handoff("openclaw", "mxc"),
      replacementReceipt: workloadReceipt("openclaw", "new"),
      replacementMetadata: {},
    };
    const staged: StagedManagedWorkloadReplacement = {
      schemaVersion: 1,
      providerId: "mxc",
      transactionId: "transaction-1",
      previousRuntimeHandle: "runtime-old-exact",
      stagingHandle: "runtime-new-staged-exact",
      lifecycleGeneration: "generation-new",
      liveIdentityFingerprint: "fingerprint-new",
    };
    const rollback = createManagedWorkloadReplacementRollback(plan, staged, providerOperations);

    await Promise.all([rollback.run(), rollback.run(), rollback.run()]);
    await rollback.run();

    expect(providerOperations.rollback).toHaveBeenCalledOnce();
    expect(events).toEqual(["rollback:runtime-new-staged-exact"]);
  });

  it("rejects a cross-platform handoff before provider mutation", async () => {
    const oldEntry = previousEntry("openclaw", "mxc");
    const wrongPlatformHandoff = handoff("openclaw", "mxc");
    const replacementContract = {
      ...wrongPlatformHandoff.replacement.source.contract,
      platform: "linux/arm64" as const,
    };
    const operations = operationsHarness("mxc", []);

    await expect(
      runManagedWorkloadRebuildTransaction(
        {
          previousEntry: oldEntry,
          provider: bundle("mxc"),
          handoff: {
            ...wrongPlatformHandoff,
            replacement: {
              ...wrongPlatformHandoff.replacement,
              source: {
                ...wrongPlatformHandoff.replacement.source,
                contract: replacementContract,
              },
            },
          },
          operations,
          transactionId: "transaction-1",
        },
        { getSandbox: () => structuredClone(oldEntry) },
      ),
    ).rejects.toMatchObject({ phase: "prepare" });
    expect(operations.prepare).not.toHaveBeenCalled();
  });

  it("rejects stale previous contract authority before provider mutation", async () => {
    const oldEntry = previousEntry("openclaw", "mxc");
    const staleHandoff = handoff("openclaw", "mxc");
    const operations = operationsHarness("mxc", []);

    await expect(
      runManagedWorkloadRebuildTransaction(
        {
          previousEntry: oldEntry,
          provider: bundle("mxc"),
          handoff: {
            ...staleHandoff,
            previousContract: {
              ...staleHandoff.previousContract,
              source: {
                ...staleHandoff.previousContract.source,
                release: "v0.0.98",
              },
            },
          },
          operations,
          transactionId: "transaction-1",
        },
        { getSandbox: () => structuredClone(oldEntry) },
      ),
    ).rejects.toMatchObject({ phase: "prepare" });
    expect(operations.prepare).not.toHaveBeenCalled();
  });

  it("rejects a cross-agent replacement contract and profile before provider mutation", async () => {
    const oldEntry = previousEntry("openclaw", "mxc");
    const openClawHandoff = handoff("openclaw", "mxc");
    const hermesHandoff = handoff("hermes", "mxc");
    const operations = operationsHarness("mxc", []);

    await expect(
      runManagedWorkloadRebuildTransaction(
        {
          previousEntry: oldEntry,
          provider: bundle("mxc"),
          handoff: {
            ...openClawHandoff,
            replacement: hermesHandoff.replacement,
            replacementProfile: hermesHandoff.replacementProfile,
          },
          operations,
          transactionId: "transaction-1",
        },
        { getSandbox: () => structuredClone(oldEntry) },
      ),
    ).rejects.toMatchObject({ phase: "prepare" });
    expect(operations.prepare).not.toHaveBeenCalled();
  });

  it("deeply freezes provider-visible rebuild authority", async () => {
    const oldEntry = previousEntry("openclaw", "mxc");
    const operations = operationsHarness("mxc", []);
    const prepare = operations.prepare;
    operations.prepare = vi.fn(async (plan) => {
      expect(Object.isFrozen(plan)).toBe(true);
      expect(Object.isFrozen(plan.previousAuthority.workload)).toBe(true);
      expect(Object.isFrozen(plan.handoff.previousProfile.proxy)).toBe(true);
      expect(Object.isFrozen(plan.handoff.replacement.source.contract.source)).toBe(true);
      expect(Object.isFrozen(plan.replacementReceipt)).toBe(true);
      expect(
        Reflect.set(plan.handoff.replacement.source.contract.source, "release", "v999.0.0"),
      ).toBe(false);
      expect(Reflect.set(plan.previousAuthority.workload, "reference", "mutated")).toBe(false);
      return prepare(plan);
    });

    const result = await runManagedWorkloadRebuildTransaction(
      {
        previousEntry: oldEntry,
        provider: bundle("mxc"),
        handoff: handoff("openclaw", "mxc"),
        operations,
        transactionId: "transaction-1",
      },
      {
        getSandbox: () => structuredClone(oldEntry),
        commitAuthority: (_expected, replacement) => ({
          status: "committed",
          entry: structuredClone(replacement),
        }),
      },
    );

    expect(result.status).toBe("committed");
  });

  it("rejects a provider adapter that is not bound to the selected bundle", async () => {
    const oldEntry = previousEntry("openclaw", "mxc");
    const operations = operationsHarness("other-provider", []);

    await expect(
      runManagedWorkloadRebuildTransaction(
        {
          previousEntry: oldEntry,
          provider: bundle("mxc"),
          handoff: handoff("openclaw", "mxc"),
          operations,
          transactionId: "transaction-1",
        },
        { getSandbox: () => structuredClone(oldEntry) },
      ),
    ).rejects.toMatchObject({ phase: "prepare" });
    expect(operations.prepare).not.toHaveBeenCalled();
    expect(operations.abortPreparation).not.toHaveBeenCalled();
    expect(operations.create).not.toHaveBeenCalled();
  });
});
