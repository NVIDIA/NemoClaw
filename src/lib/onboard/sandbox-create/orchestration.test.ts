// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SandboxEntry } from "../../state/registry";
import {
  applyManagedSandboxRebuildPolicyCarryForward,
  backfillVerifiedExternalSandboxPolicyAuthority,
  completeHermesPortableSandboxRegistration,
  createProviderEffectBoundary,
  hasManagedMcpRebuildHandoff,
  readManagedDcodeCreateSelectionDrift,
  readSandboxRecreateRegistryEntry,
  runSandboxCreateWithPolicyAuthorityChecks,
} from "./orchestration";

describe("deferred provider effect authority", () => {
  it("refuses a second provider attachment after policy authority changes (#9833)", async () => {
    const events: string[] = [];
    const recordPolicyCheck = (operation: string) => {
      events.push(`policy: ${operation}`);
    };
    const revalidatePolicyRequirements = vi.fn(recordPolicyCheck);
    const runOpenshell = vi.fn((args: string[]) => {
      events.push(args.join(" "));
      revalidatePolicyRequirements
        .mockImplementationOnce(recordPolicyCheck)
        .mockImplementationOnce((operation) => {
          recordPolicyCheck(operation);
          throw new Error("policy authority changed after the first provider attachment");
        });
      return { status: 0 };
    });
    const revalidateSandboxIdentity = vi.fn((_exactIdentity: string, operation: string) => {
      events.push(`identity: ${operation}`);
    });
    const boundary = createProviderEffectBoundary({
      deferred: true,
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      preparationInput: {
        openshellDriver: "docker",
        inferenceProvider: null,
        messagingProviders: [],
        messagingProviderRequests: [],
        extraProviders: [],
        gatewayName: "nemoclaw",
      },
      preparationDeps: {
        providerExistsInGateway: vi.fn(() => true),
        runOpenshell: runOpenshell as never,
        cleanupCreateSources: vi.fn(),
      },
      runVerifiedSandboxCreateEffects: null,
      activateDeferredProviderEffects: () => ["first", "second"],
      revalidatePolicyAuthorityBeforeCreate: vi.fn(),
      runOpenshell: runOpenshell as never,
      revalidateSandboxIdentity,
    });
    const runAfterVerifiedCreate = boundary.runAfterVerifiedCreate;
    expect(runAfterVerifiedCreate).toBeTypeOf("function");

    await expect(
      runAfterVerifiedCreate?.({
        registration: {
          policyAuthority: "externally-managed",
          policyCreationReceipt: null,
          observedPolicyAuthority: "externally-managed",
          policyIdentity: { hash: "b".repeat(64), activeVersion: 1 },
        },
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        gatewayPort: 18790,
        lifecycleGeneration: "generation-1",
        lifecycleLiveIdentityFingerprint: "a".repeat(64),
        route: "direct" as never,
        revalidatePolicyRequirements,
      }),
    ).rejects.toThrow("policy authority changed after the first provider attachment");

    expect(runOpenshell).toHaveBeenCalledExactlyOnceWith(
      ["sandbox", "provider", "attach", "-g", "nemoclaw", "alpha", "first"],
      { ignoreError: true, suppressOutput: true },
    );
    expect(revalidateSandboxIdentity).toHaveBeenCalledWith(
      "a".repeat(64),
      "attaching provider 'second' to sandbox 'alpha'",
    );
    expect(events).toContain("policy: attaching provider 'second' to sandbox 'alpha'");
    expect(events).not.toContain("sandbox provider attach -g nemoclaw alpha second");
  });
});

