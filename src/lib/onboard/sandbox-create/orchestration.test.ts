// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { decisionSelected } from "../../state/onboard-checkpoint-decision";
import { deriveCheckpointFromSession } from "../../state/onboard-checkpoint-migrate";
import { createSession, normalizeSession } from "../../state/onboard-session";
import type { SandboxEntry } from "../../state/registry";
import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";
import { createManagedHermesStateVolumeOnboardLifecycle } from "../managed-workload/onboard-orchestration";
import {
  beginSandboxRecreateTransaction,
  createCreatedSandboxLifecycle,
  createSandboxRecreateRuntime,
  fingerprintSandboxRecreateValue,
  type SandboxRecreateObservation,
} from "../sandbox-recreate-transaction";
import {
  applyAbsentSandboxRebuildPolicyCarryForward,
  applyManagedSandboxRebuildPolicyCarryForward,
  cleanupRecreatedSourceHermesStateVolume,
  completeHermesPortableSandboxRegistration,
  finalizeRecreatedSourceHermesStateVolume,
  hasManagedMcpRebuildHandoff,
  readManagedDcodeCreateSelectionDrift,
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
      vi.fn<HermesVolumeCleanupDeps["removeManagedHermesStateVolume"]>();
    const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

    cleanupRecreatedSourceHermesStateVolume(
      {
        sandboxName: "alpha",
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
        HermesVolumeCleanupDeps["removeManagedHermesStateVolume"]
      >(() => ({ status: "removed" as const }));
      const deps = hermesVolumeCleanupDeps(removeManagedHermesStateVolume);

      cleanupRecreatedSourceHermesStateVolume(
        {
          sandboxName: "alpha",
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

  it("preserves the registry entry when volume removal fails and retries removal", () => {
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

  it("removes create sources and reports the surviving sandbox when final validation fails (#9833)", async () => {
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
      }),
    ).rejects.toThrow("cleanup did not complete");

    expect(events).toEqual([
      "create-check",
      "create",
      "capture-identity",
      "ready-check",
      "cleanup-sources",
      "observe-created",
    ]);
  });

  it("reports both source cleanup failure and the surviving sandbox (#9833)", async () => {
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
      }),
    ).rejects.toThrow("cleanup did not complete");
  });

  it("does not delete a matching identity through its mutable name (#9833)", async () => {
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
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("deletion targets its mutable name"),
        }),
      ]),
    );
    expect(observeCreatedSandbox).toHaveBeenCalledOnce();
  });

  it("does not delete a replacement observed before cleanup (#9833)", async () => {
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
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("live identity changed") }),
      ]),
    );
  });

  it("persists refusal recovery identity and rejects a same-name replacement after reload (#9833)", async () => {
    const gatewayName = "nemoclaw-31818";
    const gatewayPort = 31818;
    const transactionId = "11111111-1111-4111-8111-111111111111";
    const targetGeneration = "22222222-2222-4222-8222-222222222222";
    const targetIntentFingerprint = fingerprintSandboxRecreateValue("fresh-create");
    const session = createSession({ sandboxName: "alpha", agent: "openclaw" });
    session.checkpoint = {
      ...deriveCheckpointFromSession(session),
      sandboxIdentity: decisionSelected({ name: "alpha", agent: "openclaw" }),
      gatewayAuthority: decisionSelected({
        gatewayName,
        gatewayPort,
        mode: "nemoclaw-managed",
        source: "standalone",
        endpoint: null,
        stateDir: null,
        supervisor: null,
        requiredCapabilities: [],
      }),
    };
    const transaction = beginSandboxRecreateTransaction(session, {
      sandboxName: "alpha",
      gatewayName,
      gatewayPort,
      sourceEntry: null,
      observation: { state: "missing", liveIdentityFingerprint: null },
      targetIntentFingerprint,
      id: transactionId,
      targetGeneration,
    });
    let observation: SandboxRecreateObservation = {
      state: "missing",
      liveIdentityFingerprint: null,
    };
    const sessionStore = {
      loadSession: () => session,
      updateSession: (mutator: (current: typeof session) => typeof session | void) => {
        mutator(session);
        return session;
      },
    };
    const request = {
      id: transaction.id,
      targetGeneration: transaction.targetGeneration,
      targetIntentFingerprint: transaction.targetIntentFingerprint,
    };
    const runtime = createSandboxRecreateRuntime(
      sessionStore,
      request,
      "alpha",
      gatewayName,
      null,
      () => observation,
      vi.fn(),
    );
    runtime.advance("creating");
    const lifecycle = createCreatedSandboxLifecycle(
      runtime,
      { sandboxName: "alpha", gatewayName },
      () => observation,
    );
    observation = createdObservation;
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
        captureCreatedSandboxLiveIdentity: () =>
          lifecycle.capture({ lifecycleGeneration: targetGeneration })
            .lifecycleLiveIdentityFingerprint,
        observeCreatedSandbox: () => observation,
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("cleanup did not complete");

    expect(session.checkpoint?.sandboxRecreate).toMatchObject({
      sandboxName: "alpha",
      gatewayName,
      gatewayPort,
      phase: "created",
      targetLiveIdentityFingerprint: CREATED_IDENTITY,
    });
    const restored = normalizeSession(JSON.parse(JSON.stringify(session)));
    expect(restored).not.toBeNull();
    const restoredSession = restored!;
    expect(restoredSession.checkpoint?.sandboxRecreate).toMatchObject(request);
    observation = { state: "ready", liveIdentityFingerprint: REPLACEMENT_IDENTITY };
    expect(() =>
      createSandboxRecreateRuntime(
        {
          loadSession: () => restoredSession,
          updateSession: (mutator) => {
            mutator(restoredSession);
            return restoredSession;
          },
        },
        request,
        "alpha",
        gatewayName,
        null,
        () => observation,
        vi.fn(),
      ),
    ).toThrow(/not the journaled created sandbox/u);
  });

  it("leaves the named sandbox in place when its created identity was not captured (#9833)", async () => {
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
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("identity was not captured") }),
      ]),
    );
    expect(observeCreatedSandbox).not.toHaveBeenCalled();
  });
});
