// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import {
  applyManagedSandboxRebuildPolicyCarryForward,
  completeHermesPortableSandboxRegistration,
  hasManagedMcpRebuildHandoff,
  readManagedDcodeCreateSelectionDrift,
  readSandboxRecreateRegistryEntry,
  runSandboxCreateWithPolicyAuthorityChecks,
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
  it("preserves an intentionally empty managed preset selection (#9792)", () => {
    const note = vi.fn();
    const applyRecreatePolicyCarryForward = vi.fn();
    const revalidatePolicyAuthority = vi.fn();

    applyManagedSandboxRebuildPolicyCarryForward(
      {
        sandboxName: "alpha",
        policyAuthority: "nemoclaw-managed",
        nonInteractive: true,
        note,
        rebuildPolicyPresets: [],
        revalidatePolicyAuthority,
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

  it("does not carry managed presets into a live external recreation (#9833)", () => {
    const applyRecreatePolicyCarryForward = vi.fn();
    const revalidatePolicyAuthority = vi.fn();

    applyManagedSandboxRebuildPolicyCarryForward(
      {
        sandboxName: "alpha",
        policyAuthority: "externally-managed",
        nonInteractive: true,
        note: vi.fn(),
        rebuildPolicyPresets: ["github"],
        revalidatePolicyAuthority,
      },
      applyRecreatePolicyCarryForward,
    );

    expect(revalidatePolicyAuthority).not.toHaveBeenCalled();
    expect(applyRecreatePolicyCarryForward).not.toHaveBeenCalled();
  });

  it("revalidates managed authority before live recreate policy carry-forward (#9833)", () => {
    const applyRecreatePolicyCarryForward = vi.fn();
    const revalidatePolicyAuthority = vi.fn(() => {
      throw new Error("policy authority changed");
    });

    expect(() =>
      applyManagedSandboxRebuildPolicyCarryForward(
        {
          sandboxName: "alpha",
          policyAuthority: "nemoclaw-managed",
          nonInteractive: true,
          note: vi.fn(),
          rebuildPolicyPresets: ["github"],
          revalidatePolicyAuthority,
        },
        applyRecreatePolicyCarryForward,
      ),
    ).toThrow("policy authority changed");
    expect(applyRecreatePolicyCarryForward).not.toHaveBeenCalled();
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

describe("sandbox create policy authority checks", () => {
  const CREATED_IDENTITY = "a".repeat(64);
  const REPLACEMENT_IDENTITY = "b".repeat(64);
  const createdObservation = {
    state: "ready" as const,
    liveIdentityFingerprint: CREATED_IDENTITY,
  };

  it("refuses sandbox creation before mutation when the final check fails (#9833)", async () => {
    const create = vi.fn(async () => "created");

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate: () => {
          throw new Error("external policy authority must supply the selected route");
        },
        create,
        captureCreatedSandboxLiveIdentity: vi.fn(() => CREATED_IDENTITY),
        observeCreatedSandbox: vi.fn(() => createdObservation),
        cleanupTemporarySources: vi.fn(),
        deleteCreatedSandbox: vi.fn(),
        waitForCreatedSandboxAbsence: vi.fn(() => true),
      }),
    ).rejects.toThrow(/external policy authority must supply/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("checks the named Ready sandbox before registration can continue (#9833)", async () => {
    const events: string[] = [];
    const result = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate: (sandboxIsLive) => events.push(sandboxIsLive ? "ready-check" : "create-check"),
      create: async () => {
        events.push("create");
        return "created";
      },
      captureCreatedSandboxLiveIdentity: () => {
        events.push("capture-identity");
        return CREATED_IDENTITY;
      },
      observeCreatedSandbox: vi.fn(() => createdObservation),
      cleanupTemporarySources: vi.fn(),
      deleteCreatedSandbox: vi.fn(),
      waitForCreatedSandboxAbsence: vi.fn(() => true),
    });
    events.push("register");

    expect(result).toBe("created");
    expect(events).toEqual([
      "create-check",
      "create",
      "capture-identity",
      "ready-check",
      "register",
    ]);
  });

  it("removes create sources and the live sandbox when final authority validation fails (#9833)", async () => {
    const events: string[] = [];
    const validationError = new Error("external policy authority changed");
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => events.push("create-check"))
      .mockImplementationOnce(() => {
        events.push("ready-check");
        throw validationError;
      });

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate,
        create: async () => {
          events.push("create");
          return "created";
        },
        captureCreatedSandboxLiveIdentity: () => {
          events.push("capture-identity");
          return CREATED_IDENTITY;
        },
        observeCreatedSandbox: () => {
          events.push("observe-created");
          return createdObservation;
        },
        cleanupTemporarySources: () => {
          events.push("cleanup-sources");
        },
        deleteCreatedSandbox: () => {
          events.push("delete-created");
        },
        waitForCreatedSandboxAbsence: () => {
          events.push("prove-absence");
          return true;
        },
      }),
    ).rejects.toBe(validationError);

    expect(events).toEqual([
      "create-check",
      "create",
      "capture-identity",
      "ready-check",
      "cleanup-sources",
      "observe-created",
      "delete-created",
      "prove-absence",
    ]);
  });

  it("attempts sandbox deletion when temporary source cleanup fails (#9833)", async () => {
    const deleteCreatedSandbox = vi.fn();
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("external policy authority changed");
      });

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate,
        create: async () => "created",
        captureCreatedSandboxLiveIdentity: () => CREATED_IDENTITY,
        observeCreatedSandbox: () => createdObservation,
        cleanupTemporarySources: () => {
          throw new Error("temporary source cleanup failed");
        },
        deleteCreatedSandbox,
        waitForCreatedSandboxAbsence: () => true,
      }),
    ).rejects.toThrow("cleanup did not complete");

    expect(deleteCreatedSandbox).toHaveBeenCalledOnce();
  });

  it("reports incomplete cleanup when an accepted delete leaves the created identity live (#9833)", async () => {
    const deleteCreatedSandbox = vi.fn();
    const observeCreatedSandbox = vi.fn(() => createdObservation);
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("external policy authority changed");
      });

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate,
      create: async () => "created",
      captureCreatedSandboxLiveIdentity: () => CREATED_IDENTITY,
      observeCreatedSandbox,
      cleanupTemporarySources: vi.fn(),
      deleteCreatedSandbox,
      waitForCreatedSandboxAbsence: () => false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("exact absence was not proven"),
        }),
      ]),
    );
    expect(deleteCreatedSandbox).toHaveBeenCalledOnce();
    expect(observeCreatedSandbox).toHaveBeenCalledTimes(2);
  });

  it("does not delete a replacement observed before cleanup (#9833)", async () => {
    const deleteCreatedSandbox = vi.fn();
    const waitForCreatedSandboxAbsence = vi.fn(() => true);
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("external policy authority changed");
      });

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate,
      create: async () => "created",
      captureCreatedSandboxLiveIdentity: () => CREATED_IDENTITY,
      observeCreatedSandbox: () => ({
        state: "ready",
        liveIdentityFingerprint: REPLACEMENT_IDENTITY,
      }),
      cleanupTemporarySources: vi.fn(),
      deleteCreatedSandbox,
      waitForCreatedSandboxAbsence,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("live identity changed") }),
      ]),
    );
    expect(deleteCreatedSandbox).not.toHaveBeenCalled();
    expect(waitForCreatedSandboxAbsence).not.toHaveBeenCalled();
  });

  it("does not delete a replacement observed after an accepted delete (#9833)", async () => {
    const deleteCreatedSandbox = vi.fn();
    const observeCreatedSandbox = vi
      .fn()
      .mockReturnValueOnce(createdObservation)
      .mockReturnValueOnce({
        state: "ready" as const,
        liveIdentityFingerprint: REPLACEMENT_IDENTITY,
      });
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("external policy authority changed");
      });

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate,
      create: async () => "created",
      captureCreatedSandboxLiveIdentity: () => CREATED_IDENTITY,
      observeCreatedSandbox,
      cleanupTemporarySources: vi.fn(),
      deleteCreatedSandbox,
      waitForCreatedSandboxAbsence: () => false,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("now identifies a replacement"),
        }),
      ]),
    );
    expect(deleteCreatedSandbox).toHaveBeenCalledOnce();
  });

  it("leaves the named sandbox in place when its created identity was not captured (#9833)", async () => {
    const deleteCreatedSandbox = vi.fn();
    const observeCreatedSandbox = vi.fn(() => createdObservation);
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("external policy authority changed");
      });

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate,
      create: async () => "created",
      captureCreatedSandboxLiveIdentity: () => {
        throw new Error("identity probe failed");
      },
      observeCreatedSandbox,
      cleanupTemporarySources: vi.fn(),
      deleteCreatedSandbox,
      waitForCreatedSandboxAbsence: vi.fn(() => true),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("identity was not captured") }),
      ]),
    );
    expect(observeCreatedSandbox).not.toHaveBeenCalled();
    expect(deleteCreatedSandbox).not.toHaveBeenCalled();
  });
});