describe("policy authority backfill", () => {
  it("does not assign managed authority before completed sandbox registration (#9833)", () => {
    const updateSandbox = vi.fn(() => true);

    backfillVerifiedExternalSandboxPolicyAuthority({
      sandboxName: "alpha",
      existingEntry: { name: "alpha", pendingRouteReservation: true },
      policyAuthority: "nemoclaw-managed",
      updateSandbox,
    });

    expect(updateSandbox).not.toHaveBeenCalled();
  });

  it("records verified external authority on an unattributed existing row (#9833)", () => {
    const updateSandbox = vi.fn(() => true);

    backfillVerifiedExternalSandboxPolicyAuthority({
      sandboxName: "alpha",
      existingEntry: { name: "alpha" },
      policyAuthority: "externally-managed",
      updateSandbox,
    });

    expect(updateSandbox).toHaveBeenCalledExactlyOnceWith("alpha", {
      policyAuthority: "externally-managed",
    });
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
  const exactIdentity = "a".repeat(64);
  const verifiedPolicyBoundary = () => ({
    verifyCreatedPolicy: vi.fn(() => "verified"),
    persistVerifiedPolicy: vi.fn(),
    revalidateVerifiedPolicy: vi.fn(),
  });
  const exactIdentityBoundary = () => ({
    captureCreatedSandboxIdentity: vi.fn(() => exactIdentity),
    revalidateCreatedSandboxIdentity: vi.fn(),
    ...verifiedPolicyBoundary(),
  });

  it("refuses sandbox creation before mutation when the final check fails (#9833)", async () => {
    const create = vi.fn(async () => "created");

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate: () => {
          throw new Error("external policy authority must supply the selected route");
        },
        ...exactIdentityBoundary(),
        create,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow(/external policy authority must supply/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("checks the named Ready sandbox before registration can continue (#9833)", async () => {
    const events: string[] = [];
    const result = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate: (sandboxIsLive) => events.push(sandboxIsLive ? "ready-check" : "create-check"),
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => {
        events.push("capture-identity");
        return exactIdentity;
      },
      revalidateCreatedSandboxIdentity: () => events.push("identity-check"),
      verifyCreatedPolicy: () => {
        events.push("policy-check");
        return "verified";
      },
      persistVerifiedPolicy: () => events.push("persist-checkpoint"),
      revalidateVerifiedPolicy: () => events.push("revalidate-checkpoint"),
      cleanupTemporarySources: vi.fn(),
    });
    events.push("register");

    expect(result).toBe("created");
    expect(events).toEqual([
      "create-check",
      "create",
      "capture-identity",
      "identity-check",
      "policy-check",
      "identity-check",
      "persist-checkpoint",
      "revalidate-checkpoint",
      "identity-check",
      "identity-check",
      "register",
    ]);
  });

  it("removes temporary sources but preserves the sandbox after final authority failure (#9833)", async () => {
    const events: string[] = [];
    const revalidate = vi.fn(() => events.push("create-check"));

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        events.push("create");
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      revalidateVerifiedPolicy: () => {
        events.push("ready-check");
        throw new Error("external policy authority changed");
      },
      cleanupTemporarySources: () => events.push("cleanup-sources"),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*Do not delete the sandbox by name, even after this comparison.*Contact the OpenShell administrator for an identity-bound recovery or removal procedure`,
              "u",
            ),
          ),
        }),
      ]),
    );
    expect(events).toEqual(["create-check", "create", "ready-check", "cleanup-sources"]);
  });

  it("does not delete a same-name replacement after final authority failure (#9833)", async () => {
    let sandboxIdentity = "created";
    const revalidate = vi.fn();
    const revalidateCreatedSandboxIdentity = vi.fn();

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => exactIdentity,
      revalidateCreatedSandboxIdentity,
      ...verifiedPolicyBoundary(),
      revalidateVerifiedPolicy: () => {
        sandboxIdentity = "replacement";
        throw new Error("sandbox identity changed");
      },
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringMatching(
            new RegExp(
              `left sandbox 'alpha' in place.*identity fingerprint: ${exactIdentity}.*Do not delete the sandbox by name, even after this comparison`,
              "u",
            ),
          ),
        }),
      ]),
    );
    expect(revalidateCreatedSandboxIdentity).toHaveBeenNthCalledWith(
      1,
      exactIdentity,
      "verifying effective policy for sandbox 'alpha'",
    );
    expect(revalidateCreatedSandboxIdentity).toHaveBeenNthCalledWith(
      2,
      exactIdentity,
      "recording verified policy for sandbox 'alpha'",
    );
    expect(sandboxIdentity).toBe("replacement");
  });

  it("reports temporary source cleanup failure with sandbox preservation (#9833)", async () => {
    const revalidate = vi.fn();

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate,
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      ...exactIdentityBoundary(),
      revalidateVerifiedPolicy: () => {
        throw new Error("external policy authority changed");
      },
      cleanupTemporarySources: () => {
        throw new Error("temporary source cleanup failed");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "temporary source cleanup failed" }),
        expect.objectContaining({ message: expect.stringContaining("left sandbox 'alpha'") }),
      ]),
    );
  });

  it("runs continuation effects only after policy and identity verification (#9833)", async () => {
    const events: string[] = [];

    const result = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate: (sandboxIsLive) => events.push(sandboxIsLive ? "policy" : "preflight"),
      create: async (verifyCreatedSandbox) => {
        events.push("create-without-policy");
        await verifyCreatedSandbox({ sandboxName: "alpha" });
        return "complete";
      },
      runVerifiedCreateEffects: async () => {
        events.push("provider-effects");
      },
      captureCreatedSandboxIdentity: () => {
        events.push("capture");
        return exactIdentity;
      },
      revalidateCreatedSandboxIdentity: () => events.push("identity"),
      verifyCreatedPolicy: () => {
        events.push("policy");
        return "verified";
      },
      persistVerifiedPolicy: () => events.push("checkpoint"),
      revalidateVerifiedPolicy: () => events.push("checkpoint-revalidate"),
      cleanupTemporarySources: vi.fn(),
    });

    expect(result).toBe("complete");
    expect(events).toEqual([
      "preflight",
      "create-without-policy",
      "capture",
      "identity",
      "policy",
      "identity",
      "checkpoint",
      "checkpoint-revalidate",
      "provider-effects",
      "identity",
      "identity",
    ]);
  });

  it("withholds checkpoint and effects when post-create policy verification fails (#9833)", async () => {
    const persistVerifiedPolicy = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        revalidateCreatedSandboxIdentity: vi.fn(),
        verifyCreatedPolicy: () => {
          throw new Error("policy verification failed");
        },
        persistVerifiedPolicy,
        revalidateVerifiedPolicy: vi.fn(),
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistVerifiedPolicy).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("withholds effects when durable checkpoint persistence fails (#9833)", async () => {
    const revalidateVerifiedPolicy = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        revalidateCreatedSandboxIdentity: vi.fn(),
        verifyCreatedPolicy: () => "verified",
        persistVerifiedPolicy: () => {
          throw new Error("checkpoint persistence failed");
        },
        revalidateVerifiedPolicy,
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(revalidateVerifiedPolicy).not.toHaveBeenCalled();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("retains the checkpoint and withholds effects when its reread fails (#9833)", async () => {
    const persistVerifiedPolicy = vi.fn();
    const runVerifiedCreateEffects = vi.fn();

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        revalidateCreatedSandboxIdentity: vi.fn(),
        verifyCreatedPolicy: () => "verified",
        persistVerifiedPolicy,
        revalidateVerifiedPolicy: () => {
          throw new Error("durable checkpoint missing");
        },
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistVerifiedPolicy).toHaveBeenCalledOnce();
    expect(runVerifiedCreateEffects).not.toHaveBeenCalled();
  });

  it("retains the durable checkpoint when a deferred effect fails (#9833)", async () => {
    const persistVerifiedPolicy = vi.fn();

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        revalidateCreatedSandboxIdentity: vi.fn(),
        verifyCreatedPolicy: () => "verified",
        persistVerifiedPolicy,
        revalidateVerifiedPolicy: vi.fn(),
        runVerifiedCreateEffects: async () => {
          throw new Error("provider effect failed");
        },
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(persistVerifiedPolicy).toHaveBeenCalledOnce();
  });

  it("refuses continuation when identity changes during effective-policy verification (#9833)", async () => {
    const continuationEffect = vi.fn();
    const revalidate = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => undefined);
    const revalidateCreatedSandboxIdentity = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("sandbox identity changed");
      });

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks({
        sandboxName: "alpha",
        revalidate,
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox("created");
          continuationEffect();
          return "created";
        },
        captureCreatedSandboxIdentity: () => exactIdentity,
        revalidateCreatedSandboxIdentity,
        ...verifiedPolicyBoundary(),
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");

    expect(continuationEffect).not.toHaveBeenCalled();
  });

  it("fails closed when a create implementation skips the post-create gate (#9833)", async () => {
    const cleanupTemporarySources = vi.fn();

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async () => "created",
      ...exactIdentityBoundary(),
      cleanupTemporarySources,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("post-create verification") }),
      ]),
    );
    expect(cleanupTemporarySources).toHaveBeenCalledOnce();
  });
});
