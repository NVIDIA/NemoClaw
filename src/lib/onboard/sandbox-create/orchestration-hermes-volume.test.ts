// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";
import { createManagedHermesStateVolumeOnboardLifecycle } from "../managed-workload/onboard-orchestration";
import {
  finalizeRecreatedSourceHermesStateVolume,
  runSandboxCreateWithPolicyAuthorityChecks,
} from "./orchestration";

function managedHermesSource(): SandboxEntry {
  return {
    name: "alpha",
    agent: "hermes",
    openshellDriver: "docker-linux",
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: `ghcr.io/nvidia/nemoclaw/hermes@sha256:${"a".repeat(64)}`,
      release: "v0.0.100",
      sourceRevision: "b".repeat(40),
      sourceCohort: "ghrun-100-1",
      capabilityContractVersion: 1,
      startupProfileContractVersion: 1,
      encodedProfile: "fixture-profile",
      startupProfileSha256: "c".repeat(64),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  };
}

type HermesVolumeFinalizationDeps = Parameters<typeof finalizeRecreatedSourceHermesStateVolume>[1];

function hermesVolumeCleanupDeps(
  removeManagedHermesStateVolume: HermesVolumeFinalizationDeps["removeManagedHermesStateVolume"],
): HermesVolumeFinalizationDeps {
  return {
    normalizeRuntimeProviderIdentity: vi.fn(() => "docker"),
    removeManagedHermesStateVolume,
    removeSourceRegistryEntry: vi.fn(),
    note: vi.fn(),
    warn: vi.fn(),
    redact: vi.fn((message: string) => message.replace("secret", "[REDACTED]")),
  };
}

