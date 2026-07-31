// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { removeSandboxImage } from "../../actions/sandbox/destroy";
import { startSandbox } from "../../actions/sandbox/start";
import { stopSandbox } from "../../actions/sandbox/stop";
import type { SandboxEntry, SandboxWorkloadReceipt } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import {
  createInMemoryRuntimeProviderBundle,
  type InMemoryRuntimeProviderBundle,
} from "../../../../test/helpers/runtime-provider-bundle";
import type { RuntimeProviderBundle, RuntimeProviderWorkloadProfile } from "./contract";
import { CURRENT_RUNTIME_PROVIDER_BUNDLES } from "./current";
import {
  createRuntimeProviderBundleRegistry,
  normalizeRuntimeProviderRuntimeReceipt,
  resolveRuntimeProviderBundle,
  RuntimeProviderRegistrationError,
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

const ENCODED_PROFILE = Buffer.from('{"schemaVersion":1}', "utf8").toString("base64url");
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
  it("keeps the production selectable set limited to complete Docker and Kubernetes bundles", () => {
    expect(Object.keys(CURRENT_RUNTIME_PROVIDER_BUNDLES)).toEqual(["docker", "kubernetes"]);
    for (const [providerId, bundle] of Object.entries(CURRENT_RUNTIME_PROVIDER_BUNDLES)) {
      expect(bundle.identity.id).toBe(providerId);
      expect(
        [
          bundle.plan,
          bundle.capabilities,
          bundle.preflightDoctor,
          bundle.gateway,
          bundle.workload,
          bundle.lifecycle,
          bundle.mutationAuthority,
          bundle.bootstrap,
          bundle.snapshot,
          bundle.recovery,
          bundle.cleanup,
          bundle.containerEngine,
        ].every((surface) => surface.providerId === providerId),
      ).toBe(true);
      expect(bundle.bootstrap).toMatchObject({ supported: false });
      expect(bundle.snapshot).toMatchObject({ supported: false });
      expect(bundle.recovery).toMatchObject({ supported: false });
    }
  });

  it("deeply clones and freezes every registered nested value", () => {
    const source = mxcBundle();
    const registry = createRuntimeProviderBundleRegistry([["mxc", source]]);
    const registered = registry.mxc!;

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered.workload.profile)).toBe(true);
    expect(Object.isFrozen(registered.workload.profile.support?.platforms)).toBe(true);
    expectSupportedSurface(registered.lifecycle);
    expect(Object.isFrozen(registered.lifecycle.start)).toBe(true);
    expect(registered).not.toBe(source);
    expect(registered.lifecycle.start).not.toBe(source.lifecycle.start);
    expect(() => {
      (registered.workload.profile.hostArchitectures as string[]).push("s390x");
    }).toThrow(TypeError);
    expect(() => {
      (registered.capabilities as { directLifecycle: boolean }).directLifecycle = false;
    }).toThrow(TypeError);
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

  it("rejects a missing surface and every surface identity mismatch", () => {
    const bundle = mxcBundle();
    const { cleanup: _cleanup, ...missingCleanup } = bundle;
    expect(() =>
      createRuntimeProviderBundleRegistry([["mxc", missingCleanup as RuntimeProviderBundle]]),
    ).toThrow(/missing cleanup surface/u);

    for (const surface of [
      "plan",
      "capabilities",
      "preflightDoctor",
      "gateway",
      "workload",
      "lifecycle",
      "mutationAuthority",
      "bootstrap",
      "snapshot",
      "recovery",
      "cleanup",
      "containerEngine",
    ] as const) {
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
    }
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
  ] as const)("rejects a runtime-cast incomplete or invalid supported %s surface", (surface, mutate) => {
    const bundle = mxcBundle();
    expect(() =>
      createRuntimeProviderBundleRegistry([
        ["mxc", replaceSurface(bundle, surface, mutate(bundle))],
      ]),
    ).toThrow(RuntimeProviderRegistrationError);
  });

  it("rejects capability/surface drift and duplicate operation-scoped engine identities", () => {
    const bundle = mxcBundle();
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

  it.each(agents)("routes %s lifecycle and cleanup through one injected bundle", async (agent) => {
    const state = {
      events: [] as string[],
      running: new Set<string>(),
      workloads: new Set<string>(),
    };
    const bundle = createInMemoryRuntimeProviderBundle({
      providerId: "mxc",
      workloadProfile: PORTABLE_PROFILE,
      state,
    });
    const providers = createRuntimeProviderBundleRegistry([["mxc", bundle]]);
    const sandboxName = `${agent}-sandbox`;
    const imageTag = `mxc-memory:${agent}`;
    const entry: SandboxEntry = {
      name: sandboxName,
      agent,
      openshellDriver: "mxc",
      imageTag,
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: imageTag,
        shared: false,
      },
    };
    state.workloads.add(imageTag);
    const getSandbox = vi.fn(() => entry);
    const probeSandbox = vi.fn(async () => undefined);
    const stopSandboxChannels = vi.fn();
    const teardownSandboxDashboardForward = vi.fn();

    await expect(
      startSandbox(sandboxName, {
        getSandbox,
        runtimeProviders: providers,
        probeSandbox,
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

    expect(probeSandbox).toHaveBeenCalledWith(sandboxName);
    expect(stopSandboxChannels).toHaveBeenCalledWith(
      sandboxName,
      expect.objectContaining({ info: expect.any(Function), warn: expect.any(Function) }),
    );
    expect(state.events).toEqual([
      `start:${sandboxName}`,
      `stop:${sandboxName}`,
      `cleanup:${sandboxName}`,
    ]);
    expect(state.running).not.toContain(sandboxName);
    expect(state.workloads).not.toContain(imageTag);
  });
});
