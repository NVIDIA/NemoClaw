// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import {
  applyAbsentSandboxRebuildPolicyCarryForward,
  completeHermesPortableSandboxRegistration,
  hasManagedMcpRebuildHandoff,
  proveRecreateSourceBeforePolicyCarryForward,
  readManagedDcodeCreateSelectionDrift,
  readSandboxRecreateRegistryEntry,
} from "./orchestration";

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

describe("sandbox recreate registry authority", () => {
  it("re-reads the durable source row for Hermes portable recreation (#10056)", () => {
    const durable = { name: "alpha", lifecycleGeneration: "source-generation" } as SandboxEntry;
    const readRegistry = vi.fn(() => durable);

    expect(
      readSandboxRecreateRegistryEntry({
        sandboxName: "alpha",
        recreateTransaction: true,
        existingEntry: null,
        readRegistry,
      }),
    ).toBe(durable);
    expect(readRegistry).toHaveBeenCalledExactlyOnceWith("alpha");
  });

  it("keeps the inspected entry when no recreate transaction exists", () => {
    const inspected = { name: "alpha" } as SandboxEntry;
    const readRegistry = vi.fn(() => null);

    expect(
      readSandboxRecreateRegistryEntry({
        sandboxName: "alpha",
        recreateTransaction: false,
        existingEntry: inspected,
        readRegistry,
      }),
    ).toBe(inspected);
    expect(readRegistry).not.toHaveBeenCalled();
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
