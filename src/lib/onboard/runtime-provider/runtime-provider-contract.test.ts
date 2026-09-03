// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  createInMemoryRuntimeProviderBundle,
  type InMemoryRuntimeProviderBundle,
} from "../../../../test/helpers/runtime-provider-bundle";
import { requireInferenceSetRuntimeAuthority } from "../../actions/inference-set-provider";
import { removeSandboxImage } from "../../actions/sandbox/destroy";
import { executeSandboxDestroy } from "../../actions/sandbox/destroy-execution";
import { SANDBOX_DESTROY_TIMEOUT_MS } from "../../actions/sandbox/destroy-gateway";
import { startSandbox } from "../../actions/sandbox/start";
import { stopSandbox } from "../../actions/sandbox/stop";
import { loadAgent } from "../../agent/defs";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import { createDockerManagedBootstrapSurface } from "../managed-bootstrap/docker-runtime";
import { MANAGED_IMAGE_REPOSITORIES } from "../managed-image/contract";
import {
  encodeManagedStartupProfile,
  type ManagedStartupProfile,
} from "../managed-startup/profile";
import { registerCreatedSandbox } from "../sandbox-registration";
import type {
  RuntimeProviderBundle,
  RuntimeProviderManagedImageBootstrapSurface,
  RuntimeProviderWorkloadProfile,
} from "./contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./current";
import { createDockerRuntimeProviderBundle } from "./docker";
import type { HostLocalInferenceOperation } from "./host-local-inference";
import {
  createRuntimeProviderBundleRegistry,
  normalizeRuntimeProviderManagedProfileRestoreAuthority,
  normalizeRuntimeProviderRuntimeReceipt,
  normalizeRuntimeProviderSnapshotPreflightReceipt,
  normalizeRuntimeProviderSnapshotRestoreReceipt,
  normalizeRuntimeProviderSnapshotRestoreSource,
  RuntimeProviderRegistrationError,
  RuntimeProviderSelectionError,
  requireRuntimeProviderHostLocalInferenceOperation,
  requireRuntimeProviderReadOnlyHostMounts,
  resolveRuntimeProviderBundle,
} from "./registry";

const PORTABLE_PROFILE = {
  support: {
    exactDigestReferences: true,
    platforms: ["linux/amd64", "linux/arm64"],
    startupProfileContractVersions: [1],
    capabilityContractVersions: [1],
  },
  hostArchitectures: ["amd64", "arm64"],
  managedImageSelectionPolicy: "require-managed",
  legacyDockerfileBuilds: true,
} as const satisfies RuntimeProviderWorkloadProfile;

const ENCODED_PROFILE = encodeManagedStartupProfile(managedStartupE2eProfile("openclaw"));
const PROFILE_SHA256 = createHash("sha256").update(ENCODED_PROFILE, "utf8").digest("hex");
const MANAGED_RECEIPT = {
  schemaVersion: 1,
  kind: "managed-image",
  reference: `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`,
  platform: "linux/arm64",
  release: "v0.0.97",
  sourceRevision: "b".repeat(40),
  sourceCohort: "ghrun-123456-1",
  capabilityContractVersion: 1,
  startupProfileContractVersion: 1,
  encodedProfile: ENCODED_PROFILE,
  startupProfileSha256: PROFILE_SHA256,
  credentialProxyReplayRequired: false,
  shared: true,
} as const satisfies SandboxWorkloadReceipt;

type ManagedWorkloadReceipt = Extract<SandboxWorkloadReceipt, { readonly kind: "managed-image" }>;

function receiptForProfile(
  profile: ManagedStartupProfile,
  corporateCaB64?: string,
): ManagedWorkloadReceipt {
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    ...MANAGED_RECEIPT,
    reference: `${MANAGED_IMAGE_REPOSITORIES[profile.agent]}@sha256:${"a".repeat(64)}`,
    encodedProfile,
    startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
    ...(corporateCaB64 === undefined ? {} : { corporateCaB64 }),
  };
}

function mxcBundle(): InMemoryRuntimeProviderBundle {
  return createInMemoryRuntimeProviderBundle({
    providerId: "mxc",
    workloadProfile: PORTABLE_PROFILE,
  });
}

function replaceSurface(
  bundle: RuntimeProviderBundle,
  surface: keyof RuntimeProviderBundle,
  value: unknown,
): RuntimeProviderBundle {
  return { ...bundle, [surface]: value } as RuntimeProviderBundle;
}

function expectSupportedSurface<T extends { readonly supported: boolean }>(
  surface: T,
): asserts surface is Extract<T, { readonly supported: true }> {
  expect(surface.supported).toBe(true);
}