describe("managed Hermes state volume recreation", () => {
  it("preserves the volume when managed Docker Hermes replaces managed Docker Hermes", () => {
    const docker = createHermesStateVolumeDockerHarness({
      name: "nemoclaw-hermes-state-v1-alpha",
      labels: {
        "io.nvidia.nemoclaw.hermes-state.managed": "true",
        "io.nvidia.nemoclaw.hermes-state.schema": "1",
        "io.nvidia.nemoclaw.hermes-state.sandbox": "alpha",
        "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
      },
    });
    const targetLifecycle = createManagedHermesStateVolumeOnboardLifecycle(
      {
        agentName: "hermes",
        runtimeProvider: { identity: { id: "docker" } } as never,
        sandboxName: "alpha",
        workloadKind: "managed-image",
      },
      {
        runDocker: docker.runDocker as never,
        registerExitCleanup: () => vi.fn(),
      },
    );
    const removeManagedHermesStateVolume =
      vi.fn<HermesVolumeFinalizationDeps["removeManagedHermesStateVolume"]>();
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

    finalizeRecreatedSourceHermesStateVolume(
      {
        sandboxName: "alpha",
        sourceConfirmedAbsent: true,
        sourceEntry: managedHermesSource(),
        targetKeepsManagedHermesStateVolume: targetLifecycle !== null,
      },
      deps,
    );

    expect(targetLifecycle).not.toBeNull();
    expect(docker.calls.some((args) => args[0] === "create")).toBe(false);
    expect(removeManagedHermesStateVolume).not.toHaveBeenCalled();
    targetLifecycle?.commit();
  });

  it.each([
    ["OpenClaw", "openclaw", "docker", "managed-image"],
    ["custom Dockerfile Hermes", "hermes", "docker", "legacy-dockerfile"],
    ["managed-image Hermes on a non-Docker runtime", "hermes", "kubernetes", "managed-image"],
  ])(
    "removes the owned volume when managed Docker Hermes changes to %s",
    (_replacement, agentName, runtimeProviderId, workloadKind) => {
      const runDocker = vi.fn(() => {
        throw new Error("a replacement that does not own the volume must not access Docker");
      });
      const targetLifecycle = createManagedHermesStateVolumeOnboardLifecycle(
        {
          agentName,
          runtimeProvider: { identity: { id: runtimeProviderId } } as never,
          sandboxName: "alpha",
          workloadKind,
        },
        { runDocker: runDocker as never },
      );
      const removeManagedHermesStateVolume = vi.fn<
        HermesVolumeFinalizationDeps["removeManagedHermesStateVolume"]
      >(() => ({ status: "removed" as const }));
      const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

      finalizeRecreatedSourceHermesStateVolume(
        {
          sandboxName: "alpha",
          sourceConfirmedAbsent: true,
          sourceEntry: managedHermesSource(),
          targetKeepsManagedHermesStateVolume: targetLifecycle !== null,
        },
        deps,
      );

      expect(targetLifecycle).toBeNull();
      expect(runDocker).not.toHaveBeenCalled();
      expect(removeManagedHermesStateVolume).toHaveBeenCalledExactlyOnceWith({
        agentName: "hermes",
        runtimeProviderId: "docker",
        sandboxName: "alpha",
        workloadKind: "managed-image",
      });
      expect(deps.note).toHaveBeenCalledWith("  Removed managed Hermes state volume for 'alpha'.");
    },
  );

  it("leaves a foreign same-name volume untouched", () => {
    const removeManagedHermesStateVolume = vi.fn<
      HermesVolumeFinalizationDeps["removeManagedHermesStateVolume"]
    >(() => ({
      status: "not-owned" as const,
      detail: "the exact NemoClaw ownership labels are absent or changed",
      volumeName: "nemoclaw-hermes-state-v1-alpha",
    }));
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

    finalizeRecreatedSourceHermesStateVolume(
      {
        sandboxName: "alpha",
        sourceConfirmedAbsent: true,
        sourceEntry: managedHermesSource(),
        targetKeepsManagedHermesStateVolume: false,
      },
      deps,
    );

    expect(deps.warn).toHaveBeenCalledWith(
      "  Left Docker volume 'nemoclaw-hermes-state-v1-alpha' untouched because the exact NemoClaw ownership labels are absent or changed.",
    );
  });

  it("fails with redacted recovery evidence and allows an exact retry", () => {
    const removeManagedHermesStateVolume = vi
      .fn<HermesVolumeFinalizationDeps["removeManagedHermesStateVolume"]>()
      .mockReturnValueOnce({
        status: "failed" as const,
        detail: "secret Docker failure",
        volumeName: "nemoclaw-hermes-state-v1-alpha",
      })
      .mockReturnValueOnce({ status: "removed" as const });
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);
    const input = {
      sandboxName: "alpha",
      sourceEntry: managedHermesSource(),
      sourceConfirmedAbsent: true,
      targetKeepsManagedHermesStateVolume: false,
    };

    expect(() => finalizeRecreatedSourceHermesStateVolume(input, deps)).toThrow(
      "[REDACTED] Docker failure",
    );
    expect(deps.removeSourceRegistryEntry).not.toHaveBeenCalled();
    expect(() => finalizeRecreatedSourceHermesStateVolume(input, deps)).not.toThrow();
    expect(removeManagedHermesStateVolume).toHaveBeenCalledTimes(2);
    expect(deps.removeSourceRegistryEntry).toHaveBeenCalledExactlyOnceWith(
      input.sourceEntry,
      "alpha",
    );
  });
});

