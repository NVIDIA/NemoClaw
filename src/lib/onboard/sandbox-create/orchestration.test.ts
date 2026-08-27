// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PolicyAuthorityRefusalError } from "../../adapters/openshell/policy-authority";
import type { SandboxEntry } from "../../state/registry";
import { createHermesStateVolumeDockerHarness } from "../__test-helpers__/hermes-state-volume";
import { createManagedHermesStateVolumeOnboardLifecycle } from "../managed-workload/onboard-orchestration";
import {
  applyManagedSandboxRebuildPolicyCarryForward,
  assertApfCreateIntent,
  backfillVerifiedExternalSandboxPolicyAuthority,
  completeHermesPortableSandboxRegistration,
  createProviderEffectBoundary,
  finalizeRecreatedSourceHermesStateVolume,
  hasManagedMcpRebuildHandoff,
  persistRetainedSandboxRecoveryMessage,
  readManagedDcodeCreateSelectionDrift,
  readSandboxRecreateRegistryEntry,
  reconcileCreatedHermesCredentialEnvironment,
  resolveSandboxCreatePolicyAuthority,
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

describe("created Hermes credential environment reconciliation", () => {
  const plan = { agent: "hermes" } as never;

  it("restarts and rechecks the managed gateway after changing the env file", () => {
    const events: string[] = [];
    const restart = { status: 0, stdout: "managed completion", stderr: "" };

    reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan },
      {
        revalidatePolicyAuthority: (operation) => events.push(`policy:${operation}`),
        reconcileCredentialEnv: () => {
          events.push("reconcile");
          return { changed: true };
        },
        restartGateway: () => {
          events.push("restart");
          return restart;
        },
        parseRestartCompletion: (result) => {
          events.push("parse");
          return result === restart ? {} : null;
        },
        waitForGateway: () => {
          events.push("wait");
          return true;
        },
      },
    );

    expect(events).toEqual([
      expect.stringMatching(/^policy:reconciling/u),
      "reconcile",
      expect.stringMatching(/^policy:confirming/u),
      "restart",
      "parse",
      "wait",
      expect.stringMatching(/^policy:completing/u),
    ]);
  });

  it("does not restart when the env file was already reconciled", () => {
    const restartGateway = vi.fn();
    const waitForGateway = vi.fn();

    reconcileCreatedHermesCredentialEnvironment(
      { sandboxName: "alpha", plan },
      {
        revalidatePolicyAuthority: vi.fn(),
        reconcileCredentialEnv: () => ({ changed: false }),
        restartGateway,
        parseRestartCompletion: vi.fn(),
        waitForGateway,
      },
    );

    expect(restartGateway).not.toHaveBeenCalled();
    expect(waitForGateway).not.toHaveBeenCalled();
  });

  it("fails onboarding when the changed gateway cannot prove restart completion", () => {
    expect(() =>
      reconcileCreatedHermesCredentialEnvironment(
        { sandboxName: "alpha", plan },
        {
          revalidatePolicyAuthority: vi.fn(),
          reconcileCredentialEnv: () => ({ changed: true }),
          restartGateway: () => ({ status: 1, stdout: "", stderr: "failed" }),
          parseRestartCompletion: () => null,
          waitForGateway: vi.fn(),
        },
      ),
    ).toThrow("managed gateway restart did not complete");
  });
});