describe("RuntimeProviderBundle registry contract", () => {
  it("registers every production-selectable provider as one complete bundle", () => {
    expect(Object.keys(CURRENT_RUNTIME_PROVIDER_BUNDLES)).toEqual([
      "docker",
      "kubernetes",
      "podman",
    ]);
    Object.entries(CURRENT_RUNTIME_PROVIDER_BUNDLES).forEach(([providerId, bundle]) => {
      expect(bundle.identity.id).toBe(providerId);
      expect(
        (
          [
            "plan",
            "capabilities",
            "preflightDoctor",
            "gateway",
            "workload",
            "hostLocalInference",
            "lifecycle",
            "mutationAuthority",
            "bootstrap",
            "snapshot",
            "recovery",
            "cleanup",
            "containerEngine",
          ] as const
        ).every((surface) => Object.is(bundle[surface].providerId, providerId)),
      ).toBe(true);
      const managedLocalProvider = providerId === "docker" || providerId === "podman";
      expect(bundle.bootstrap).toMatchObject({ supported: managedLocalProvider });
      expect(bundle.snapshot).toMatchObject(
        managedLocalProvider
          ? {
              supported: true,
              capabilities: {
                backup: true,
                restore: true,
                managedProfileRestore: true,
              },
            }
          : { supported: false },
      );
      expect(bundle.recovery).toMatchObject({ supported: providerId === "podman" });
    });
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES.docker?.capabilities.hostLocalInference).toBe(true);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES.docker?.hostLocalInference).toMatchObject({
      supported: true,
      services: ["llama-cpp"],
    });
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES.kubernetes?.capabilities.hostLocalInference).toBe(
      false,
    );
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES.kubernetes?.hostLocalInference).toMatchObject({
      supported: false,
    });
  });

  it("declares and enforces read-only host-mount support per runtime provider", () => {
    const docker = CURRENT_RUNTIME_PROVIDER_BUNDLES.docker!;
    const kubernetes = CURRENT_RUNTIME_PROVIDER_BUNDLES.kubernetes!;

    expect(docker.capabilities.readOnlyHostMounts).toEqual({
      supported: true,
      hostPlatforms: ["linux"],
    });
    expect(kubernetes.capabilities.readOnlyHostMounts).toMatchObject({
      supported: false,
      reason: expect.stringMatching(/Kubernetes hostPath semantics/u),
    });
    expect(requireRuntimeProviderReadOnlyHostMounts(docker, "linux")).toBe(
      docker.capabilities.readOnlyHostMounts,
    );
    expect(() => requireRuntimeProviderReadOnlyHostMounts(docker, "darwin")).toThrow(
      /provider 'docker'.*not qualified.*'darwin'/u,
    );
    expect(() => requireRuntimeProviderReadOnlyHostMounts(kubernetes, "linux")).toThrow(
      /provider 'kubernetes'.*Kubernetes hostPath semantics/u,
    );
  });

  it("registers the production Docker bootstrap surface through the same bundle registry", () => {
    const docker = createDockerRuntimeProviderBundle();
    const providers = createRuntimeProviderBundleRegistry([
      [
        "docker",
        {
          ...docker,
          bootstrap: createDockerManagedBootstrapSurface(),
        },
      ],
    ]);

    expect(providers.docker?.bootstrap).toMatchObject({
      providerId: "docker",
      supported: true,
    });
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES.docker?.bootstrap).toMatchObject({
      providerId: "docker",
      supported: true,
    });
  });

  it("deeply clones and freezes every registered nested value", () => {
    const source = mxcBundle();
    const registry = createRuntimeProviderBundleRegistry([["mxc", source]]);
    const registered = registry.mxc!;

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.workload.profile)).toBe(true);
    const support = registered.workload.profile.support;
    expect(support).not.toBeNull();
    expect(Object.isFrozen(support!.platforms)).toBe(true);
    expectSupportedSurface(registered.lifecycle);
    expect(Object.isFrozen(registered.lifecycle.start)).toBe(true);
    expect(Object.isFrozen(registered.lifecycle.verifyStarted)).toBe(true);
    expect(registered).not.toBe(source);
    expect(registered.lifecycle.start).not.toBe(source.lifecycle.start);
    expect(registered.lifecycle.verifyStarted).not.toBe(source.lifecycle.verifyStarted);
    expect(() => {
      (registered.workload.profile.hostArchitectures as string[]).push("s390x");
    }).toThrow(TypeError);
    expect(() => {
      (registered.capabilities as { directLifecycle: boolean }).directLifecycle = false;
    }).toThrow(TypeError);
  });

  it("registers an MXC-style managed-bootstrap provider through the bundle surface", () => {
    const bundle = mxcBundle();
    const createLifecycle = vi.fn(() => ({
      launchArgv: ["mxc", "create"],
      patch: {
        maybeApplyDuringCreate: vi.fn(),
        createFailureMessage: vi.fn(() => null),
        exitOnPatchError: vi.fn(),
        rollbackManagedStartupAfterCreateFailure: vi.fn(),
        ensureApplied: vi.fn(),
        waitForSupervisorReconnectIfNeeded: vi.fn(),
        commitAfterReady: vi.fn(),
        selectedMode: vi.fn(() => null),
        printReadinessFailureIfEnabled: vi.fn(),
        verifyGpuOrExit: vi.fn(async (verify) => verify("alpha")),
      },
      recoverUnfinished: vi.fn(async () => ({ receipts: [], failures: [] })),
      prepareNetwork: vi.fn(async () => undefined),
      runCreate: vi.fn(),
    }));
    const createOnboardRouting = vi.fn(() => ({
      nativeFallbackHasCleanBaseline: false,
      inspectNativeRuntime: vi.fn(() => null),
      isNativeCreateRoutingFailure: vi.fn(() => false),
      isTrustedNativeRuntimeError: vi.fn(() => false),
      isNativeReadinessRoutingFailure: vi.fn(() => false),
      prepareCompatibilityLaunch: vi.fn(() => ({ createArgv: [], registryImageRef: null })),
    }));
    const createAuthorityStore = vi.fn(() => ({
      recordPreparedAuthority: vi.fn(),
    }));
    const providers = createRuntimeProviderBundleRegistry([
      [
        "mxc",
        replaceSurface(bundle, "bootstrap", {
          providerId: "mxc",
          supported: true,
          bootstrapKind: "managed-image",
          createAuthorityStore,
          createLifecycle,
          createOnboardRouting,
        }),
      ],
    ]);
    const registered = providers.mxc!;
    expectSupportedSurface(registered.bootstrap);
    expect(registered.bootstrap.bootstrapKind).toBe("managed-image");
    const managedBootstrap = registered.bootstrap as RuntimeProviderManagedImageBootstrapSurface;

    const routing = managedBootstrap.createOnboardRouting({
      sandboxName: "alpha",
      openshellArgv: (args) => args,
      nativeFallbackEnabled: false,
    });

    expect(registered.identity.id).toBe("mxc");
    expect(routing.nativeFallbackHasCleanBaseline).toBe(false);
    expect(createOnboardRouting).toHaveBeenCalledOnce();
    expect(createAuthorityStore).not.toHaveBeenCalled();
    expect(createLifecycle).not.toHaveBeenCalled();
  });

  it("rejects an omitted managed platform without changing legacy receipt acceptance", () => {
    const { platform: _omittedPlatform, ...managedWithoutPlatform } = MANAGED_RECEIPT;
    const persistedManaged = cloneSandboxWorkloadReceipt(managedWithoutPlatform);
    const legacy = {
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "owned:tag",
      shared: false,
    } as const satisfies SandboxWorkloadReceipt;
    const docker = CURRENT_RUNTIME_PROVIDER_BUNDLES.docker!;
    const inMemory = mxcBundle();

    expect(persistedManaged).toEqual(managedWithoutPlatform);
    expect(docker.workload.acceptsReceipt(persistedManaged)).toBe(false);
    expect(inMemory.workload.acceptsReceipt(persistedManaged)).toBe(false);
    expect(docker.workload.acceptsReceipt(legacy)).toBe(true);
    expect(inMemory.workload.acceptsReceipt(legacy)).toBe(true);
  });

  it("rejects duplicates, key/identity mismatch, inherited keys, and unknown durable identity", () => {
    const bundle = mxcBundle();
    expect(() =>
      createRuntimeProviderBundleRegistry([
        ["mxc", bundle],
        ["mxc", bundle],
      ]),
    ).toThrow(/duplicate provider identity/u);
    expect(() => createRuntimeProviderBundleRegistry([["other", bundle]])).toThrow(
      /does not match/u,
    );
    expect(() => createRuntimeProviderBundleRegistry([["constructor", bundle]])).toThrow(
      /unsupported provider key/u,
    );
    const registry = createRuntimeProviderBundleRegistry([["mxc", bundle]]);
    expect(resolveRuntimeProviderBundle("toString", registry)).toBeNull();
    expect(resolveRuntimeProviderBundle("future-runtime", registry)).toBeNull();
  });

  it.each([
    "plan",
    "capabilities",
    "preflightDoctor",
    "gateway",
    "workload",
    "hostLocalInference",
    "lifecycle",
    "mutationAuthority",
    "bootstrap",
    "snapshot",
    "recovery",
    "cleanup",
    "containerEngine",
  ] as const)("rejects a missing surface and every surface identity mismatch [%s]", (surface) => {
    const bundle = mxcBundle();
    const { cleanup: _cleanup, ...missingCleanup } = bundle;
    expect(() =>
      createRuntimeProviderBundleRegistry([["mxc", missingCleanup as RuntimeProviderBundle]]),
    ).toThrow(/missing cleanup surface/u);

    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "mxc",
          replaceSurface(bundle, surface, {
            ...bundle[surface],
            providerId: "other",
          }),
        ],
      ]),
    ).toThrow(new RegExp(`${surface} identity`, "u"));
  });

  it.each([
    [
      "plan",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.plan,
        gatewayLauncher: "invalid",
      }),
    ],
    [
      "capabilities",
      (bundle: RuntimeProviderBundle) => {
        const { directLifecycle: _directLifecycle, ...incomplete } = bundle.capabilities;
        return incomplete;
      },
    ],
    [
      "preflightDoctor",
      (bundle: RuntimeProviderBundle) => {
        const { inspectHost: _inspectHost, ...incomplete } = bundle.preflightDoctor;
        return incomplete;
      },
    ],
    [
      "gateway",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.gateway,
        launcher: "invalid",
      }),
    ],
    [
      "workload",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.workload,
        profile: { ...bundle.workload.profile, hostArchitectures: ["amd64", "amd64"] },
      }),
    ],
    [
      "hostLocalInference",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.hostLocalInference,
        supported: true,
        reason: undefined,
      }),
    ],
    [
      "lifecycle",
      (_bundle: RuntimeProviderBundle) => {
        const { stop: _stop, ...incomplete } = mxcBundle().lifecycle;
        return incomplete;
      },
    ],
    [
      "mutationAuthority",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.mutationAuthority,
        operations: ["not-an-operation"],
      }),
    ],
    [
      "bootstrap",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.bootstrap,
        supported: true,
        reason: undefined,
      }),
    ],
    [
      "snapshot",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.snapshot,
        supported: true,
        capture: () => undefined,
      }),
    ],
    [
      "recovery",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.recovery,
        supported: true,
      }),
    ],
    [
      "cleanup",
      (_bundle: RuntimeProviderBundle) => {
        const { removeOwnedWorkload: _removeOwnedWorkload, ...incomplete } = mxcBundle().cleanup;
        return incomplete;
      },
    ],
    [
      "containerEngine",
      (bundle: RuntimeProviderBundle) => ({
        ...bundle.containerEngine,
        identities: [
          {
            operation: "invalid-operation",
            engineId: "",
            displayName: "Broken",
          },
        ],
      }),
    ],
  ] as const)(
    "rejects a runtime-cast incomplete or invalid supported %s surface",
    (surface, mutate) => {
      const bundle = mxcBundle();
      expect(() =>
        createRuntimeProviderBundleRegistry([
          ["mxc", replaceSurface(bundle, surface, mutate(bundle))],
        ]),
      ).toThrow(RuntimeProviderRegistrationError);
    },
  );

  it.each([
    [undefined, /missing readOnlyHostMounts surface/u],
    [{ supported: false, reason: "" }, /reason must be a non-empty string/u],
    [{ supported: true, hostPlatforms: [] }, /hostPlatforms must list unique/u],
    [{ supported: true, hostPlatforms: ["linux", "linux"] }, /hostPlatforms must list unique/u],
    [{ supported: true, hostPlatforms: ["plan9"] }, /hostPlatforms must list unique/u],
  ])("rejects an invalid read-only host-mount capability %#", (readOnlyHostMounts, message) => {
    const bundle = mxcBundle();
    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "mxc",
          replaceSurface(bundle, "capabilities", {
            ...bundle.capabilities,
            readOnlyHostMounts,
          }),
        ],
      ]),
    ).toThrow(message);
  });

  it("rejects a lifecycle surface without provider-owned post-start verification", () => {
    const bundle = mxcBundle();
    expectSupportedSurface(bundle.lifecycle);
    const { verifyStarted: _verifyStarted, ...incomplete } = bundle.lifecycle;

    expect(() =>
      createRuntimeProviderBundleRegistry([
        ["mxc", replaceSurface(bundle, "lifecycle", incomplete)],
      ]),
    ).toThrow(/lifecycle\.verifyStarted must be a function/u);
  });

  it("rejects an invalid provider-owned container mutation timeout", () => {
    const bundle = mxcBundle();
    expectSupportedSurface(bundle.lifecycle);

    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "mxc",
          replaceSurface(bundle, "lifecycle", {
            ...bundle.lifecycle,
            containerMutationTimeoutMs: 0,
          }),
        ],
      ]),
    ).toThrow(/invalid container mutation timeout/u);
  });

  it("rejects cleanup without a side-effect-free ownership plan", () => {
    const bundle = mxcBundle();
    expectSupportedSurface(bundle.cleanup);
    const { planOwnedWorkloadCleanup: _planOwnedWorkloadCleanup, ...incomplete } = bundle.cleanup;

    expect(() =>
      createRuntimeProviderBundleRegistry([["mxc", replaceSurface(bundle, "cleanup", incomplete)]]),
    ).toThrow(/cleanup\.planOwnedWorkloadCleanup must be a function/u);
  });

  it("plans owned workload cleanup without mutating the runtime", () => {
    const runtimeState = { imageRemovals: 0 };
    const docker = createDockerRuntimeProviderBundle({
      removeImage: vi.fn(() => {
        runtimeState.imageRemovals += 1;
        return { status: 0 };
      }),
    });
    expectSupportedSurface(docker.cleanup);
    const sandbox = {
      name: "alpha",
      imageTag: "nemoclaw-alpha:current",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "nemoclaw-alpha:recorded",
        shared: false,
      },
    } as SandboxEntry;
    const sandboxBefore = structuredClone(sandbox);
    const runtimeStateBefore = structuredClone(runtimeState);

    expect(docker.cleanup.planOwnedWorkloadCleanup({ sandbox, sandboxName: sandbox.name })).toEqual(
      { action: "block", reason: "authority-unproven" },
    );
    expect(sandbox).toEqual(sandboxBefore);
    expect(runtimeState).toEqual(runtimeStateBefore);
  });

  it("rejects capability/surface drift and duplicate operation-scoped engine identities", () => {
    const bundle = mxcBundle();
    const { capture: _capture, ...containerEngineWithoutCapture } = bundle.containerEngine;
    expect(() =>
      createRuntimeProviderBundleRegistry([
        ["mxc", replaceSurface(bundle, "containerEngine", containerEngineWithoutCapture)],
      ]),
    ).toThrow(/containerEngine.*capture/u);
    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "mxc",
          replaceSurface(bundle, "capabilities", {
            ...bundle.capabilities,
            directLifecycle: false,
          }),
        ],
      ]),
    ).toThrow(/capabilities disagree/u);
    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "mxc",
          replaceSurface(bundle, "capabilities", {
            ...bundle.capabilities,
            hostLocalInference: true,
          }),
        ],
      ]),
    ).toThrow(/capabilities disagree/u);
    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "mxc",
          replaceSurface(bundle, "containerEngine", {
            ...bundle.containerEngine,
            identities: [
              ...bundle.containerEngine.identities,
              bundle.containerEngine.identities[0],
            ],
          }),
        ],
      ]),
    ).toThrow(/duplicate operation identities/u);
  });

  it("requires an explicit boolean gateway readiness owner", () => {
    const bundle = mxcBundle();
    const { ownsHostReadiness: _ownsHostReadiness, ...gatewayWithoutReadinessOwner } =
      bundle.gateway;

    expect(() =>
      createRuntimeProviderBundleRegistry([
        ["mxc", replaceSurface(bundle, "gateway", gatewayWithoutReadinessOwner)],
      ]),
    ).toThrow(/gateway\.ownsHostReadiness must be a boolean/u);
    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "mxc",
          replaceSurface(bundle, "gateway", {
            ...bundle.gateway,
            ownsHostReadiness: "true",
          }),
        ],
      ]),
    ).toThrow(/gateway\.ownsHostReadiness must be a boolean/u);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES.docker?.gateway.ownsHostReadiness).toBe(false);
    expect(CURRENT_RUNTIME_PROVIDER_BUNDLES.podman?.gateway.ownsHostReadiness).toBe(true);
  });

  it("rejects an unsupported host-local-inference capability with an actionable provider error", () => {
    const bundle = mxcBundle();

    expect(() =>
      requireRuntimeProviderHostLocalInferenceOperation(bundle, "llama-cpp", { env: {} }),
    ).toThrow(
      new RuntimeProviderSelectionError(
        "Runtime provider 'mxc' does not provide the host-local-inference capability required for llama-cpp: Unsupported by this in-memory contract fixture.",
      ),
    );
  });

  it("keeps host-local-inference runtime selection scoped to each operation", () => {
    const operation = (providerId: string, authorityId: string): HostLocalInferenceOperation => ({
      providerId,
      bindingSha256: authorityId.padEnd(64, "0").slice(0, 64),
      assertAuthority: vi.fn(),
      spawn: vi.fn(() => ({}) as never),
      createLlamaCppLifecycle: vi.fn(() => {
        throw new Error("lifecycle construction is outside this contract test");
      }),
      engine: {
        operation: "host-local-inference",
        engineId: "memory",
        displayName: "In-memory",
        authorityId,
        capture: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
        captureHost: vi.fn(() => ({ status: 0, stdout: "", stderr: "" })),
      },
    });
    const firstFactory = vi.fn(() => operation("first", "first-authority"));
    const secondFactory = vi.fn(() => operation("second", "second-authority"));
    const first = createInMemoryRuntimeProviderBundle({
      providerId: "first",
      workloadProfile: PORTABLE_PROFILE,
      hostLocalInference: { services: ["llama-cpp"], createOperation: firstFactory },
    });
    const second = createInMemoryRuntimeProviderBundle({
      providerId: "second",
      workloadProfile: PORTABLE_PROFILE,
      hostLocalInference: { services: ["llama-cpp"], createOperation: secondFactory },
    });

    expect(
      requireRuntimeProviderHostLocalInferenceOperation(first, "llama-cpp", { env: {} }).engine
        .authorityId,
    ).toBe("first-authority");
    expect(
      requireRuntimeProviderHostLocalInferenceOperation(second, "llama-cpp", { env: {} }).engine
        .authorityId,
    ).toBe("second-authority");
    expect(firstFactory).toHaveBeenCalledOnce();
    expect(secondFactory).toHaveBeenCalledOnce();
  });

  it("versions supported snapshot facets and enforces managed-profile capability dependencies", () => {
    const docker = CURRENT_RUNTIME_PROVIDER_BUNDLES.docker!;
    const snapshot = docker.snapshot;
    expectSupportedSurface(snapshot);
    expect(snapshot.contractVersion).toBe(1);

    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "docker",
          replaceSurface(docker, "snapshot", {
            ...snapshot,
            contractVersion: 2,
          }),
        ],
      ]),
    ).toThrow(/unsupported contract version/u);
    expect(() =>
      createRuntimeProviderBundleRegistry([
        [
          "docker",
          replaceSurface(docker, "snapshot", {
            ...snapshot,
            capabilities: {
              ...snapshot.capabilities,
              restore: false,
              managedProfileRestore: true,
            },
          }),
        ],
      ]),
    ).toThrow(/cannot restore managed profiles/u);
  });

  it("normalizes bounded opaque runtime receipts and rejects duplicate GPU devices", () => {
    const receipt = {
      schemaVersion: 1,
      providerId: "mxc",
      runtime: { kind: "sandbox", handle: "opaque-123" },
      acceleration: { kind: "gpu", vendor: "test", devices: ["gpu0", "gpu1"] },
    };
    expect(normalizeRuntimeProviderRuntimeReceipt(receipt)).toEqual(receipt);
    expect(
      normalizeRuntimeProviderRuntimeReceipt({
        ...receipt,
        acceleration: { ...receipt.acceleration, devices: ["gpu0", "gpu0"] },
      }),
    ).toBeNull();
    expect(
      normalizeRuntimeProviderRuntimeReceipt({
        ...receipt,
        runtime: { ...receipt.runtime, handle: "x".repeat(4097) },
      }),
    ).toBeNull();
    expect(
      normalizeRuntimeProviderRuntimeReceipt({
        ...receipt,
        runtime: { ...receipt.runtime, handle: "opaque\ninjection" },
      }),
    ).toBeNull();
  });

  it("normalizes snapshot preflight and managed restore proof as one bounded contract", () => {
    const managedProfile = {
      agent: "openclaw",
      profileFingerprint: "f".repeat(64),
    };
    const preflight = {
      schemaVersion: 1,
      providerId: "docker",
      operation: "restore",
      sandboxName: "alpha",
      providerHandle: "opaque-preflight",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
    };
    const runtime = {
      schemaVersion: 1,
      providerId: "docker",
      runtime: { kind: "docker-container", handle: "c".repeat(64) },
      acceleration: { kind: "none" },
    };
    const source = {
      schemaVersion: 1,
      providerId: "docker",
      providerHandle: "opaque-source",
      lifecycleState: "running",
      lifecycleGeneration: "source-generation-1",
      runtime,
    };
    const restore = {
      schemaVersion: 1,
      providerId: "docker",
      sandboxName: "alpha",
      providerHandle: "opaque-restore-proof",
      lifecycleState: "running",
      lifecycleGeneration: "generation-1",
      runtime,
      managedProfile,
    };

    expect(normalizeRuntimeProviderManagedProfileRestoreAuthority(managedProfile)).toEqual(
      managedProfile,
    );
    expect(normalizeRuntimeProviderSnapshotPreflightReceipt(preflight)).toEqual(preflight);
    expect(normalizeRuntimeProviderSnapshotRestoreSource(source)).toEqual(source);
    expect(normalizeRuntimeProviderSnapshotRestoreReceipt(restore)).toEqual(restore);
    expect(
      normalizeRuntimeProviderSnapshotPreflightReceipt({
        ...preflight,
        lifecycleGeneration: "generation\ninjection",
      }),
    ).toBeNull();
    expect(
      normalizeRuntimeProviderSnapshotPreflightReceipt({
        ...preflight,
        operation: { toString: () => "restore" },
      }),
    ).toBeNull();
    expect(
      normalizeRuntimeProviderSnapshotRestoreReceipt({
        ...restore,
        runtime: { ...runtime, providerId: "other" },
      }),
    ).toBeNull();
  });
});

