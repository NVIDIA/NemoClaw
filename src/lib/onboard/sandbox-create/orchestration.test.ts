// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import {
  applyAbsentSandboxRebuildPolicyCarryForward,
  cleanupRecreatedSourceHermesStateVolume,
  completeHermesPortableSandboxRegistration,
  finalizeRecreatedSourceHermesStateVolume,
  hasManagedMcpRebuildHandoff,
  proveRecreateSourceBeforePolicyCarryForward,
  readManagedDcodeCreateSelectionDrift,
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

type HermesVolumeCleanupDeps = Parameters<typeof cleanupRecreatedSourceHermesStateVolume>[1];

function hermesVolumeCleanupDeps(
  removeManagedHermesStateVolume: HermesVolumeCleanupDeps["removeManagedHermesStateVolume"],
): HermesVolumeCleanupDeps {
  return {
    normalizeRuntimeProviderIdentity: vi.fn(() => "docker"),
    removeManagedHermesStateVolume,
    note: vi.fn(),
    warn: vi.fn(),
    redact: vi.fn((message: string) => message.replace("secret", "[REDACTED]")),
  };
}

describe("recreated managed Hermes state volume", () => {
  it("preserves the volume when the replacement keeps the managed Docker Hermes lifecycle", () => {
    const removeManagedHermesStateVolume =
      vi.fn<HermesVolumeCleanupDeps["removeManagedHermesStateVolume"]>();
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

    cleanupRecreatedSourceHermesStateVolume(
      {
        sandboxName: "alpha",
        sourceEntry: managedHermesSource(),
        targetKeepsManagedHermesStateVolume: true,
      },
      deps,
    );

    expect(removeManagedHermesStateVolume).not.toHaveBeenCalled();
  });

  it("removes the owned volume when the replacement changes its lifecycle", () => {
    const removeManagedHermesStateVolume = vi.fn<
      HermesVolumeCleanupDeps["removeManagedHermesStateVolume"]
    >(() => ({ status: "removed" as const }));
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

    cleanupRecreatedSourceHermesStateVolume(
      {
        sandboxName: "alpha",
        sourceEntry: managedHermesSource(),
        targetKeepsManagedHermesStateVolume: false,
      },
      deps,
    );

    expect(removeManagedHermesStateVolume).toHaveBeenCalledExactlyOnceWith({
      agentName: "hermes",
      runtimeProviderId: "docker",
      sandboxName: "alpha",
      workloadKind: "managed-image",
    });
    expect(deps.note).toHaveBeenCalledWith("  Removed managed Hermes state volume for 'alpha'.");
  });

  it("leaves a foreign same-name volume untouched", () => {
    const removeManagedHermesStateVolume = vi.fn<
      HermesVolumeCleanupDeps["removeManagedHermesStateVolume"]
    >(() => ({
      status: "not-owned" as const,
      detail: "the exact NemoClaw ownership labels are absent or changed",
      volumeName: "nemoclaw-hermes-state-v1-alpha",
    }));
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

    cleanupRecreatedSourceHermesStateVolume(
      {
        sandboxName: "alpha",
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
      .fn<HermesVolumeCleanupDeps["removeManagedHermesStateVolume"]>()
      .mockReturnValueOnce({
        status: "failed" as const,
        detail: "secret Docker failure",
        volumeName: "nemoclaw-hermes-state-v1-alpha",
      })
      .mockReturnValueOnce({ status: "removed" as const });
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);
    const removeSourceRegistryEntry = vi.fn();
    const finalizationDeps = { ...deps, removeSourceRegistryEntry };
    const input = {
      sandboxName: "alpha",
      sourceEntry: managedHermesSource(),
      sourceConfirmedAbsent: true,
      targetKeepsManagedHermesStateVolume: false,
    };

    expect(() => finalizeRecreatedSourceHermesStateVolume(input, finalizationDeps)).toThrow(
      "[REDACTED] Docker failure",
    );
    expect(removeSourceRegistryEntry).not.toHaveBeenCalled();
    expect(() => finalizeRecreatedSourceHermesStateVolume(input, finalizationDeps)).not.toThrow();
    expect(removeManagedHermesStateVolume).toHaveBeenCalledTimes(2);
    expect(removeSourceRegistryEntry).toHaveBeenCalledExactlyOnceWith(input.sourceEntry, "alpha");
  });
});

describe("managed MCP rebuild handoff", () => {
  const targetIntentFingerprint = "a".repeat(64);
  const recreateTransaction = {
    id: "recreate-1",
    targetGeneration: "generation-1",
    targetIntentFingerprint,
  };

  it("accepts only a handoff bound to the same recreate transaction", () => {
    expect(
      hasManagedMcpRebuildHandoff({
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        recreateJournalTargetIntentFingerprint: targetIntentFingerprint,
        recreateTransaction,
      }),
    ).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["mismatched", "b".repeat(64)],
  ])("rejects a %s outer rebuild handoff", (_label, handoff) => {
    expect(
      hasManagedMcpRebuildHandoff({
        recreate: true,
        toolDisclosure: "progressive",
        observabilityEnabled: false,
        ...(handoff ? { recreateJournalTargetIntentFingerprint: handoff } : {}),
        recreateTransaction,
      }),
    ).toBe(false);
  });
});

describe("authoritative rebuild policy carry-forward", () => {
  it("proves the journaled source before mutating its preserved policy row (#9792)", () => {
    const events: string[] = [];
    const runtime = { acceptedTarget: false };

    expect(
      proveRecreateSourceBeforePolicyCarryForward({
        createRecreateRuntime: () => {
          events.push("prove-source");
          return runtime;
        },
        carryForward: () => events.push("carry-forward"),
      }),
    ).toBe(runtime);
    expect(events).toEqual(["prove-source", "carry-forward"]);
  });

  it("replaces stale resumed presets after the outer rebuild deletes the source sandbox (#9792)", () => {
    const note = vi.fn();
    const applyRecreatePolicyCarryForward = vi.fn();
    const filteredPolicyPresets = ["github"];

    applyAbsentSandboxRebuildPolicyCarryForward(
      {
        sandboxName: "alpha",
        liveExists: false,
        nonInteractive: true,
        note,
        rebuildPolicyPresets: filteredPolicyPresets,
      },
      applyRecreatePolicyCarryForward,
    );

    expect(applyRecreatePolicyCarryForward).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      true,
      note,
      filteredPolicyPresets,
    );
  });

  it("preserves an intentionally empty preset selection after the outer delete (#9792)", () => {
    const note = vi.fn();
    const applyRecreatePolicyCarryForward = vi.fn();

    applyAbsentSandboxRebuildPolicyCarryForward(
      {
        sandboxName: "alpha",
        liveExists: false,
        nonInteractive: true,
        note,
        rebuildPolicyPresets: [],
      },
      applyRecreatePolicyCarryForward,
    );

    expect(applyRecreatePolicyCarryForward).toHaveBeenCalledExactlyOnceWith(
      "alpha",
      true,
      note,
      [],
    );
  });
});