describe("retained create recovery persistence", () => {
  it.each([
    ["available fingerprint", "f".repeat(64)],
    ["unavailable fingerprint", null],
  ])(
    "keeps the create-attempt authority after session sanitization with %s (#9211)",
    async (_case, fingerprint) => {
      const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-recovery-"));
      const nonce = "a".repeat(62);
      const createAttemptLabel = `ai.nvidia.nemoclaw.create-attempt=${nonce}`;
      const message =
        `Create-attempt label: ${createAttemptLabel}. ` +
        `${fingerprint ? `Durable sandbox identity fingerprint: ${fingerprint}. ` : ""}` +
        "Recovery guidance follows after the authority fields. " +
        "x".repeat(400);

      try {
        vi.stubEnv("HOME", tempHome);
        vi.resetModules();
        const session = await import("../../state/onboard-session");
        session.saveSession(session.createSession({ sandboxName: "alpha" }));

        expect(
          persistRetainedSandboxRecoveryMessage(message, session.finalizeIncompleteOnboardStep),
        ).toBe(true);

        const stored = session.loadSession();
        expect(stored?.machine.state).toBe("failed");
        expect(stored?.steps.sandbox?.status).toBe("failed");
        expect(stored?.failure?.message).toContain(createAttemptLabel);
        expect(stored?.steps.sandbox?.error).toContain(createAttemptLabel);
        const fingerprintExpectation = fingerprint
          ? expect.stringContaining(fingerprint)
          : expect.not.stringContaining("Durable sandbox identity fingerprint:");
        expect(stored?.failure?.message).toEqual(fingerprintExpectation);
        expect(stored?.steps.sandbox?.error).toEqual(fingerprintExpectation);
      } finally {
        vi.resetModules();
        fs.rmSync(tempHome, { force: true, recursive: true });
        vi.unstubAllEnvs();
      }
    },
  );

  it("reports persistence failure when no onboard session owns the recovery (#9211)", () => {
    const finalizeIncompleteOnboardStep = vi.fn(() => null);

    expect(
      persistRetainedSandboxRecoveryMessage(
        "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=authority",
        finalizeIncompleteOnboardStep,
      ),
    ).toBe(false);
    expect(finalizeIncompleteOnboardStep).toHaveBeenCalledExactlyOnceWith(
      "sandbox",
      "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=authority",
    );
  });

  it("reports persistence failure when the onboard session is already terminal (#9211)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-create-recovery-"));

    try {
      vi.stubEnv("HOME", tempHome);
      vi.resetModules();
      const session = await import("../../state/onboard-session");
      session.saveSession(session.createSession({ sandboxName: "alpha" }));
      session.finalizeIncompleteOnboardStep("sandbox", "Earlier sandbox failure");

      expect(
        persistRetainedSandboxRecoveryMessage(
          "Create-attempt label: ai.nvidia.nemoclaw.create-attempt=unpersisted",
          session.finalizeIncompleteOnboardStep,
        ),
      ).toBe(false);

      const stored = session.loadSession();
      expect(stored?.failure?.message).toBe("Earlier sandbox failure");
      expect(stored?.steps.sandbox?.error).toBe("Earlier sandbox failure");
    } finally {
      vi.resetModules();
      fs.rmSync(tempHome, { force: true, recursive: true });
      vi.unstubAllEnvs();
    }
  });
});

describe("APF create policy selection", () => {
  it("selects a policyless external plan only from an absent global policy (#9833)", () => {
    expect(resolveSandboxCreatePolicyAuthority("nemoclaw-managed", true)).toBe(
      "externally-managed",
    );
    expect(resolveSandboxCreatePolicyAuthority("nemoclaw-managed", false)).toBe("nemoclaw-managed");
    expect(resolveSandboxCreatePolicyAuthority("externally-managed", false)).toBe(
      "externally-managed",
    );
  });

  it("refuses APF creation when an active global policy exists (#9833)", () => {
    expect(() => resolveSandboxCreatePolicyAuthority("externally-managed", true)).toThrow(
      /active global policy to be absent/u,
    );
  });

  it("requires APF effects to use the generic post-create gate (#9833)", () => {
    expect(() =>
      assertApfCreateIntent({
        apfInterceptorRequested: true,
      }),
    ).toThrow(/missing deferred-effect authority/u);
    expect(() =>
      assertApfCreateIntent({
        apfInterceptorRequested: true,
        deferSandboxEffectsUntilPolicyVerification: true,
      }),
    ).not.toThrow();
    expect(() => assertApfCreateIntent(null)).not.toThrow();
  });
});

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
      activateDeferredProviderEffects: (revalidate) => {
        revalidate("cleaning up providers for sandbox 'alpha'");
        return ["first", "second"];
      },
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
    expect(events).toContain("policy: cleaning up providers for sandbox 'alpha'");
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

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async (verifyCreatedSandbox) => {
        await verifyCreatedSandbox("created");
        return "created";
      },
      captureCreatedSandboxIdentity: () => exactIdentity,
      revalidateCreatedSandboxIdentity: vi.fn(),
      verifyCreatedPolicy: () => {
        throw new PolicyAuthorityRefusalError("policy verification failed");
      },
      persistVerifiedPolicy,
      revalidateVerifiedPolicy: vi.fn(),
      runVerifiedCreateEffects,
      cleanupTemporarySources: vi.fn(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain("policy verification failed");
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
    const cleanupIncompleteCreate = vi.fn();

    const error = await runSandboxCreateWithPolicyAuthorityChecks({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      create: async () => "created",
      ...exactIdentityBoundary(),
      cleanupTemporarySources,
      cleanupIncompleteCreate,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("post-create verification") }),
      ]),
    );
    expect(cleanupTemporarySources).toHaveBeenCalledOnce();
    expect(cleanupIncompleteCreate).toHaveBeenCalledOnce();
  });
});