describe("sandbox workload ownership receipt", () => {
  it("clones the complete immutable managed-image ownership identity", () => {
    const cloned = cloneSandboxWorkloadReceipt(MANAGED_RECEIPT);

    expect(cloned).toEqual(MANAGED_RECEIPT);
    expect(cloned).not.toBe(MANAGED_RECEIPT);
  });

  it.each([
    { sourceCohort: "run-123456" },
    { reference: "ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest" },
    { platform: "linux/s390x" },
    { release: "latest" },
    { capabilityContractVersion: 2 },
    { startupProfileContractVersion: 2 },
    { startupProfileSha256: "not-a-digest" },
    { encodedProfile: `${ENCODED_PROFILE}=` },
    { encodedProfile: Buffer.from("different", "utf8").toString("base64url") },
    { corporateCaB64: "not canonical base64" },
    { shared: false },
  ])("drops malformed managed ownership evidence: %o", (drift) => {
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        ...drift,
      } as unknown as SandboxWorkloadReceipt),
    ).toBeUndefined();
  });

  it("rejects a canonical transport containing credential-shaped profile data", () => {
    const profile = managedStartupE2eProfile("openclaw");
    const canonicalProfile = Buffer.from(ENCODED_PROFILE, "base64url").toString("utf8");
    const encodedProfile = Buffer.from(
      canonicalProfile.replace(
        `"model":${JSON.stringify(profile.inference.model)}`,
        `"model":"nvapi-${"a".repeat(32)}"`,
      ),
      "utf8",
    ).toString("base64url");

    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        encodedProfile,
        startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      }),
    ).toBeUndefined();
  });

  it("binds the decoded startup-profile agent to the immutable image repository", () => {
    const hermesReceipt = receiptForProfile(managedStartupE2eProfile("hermes"));

    expect(
      cloneSandboxWorkloadReceipt({
        ...hermesReceipt,
        reference: MANAGED_RECEIPT.reference,
      }),
    ).toBeUndefined();
  });

  it("binds corporate CA presence and exact bytes to the decoded profile digest", () => {
    const corporateCaB64 = Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM, "utf8").toString(
      "base64",
    );
    const receipt = receiptForProfile(
      managedStartupE2eProfile("openclaw", false, true),
      corporateCaB64,
    );

    expect(cloneSandboxWorkloadReceipt(receipt)).toEqual(receipt);
    expect(
      cloneSandboxWorkloadReceipt({
        ...receipt,
        corporateCaB64: Buffer.from("different-ca", "utf8").toString("base64"),
      }),
    ).toBeUndefined();
    const { corporateCaB64: _omittedCa, ...missingCa } = receipt;
    expect(cloneSandboxWorkloadReceipt(missingCa)).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        ...MANAGED_RECEIPT,
        corporateCaB64,
      }),
    ).toBeUndefined();
  });

  it("retains an owned legacy image receipt independently from managed cohorts", () => {
    expect(
      cloneSandboxWorkloadReceipt({
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "nemoclaw-sandbox-local:build-123",
        shared: false,
      }),
    ).toEqual({
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "nemoclaw-sandbox-local:build-123",
      shared: false,
    });
  });

  it("rejects an empty or falsely shared legacy ownership receipt", () => {
    expect(
      cloneSandboxWorkloadReceipt({
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "",
        shared: false,
      }),
    ).toBeUndefined();
    expect(
      cloneSandboxWorkloadReceipt({
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "owned:tag",
        shared: true,
      } as unknown as SandboxWorkloadReceipt),
    ).toBeUndefined();
  });
});