describe("managed Hermes state volume failed-create cleanup", () => {
  const exactIdentityBoundary = {
    captureCreatedSandboxIdentity: vi.fn(() => "a".repeat(64)),
    persistCreatedSandboxIdentity: vi.fn(),
    revalidateCreatedSandboxIdentity: vi.fn(),
    verifyCreatedPolicy: vi.fn(() => "verified"),
    persistVerifiedPolicy: vi.fn(),
    revalidateVerifiedPolicy: vi.fn(),
  };

  async function rejectSandboxCreate(
    lifecycle: NonNullable<ReturnType<typeof createManagedHermesStateVolumeOnboardLifecycle>>,
  ): Promise<void> {
    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async () => {
          throw new Error("sandbox creation failed");
        },
        ...exactIdentityBoundary,
        cleanupTemporarySources: vi.fn(),
        cleanupIncompleteCreate: () => lifecycle.cleanupIncompleteCreate(),
      }),
    ).rejects.toThrow("sandbox creation failed");
  }

  it("removes a newly created owned volume after a handled create failure", async () => {
    const docker = createHermesStateVolumeDockerHarness();
    const lifecycle = createManagedHermesStateVolumeOnboardLifecycle(
      {
        agentName: "hermes",
        runtimeProvider: { identity: { id: "docker" } } as never,
        sandboxName: "alpha",
        workloadKind: "managed-image",
      },
      { runDocker: docker.runDocker as never, registerExitCleanup: () => vi.fn() },
    );

    await rejectSandboxCreate(lifecycle!);

    expect(docker.volume).toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(true);
  });

  it("preserves a reused owned volume after a handled create failure", async () => {
    const docker = createHermesStateVolumeDockerHarness({
      name: "nemoclaw-hermes-state-v1-alpha",
      labels: {
        "io.nvidia.nemoclaw.hermes-state.managed": "true",
        "io.nvidia.nemoclaw.hermes-state.schema": "1",
        "io.nvidia.nemoclaw.hermes-state.sandbox": "alpha",
        "io.nvidia.nemoclaw.hermes-state.target": "/sandbox/.hermes",
      },
    });
    const lifecycle = createManagedHermesStateVolumeOnboardLifecycle(
      {
        agentName: "hermes",
        runtimeProvider: { identity: { id: "docker" } } as never,
        sandboxName: "alpha",
        workloadKind: "managed-image",
      },
      { runDocker: docker.runDocker as never },
    );

    await rejectSandboxCreate(lifecycle!);

    expect(docker.volume).not.toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(false);
  });

  it("retains a newly created volume with identity-bound recovery after policy failure", async () => {
    const docker = createHermesStateVolumeDockerHarness();
    let exitCleanup: (() => void) | null = null;
    const unregister = vi.fn();
    const lifecycle = createManagedHermesStateVolumeOnboardLifecycle(
      {
        agentName: "hermes",
        runtimeProvider: { identity: { id: "docker" } } as never,
        sandboxName: "alpha",
        workloadKind: "managed-image",
      },
      {
        runDocker: docker.runDocker as never,
        registerExitCleanup: (cleanup) => {
          exitCleanup = cleanup;
          return unregister;
        },
      },
    );

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary,
      verifyCreatedPolicy: () => {
        throw new Error("policy verification failed");
      },
      cleanupTemporarySources: vi.fn(),
      cleanupIncompleteCreate: () => lifecycle!.cleanupIncompleteCreate(),
      preserveIncompleteCreate: () => lifecycle!.preserveForRecovery(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect(unregister).toHaveBeenCalledOnce();
    exitCleanup!();
    expect(docker.volume).not.toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(false);

    const createCalls = docker.calls.filter((args) => args[0] === "create").length;
    const retryLifecycle = createManagedHermesStateVolumeOnboardLifecycle(
      {
        agentName: "hermes",
        runtimeProvider: { identity: { id: "docker" } } as never,
        sandboxName: "alpha",
        workloadKind: "managed-image",
      },
      { runDocker: docker.runDocker as never },
    );
    retryLifecycle!.cleanupIncompleteCreate();

    expect(docker.calls.filter((args) => args[0] === "create")).toHaveLength(createCalls);
    expect(docker.volume).not.toBeNull();
    retryLifecycle!.commit();
  });

  it("refuses and preserves a foreign same-name volume before sandbox creation", () => {
    const docker = createHermesStateVolumeDockerHarness({
      name: "nemoclaw-hermes-state-v1-alpha",
      labels: { "com.example.owner": "foreign" },
    });

    expect(() =>
      createManagedHermesStateVolumeOnboardLifecycle(
        {
          agentName: "hermes",
          runtimeProvider: { identity: { id: "docker" } } as never,
          sandboxName: "alpha",
          workloadKind: "managed-image",
        },
        { runDocker: docker.runDocker as never },
      ),
    ).toThrow("exact NemoClaw ownership labels do not match");
    expect(docker.volume).not.toBeNull();
    expect(docker.calls.some((args) => args[0] === "rm")).toBe(false);
  });
});