describe("managed DCode sandbox create selection", () => {
  it.each([null, "https://openrouter.ai/api/v1"])(
    "passes the selected endpoint to live drift validation: %s (#9555)",
    (endpointUrl) => {
      const readDcodeSelectionDrift = vi.fn(() => ({
        changed: false,
        providerChanged: false,
        modelChanged: false,
        existingProvider: "openrouter",
        existingModel: "openrouter:nvidia/nemotron-3-ultra-550b-a55b",
        unknown: false,
      }));

      readManagedDcodeCreateSelectionDrift(
        {
          sandboxName: "saved",
          provider: "compatible-endpoint",
          model: "nvidia/nemotron-3-ultra-550b-a55b",
          preferredInferenceApi: "openai-completions",
          createIntent: { endpointUrl },
        },
        readDcodeSelectionDrift,
      );

      expect(readDcodeSelectionDrift).toHaveBeenCalledWith(
        "saved",
        "compatible-endpoint",
        "nvidia/nemotron-3-ultra-550b-a55b",
        "openai-completions",
        endpointUrl,
      );
    },
  );
});

describe("Hermes portable registration adapter", () => {
  it("returns the durable normalized registry entry after registration (#9211)", async () => {
    const events: string[] = [];
    const raw = { name: "alpha", dashboardPort: 0 } as SandboxEntry;
    const durable = { name: "alpha", dashboardPort: null } as SandboxEntry;
    const completeRegistration = vi.fn(async () => {
      events.push("complete");
      return raw;
    });
    const readRegistry = vi.fn(() => {
      events.push("read");
      return durable;
    });

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).resolves.toBe(durable);
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
    expect(events).toEqual(["complete", "read"]);
  });

  it("rejects a missing durable registry entry after registration (#9211)", async () => {
    const completeRegistration = vi.fn(async () => undefined);
    const readRegistry = vi.fn(() => null);

    await expect(
      completeHermesPortableSandboxRegistration({
        sandboxName: "alpha",
        completeRegistration,
        readRegistry,
      }),
    ).rejects.toThrow("Hermes portable sandbox registration returned no authority");
    expect(completeRegistration).toHaveBeenCalledOnce();
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
  });
});