describe("socket-free MXC action contract", () => {
  const agents = ["openclaw", "hermes", "langchain-deepagents-code"] as const;
  let testHome: string;

  beforeEach(() => {
    testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-provider-contract-"));
    vi.stubEnv("HOME", testHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(testHome, { recursive: true, force: true });
  });

  it.each(agents)(
    "routes %s registration, lifecycle, inference authority, destroy, and cleanup through one injected bundle",
    async (agent) => {
      const state = {
        events: [] as string[],
        running: new Set<string>(),
        workloads: new Set<string>(),
      };
      const recordEvent = vi.fn((value: string) => state.events.push(value));
      const bundle = createInMemoryRuntimeProviderBundle({
        providerId: "mxc",
        workloadProfile: PORTABLE_PROFILE,
        state,
        recordEvent,
      });
      const providers = createRuntimeProviderBundleRegistry([["mxc", bundle]]);
      const sandboxName =
        agent === "langchain-deepagents-code" ? "dcode-sandbox" : `${agent}-sandbox`;
      const imageTag = `mxc-memory:${agent}`;
      const registerSandbox = vi.fn();
      const entry = registerCreatedSandbox({
        sandboxName,
        inferenceSelection: {
          model: "test/model",
          provider: "nvidia-prod",
          endpointUrl: null,
          endpointSource: null,
          credentialEnv: null,
          preferredInferenceApi: null,
          compatibleEndpointReasoning: null,
          compatibleEndpointReasoningEffort: null,
          nimContainer: null,
        },
        runtimeFields: {
          gpuEnabled: false,
          hostGpuDetected: false,
          sandboxGpuEnabled: false,
          sandboxGpuMode: "auto",
          sandboxGpuDevice: null,
          openshellDriver: "mxc",
          openshellVersion: "test",
        },
        agent: loadAgent(agent),
        agentVersionKnown: false,
        imageTag,
        workload: {
          schemaVersion: 1,
          kind: "legacy-dockerfile",
          reference: imageTag,
          shared: false,
        },
        plannedMessagingState: undefined,
        hermesToolGateways: [],
        hermesDashboardState: { enabled: false, config: null },
        dashboardPort: 18789,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        registerSandbox,
        runtimeProviders: providers,
      });
      state.workloads.add(imageTag);
      const getSandbox = vi.fn(() => entry);
      const stopSandboxChannels = vi.fn();
      const teardownSandboxDashboardForward = vi.fn();
      const runOpenshell = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));

      await expect(
        startSandbox(sandboxName, {
          getSandbox,
          runtimeProviders: providers,
          log: vi.fn(),
        }),
      ).resolves.toEqual({ exitCode: 0 });
      expect(
        stopSandbox(sandboxName, {
          getSandbox,
          runtimeProviders: providers,
          stopSandboxChannels,
          teardownSandboxDashboardForward,
          log: vi.fn(),
          warn: vi.fn(),
        }),
      ).toEqual({ exitCode: 0 });
      expect(() => requireInferenceSetRuntimeAuthority(entry, providers)).not.toThrow();
      await expect(
        executeSandboxDestroy({
          force: false,
          runOpenshell,
          sandbox: entry,
          sandboxConfirmedAbsent: false,
          sandboxName,
          stopInferenceResources: vi.fn(),
          runtimeProviders: providers,
          deps: {
            wipeSandboxState: vi.fn(),
          },
        }),
      ).resolves.toMatchObject({ ok: true });
      expect(
        removeSandboxImage(sandboxName, {
          getSandbox,
          runtimeProviders: providers,
          log: vi.fn(),
          warn: vi.fn(),
        }),
      ).toEqual({
        status: "removed",
        engineDisplayName: "In-memory",
        reference: imageTag,
      });

      expect(registerSandbox).toHaveBeenCalledWith(entry);
      expect(runOpenshell).toHaveBeenCalledWith(["sandbox", "delete", sandboxName], {
        ignoreError: true,
        killSignal: "SIGKILL",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: SANDBOX_DESTROY_TIMEOUT_MS,
      });
      const prepareDestroyIndex = state.events.indexOf(`prepare-destroy:${sandboxName}`);
      expect(prepareDestroyIndex).toBeGreaterThanOrEqual(0);
      expect(recordEvent.mock.invocationCallOrder[prepareDestroyIndex]).toBeLessThan(
        runOpenshell.mock.invocationCallOrder.at(-1)!,
      );
      expect(stopSandboxChannels).toHaveBeenCalledWith(
        sandboxName,
        expect.objectContaining({
          channelStopTransport: "openshell",
          info: expect.any(Function),
          warn: expect.any(Function),
        }),
      );
      expect(state.events).toEqual([
        `start:${sandboxName}`,
        `verify-started:${sandboxName}`,
        `stop:${sandboxName}`,
        `prepare-destroy:${sandboxName}`,
        `cleanup:${sandboxName}`,
      ]);
      expect(state.running).not.toContain(sandboxName);
      expect(state.workloads).not.toContain(imageTag);
    },
  );

  it("blocks cleanup when an in-memory legacy receipt names a different image", () => {
    const bundle = createInMemoryRuntimeProviderBundle({
      providerId: "mxc",
      workloadProfile: PORTABLE_PROFILE,
    });

    expect(
      bundle.cleanup.planOwnedWorkloadCleanup({
        sandboxName: "alpha",
        sandbox: {
          name: "alpha",
          imageTag: "local/alpha:current",
          workload: {
            schemaVersion: 1,
            kind: "legacy-dockerfile",
            reference: "local/alpha:recorded",
            shared: false,
          },
        },
      }),
    ).toEqual({ action: "block", reason: "authority-unproven" });
  });
});
