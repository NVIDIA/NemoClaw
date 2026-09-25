// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamSandboxCreate: vi.fn(),
  waitForCreatedSandboxReadyWithTrace: vi.fn(),
  printReadinessFailure: vi.fn(),
  enforceDockerGpuPatchPreserveNetwork: vi.fn(),
  verifyGpuSandboxAccessAfterReady: vi.fn(),
  createDockerGpuSandboxCreatePatch: vi.fn(),
  printSandboxCreateFailureDiagnostics: vi.fn(),
  collectDockerGpuPatchDiagnostics: vi.fn(),
  queryOpenShellDockerSandboxContainers: vi.fn(),
  queryOpenShellDockerSandboxRuntimeSnapshot: vi.fn(),
}));

vi.mock("../sandbox/create-stream", () => ({
  streamSandboxCreate: mocks.streamSandboxCreate,
}));
vi.mock("../sandbox-readiness-tracing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sandbox-readiness-tracing")>()),
  waitForCreatedSandboxReadyWithTrace: mocks.waitForCreatedSandboxReadyWithTrace,
  printReadinessFailure: mocks.printReadinessFailure,
}));
vi.mock("../docker-gpu-local-inference", () => ({
  enforceDockerGpuPatchPreserveNetwork: mocks.enforceDockerGpuPatchPreserveNetwork,
  verifyGpuSandboxAccessAfterReady: mocks.verifyGpuSandboxAccessAfterReady,
}));
vi.mock("../docker-gpu-sandbox-create", () => ({
  createDockerGpuSandboxCreatePatch: mocks.createDockerGpuSandboxCreatePatch,
}));
vi.mock("../sandbox-create-failure", () => ({
  printSandboxCreateFailureDiagnostics: mocks.printSandboxCreateFailureDiagnostics,
}));
vi.mock("../docker-gpu-patch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../docker-gpu-patch")>()),
  collectDockerGpuPatchDiagnostics: mocks.collectDockerGpuPatchDiagnostics,
}));
vi.mock("../openshell-docker-sandbox-containers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../openshell-docker-sandbox-containers")>()),
  queryOpenShellDockerSandboxContainers: mocks.queryOpenShellDockerSandboxContainers,
  queryOpenShellDockerSandboxRuntimeSnapshot: mocks.queryOpenShellDockerSandboxRuntimeSnapshot,
}));

import type {
  PendingSandboxCreateIdentity,
  SandboxInferenceRouteReservationDisposition,
} from "../../state/registry";
import {
  createGpuFlowDeps,
  createGpuFlowInput,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "../__test-helpers__/sandbox-gpu-create-flow";
import { createOnboardCreatedSandboxRegistration } from "../created-sandbox-finalization";
import { runSandboxGpuCreateFlow } from "../sandbox-gpu-create-flow";
import { createCreatedSandboxLifecycle } from "../sandbox-recreate-transaction";
import { fingerprintSandboxRecreateValue } from "../sandbox-recreate-transaction";
import { revalidateCreatedSandboxLifecycleRegistration } from "../sandbox-recreate-transaction";
import {
  allowsNotReadyCreatedSandboxReconciliation,
  allowsNotReadyCreatedSandboxRevalidation,
  createFinalHandoffCheckpointPersistence,
  createOnboardCreatedSandboxRegistrationWithManagedLifecycle,
  prepareResumedFinalHandoffCheckpoint,
  revalidateCreatedSandboxIdentityDuringCreate,
} from "./orchestration";
import { resolveLegacyCompatibilityFinalHandoffRuntime } from "./identity-boundary";
import {
  createVerifiedSandboxStartupEffects,
  runSandboxCreateWithIdentityVerification,
} from "./orchestration";
import type { ProviderManagedStartupTransaction } from "../managed-startup/provider-root-apply";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import type { VerifiedSandboxCreateBoundary } from "../types";
import { createManagedStartupRootApplyRequest } from "../managed-startup/root-apply";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import {
  MANAGED_STARTUP_E2E_CORPORATE_CA_PEM,
  managedStartupE2eProfile,
} from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";

describe("corporate CA verified-create effects", () => {
  it.each([
    {
      failure: null,
      outcome: "published",
      events: ["resume", "apply", "commit", "refresh", "release", "finished", "publish"],
    },
    { failure: "resume", outcome: "retained", events: ["resume"] },
    { failure: "refresh", outcome: "retained", events: ["resume", "apply", "commit", "refresh"] },
  ] as const)("keeps the creation flow $outcome when failure is $failure", async (scenario) => {
    const events: string[] = [];
    let running = false;
    let refreshed = false;
    let finished = false;
    const sandboxId = "alpha-sandbox-id";
    const identity = fingerprintSandboxRecreateValue(sandboxId);
    const bootstrapIdentity = "c".repeat(64);
    const request = createManagedStartupRootApplyRequest({
      agent: "openclaw",
      encodedProfile: encodeManagedStartupProfile(
        managedStartupE2eProfile("openclaw", false, true, true),
      ),
      corporateCaB64: Buffer.from(MANAGED_STARTUP_E2E_CORPORATE_CA_PEM).toString("base64"),
    });
    const runtimeProvider = { identity: { id: "podman" } } as RuntimeProviderBundle;
    const transaction: ProviderManagedStartupTransaction = {
      agent: "openclaw",
      bootstrapIdentity,
      containerId: "a".repeat(64),
      image: `sha256:${"b".repeat(64)}`,
      protocol: "identity-bound",
      providerId: "podman",
    };
    const boundary: VerifiedSandboxCreateBoundary = {
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "ca-generation",
      lifecycleLiveIdentityFingerprint: identity,
      createAttemptNonce: "d".repeat(62),
      managedBootstrapIdentity: bootstrapIdentity,
      route: "native",
    };
    const step = async (name: "resume" | "refresh") => {
      events.push(name);
      await (scenario.failure === name
        ? Promise.reject(new Error(`failed ${name}`))
        : Promise.resolve());
    };
    const release = vi.fn(() => {
      expect(refreshed).toBe(true);
      events.push("release");
    });
    const effects = createVerifiedSandboxStartupEffects({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      managedStartupRootApplyRequest: request,
      runtimeProvider,
      managedBootstrapIdentity: bootstrapIdentity,
      resumingVerifiedCreate: true,
      revalidateVerifiedCreateIdentity: vi.fn(),
      onProtocol: vi.fn(),
      onFinished: () => {
        finished = true;
        events.push("finished");
      },
      managedWorkloadOnboard: {
        resumeProviderManagedStartupTrust: async (input) => {
          expect(input).toEqual({
            sandboxName: "alpha",
            sandboxId,
            gatewayName: "nemoclaw",
            corporateCa: true,
            route: "native",
          });
          await step("resume");
          running = true;
        },
        applyProviderManagedStartupRootRequest: (input) => {
          expect(running).toBe(true);
          expect(input).toEqual({
            runtimeProvider,
            sandboxName: "alpha",
            sandboxId,
            bootstrapIdentity,
            request,
          });
          events.push("apply");
          return transaction;
        },
        finalizeProviderManagedStartupSharedState: (input) => {
          expect(input).toMatchObject({ transaction, supervisorReady: true });
          events.push("commit");
          return { supervisorReady: true, failure: null };
        },
        refreshProviderManagedStartupTrust: async (input) => {
          expect(input).toEqual({
            runtimeProvider,
            sandboxName: "alpha",
            sandboxId,
            gatewayName: "nemoclaw",
            transaction,
            corporateCa: true,
            route: "native",
          });
          await step("refresh");
          refreshed = true;
        },
        releaseProviderManagedStartupHold: release,
      },
    });
    const flowInput = createGpuFlowInput();
    flowInput.managedImage = true;
    flowInput.gpuRoutePlan = "native-only";
    flowInput.persistRetainedSandboxRecovery = vi.fn(() => true);
    flowInput.revalidateVerifiedSandboxBeforeEffect = vi.fn();
    flowInput.resumeVerifiedCreate = {
      route: "native",
      liveIdentityFingerprint: identity,
      createAttemptNonce: boundary.createAttemptNonce,
    };
    const retain = vi.fn(() => true);
    const publish = vi.fn(() => {
      expect(finished).toBe(true);
      events.push("publish");
      return "published";
    });
    const result = await runSandboxCreateWithIdentityVerification({
      sandboxName: "alpha",
      revalidate: vi.fn(),
      captureCreatedSandboxIdentity: (created: { liveIdentityFingerprint: string }) =>
        created.liveIdentityFingerprint,
      captureCreatedSandboxCreateAttemptNonce: () => boundary.createAttemptNonce,
      persistCreatedSandboxIdentity: vi.fn(),
      revalidateCreatedSandboxIdentity: vi.fn(),
      captureVerifiedCreateBoundary: () => boundary,
      persistCreateIdentity: vi.fn(),
      revalidateVerifiedCreateIdentity: vi.fn(),
      runVerifiedCreateEffects: effects,
      persistRetainedSandboxRecovery: retain,
      cleanupTemporarySources: vi.fn(),
      create: (verifyCreatedSandbox) =>
        runSandboxGpuCreateFlow(
          {
            ...flowInput,
            verifyCreatedSandboxBeforeEffects: async (...args) => {
              await verifyCreatedSandbox(...args);
            },
          },
          createGpuFlowDeps(sandboxId),
        ),
    }).then(publish, (error: unknown) => {
      expect(error).toBeInstanceOf(AggregateError);
      return "retained";
    });
    expect(result).toBe(scenario.outcome);
    expect(events).toEqual(scenario.events);
    expect(publish).toHaveBeenCalledTimes(scenario.outcome === "published" ? 1 : 0);
    expect(retain).toHaveBeenCalledTimes(scenario.outcome === "retained" ? 1 : 0);
    expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
  });
});

describe("compatibility create reconciliation", () => {
  it("admits interrupted corporate-CA recovery only with the saved identity and keeps final publication gated", () => {
    const checkpoint: PendingSandboxCreateIdentity = {
      schemaVersion: 1,
      state: "verified-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "interrupted-ca",
      lifecycleGeneration: "ca-generation",
      sandboxIdentityFingerprint: fingerprintSandboxRecreateValue("ca-sandbox-id"),
      route: "native",
    };
    const input = {
      managedBootstrapCreateFinished: false,
      createRoute: "native" as const,
      currentCheckpoint: checkpoint,
      acceptedCheckpoint: checkpoint,
      corporateCa: true,
    };
    const options = {
      allowNotReadyWithMatchingIdentity: allowsNotReadyCreatedSandboxReconciliation(input),
    };
    const registration = {
      lifecycleGeneration: checkpoint.lifecycleGeneration,
      lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    };
    expect(
      revalidateCreatedSandboxLifecycleRegistration(
        checkpoint,
        registration,
        () => ({
          state: "not_ready",
          liveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
        }),
        options,
      ),
    ).toEqual(registration);
    expect(() =>
      revalidateCreatedSandboxLifecycleRegistration(
        checkpoint,
        registration,
        () => ({
          state: "not_ready",
          liveIdentityFingerprint: fingerprintSandboxRecreateValue("foreign-sandbox-id"),
        }),
        options,
      ),
    ).toThrow("live identity changed");
    expect(allowsNotReadyCreatedSandboxReconciliation({ ...input, acceptedCheckpoint: null })).toBe(
      false,
    );
    expect(allowsNotReadyCreatedSandboxReconciliation({ ...input, corporateCa: false })).toBe(
      false,
    );
    expect(allowsNotReadyCreatedSandboxRevalidation(input)).toBe(false);
  });

  it("allows same-identity NotReady reconciliation before cutover but withholds publication (#11905)", () => {
    const input = {
      managedBootstrapCreateFinished: false,
      createRoute: "compatibility" as const,
      currentCheckpoint: null,
      acceptedCheckpoint: null,
    };

    expect(allowsNotReadyCreatedSandboxReconciliation(input)).toBe(true);
    expect(allowsNotReadyCreatedSandboxRevalidation(input)).toBe(false);
  });

  it("uses only the nonce-selected identity during the reversible cutover window (#11905)", () => {
    const sandboxId = "compatibility-sandbox-id";
    const expectedIdentity = fingerprintSandboxRecreateValue(sandboxId);
    const revalidateLifecycle = vi.fn(() => {
      throw new Error("OpenShell lifecycle is Error before compatibility cutover");
    });

    expect(() =>
      revalidateCreatedSandboxIdentityDuringCreate({
        expectedIdentity,
        compatibilityReconciliation: { resolveSandboxId: () => sandboxId },
        fingerprintSandboxId: fingerprintSandboxRecreateValue,
        revalidateLifecycle,
      }),
    ).not.toThrow();
    expect(revalidateLifecycle).not.toHaveBeenCalled();

    expect(() =>
      revalidateCreatedSandboxIdentityDuringCreate({
        expectedIdentity,
        compatibilityReconciliation: { resolveSandboxId: () => "replacement-sandbox-id" },
        fingerprintSandboxId: fingerprintSandboxRecreateValue,
        revalidateLifecycle,
      }),
    ).toThrow(/identity changed during initial compatibility reconciliation/u);
  });

  it("keeps ordinary and final lifecycle revalidation outside the cutover window (#11905)", () => {
    const revalidateLifecycle = vi.fn();

    revalidateCreatedSandboxIdentityDuringCreate({
      expectedIdentity: "a".repeat(64),
      compatibilityReconciliation: null,
      fingerprintSandboxId: fingerprintSandboxRecreateValue,
      revalidateLifecycle,
    });

    expect(revalidateLifecycle).toHaveBeenCalledOnce();
  });
});

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("durable final-handoff publication", () => {
  it("derives legacy recovery authority only from one identity-bound OpenShell runtime", () => {
    const sandboxId = "legacy-openshell-sandbox-id";
    const checkpoint: PendingSandboxCreateIdentity = {
      schemaVersion: 1,
      state: "verified-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "e2e-gw-survivor",
      lifecycleGeneration: "v0.0.55-upgrade-generation",
      sandboxIdentityFingerprint: fingerprintSandboxRecreateValue(sandboxId),
      route: "compatibility",
    };

    expect(
      resolveLegacyCompatibilityFinalHandoffRuntime({
        checkpoint,
        observation: {
          status: "observed",
          malformedRows: 0,
          rows: [
            {
              id: "b".repeat(64),
              managedBy: "openshell",
              workspace: "alpha",
              sandboxId,
            },
          ],
        },
      }),
    ).toBe("b".repeat(64));
    expect(() =>
      resolveLegacyCompatibilityFinalHandoffRuntime({
        checkpoint,
        observation: {
          status: "observed",
          malformedRows: 0,
          rows: [
            {
              id: "b".repeat(64),
              managedBy: "openshell",
              workspace: "alpha",
              sandboxId: "foreign-sandbox-id",
            },
          ],
        },
      }),
    ).toThrow(/does not match its durable sandbox checkpoint/u);
  });

  it("does not migrate a legacy compatibility checkpoint after identity drift (#10560)", () => {
    const checkpoint: PendingSandboxCreateIdentity = {
      schemaVersion: 1,
      state: "verified-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "e2e-gw-survivor",
      lifecycleGeneration: "v0.0.55-upgrade-generation",
      sandboxIdentityFingerprint: "a".repeat(64),
      route: "compatibility",
    };
    expect(() =>
      prepareResumedFinalHandoffCheckpoint({
        checkpoint,
        revalidateLegacyCompatibilityIdentity: () => {
          throw new Error("live identity changed before registry publication");
        },
        resolveLegacyCompatibilityRuntimeId: vi.fn(),
        persistFinalHandoffCommitStarted: vi.fn(),
        getCheckpoint: () => checkpoint,
      }),
    ).toThrow(/live identity changed/u);
    expect(checkpoint).not.toHaveProperty("exactFinalHandoffCommitStarted");
    expect(checkpoint).not.toHaveProperty("exactFinalHandoffAcknowledged");
  });

  it("refuses to infer runtime authority for a stable legacy compatibility checkpoint (#10560)", () => {
    const checkpoint: PendingSandboxCreateIdentity = {
      schemaVersion: 1,
      state: "verified-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "e2e-gw-survivor",
      lifecycleGeneration: "v0.0.55-upgrade-generation",
      sandboxIdentityFingerprint: "a".repeat(64),
      route: "compatibility",
    };
    const revalidateLegacyCompatibilityIdentity = vi.fn();
    const persistFinalHandoffCommitStarted = vi.fn();

    expect(() =>
      prepareResumedFinalHandoffCheckpoint({
        checkpoint,
        revalidateLegacyCompatibilityIdentity,
        resolveLegacyCompatibilityRuntimeId: () => {
          throw new Error("could not prove one exact Docker replacement runtime");
        },
        persistFinalHandoffCommitStarted,
        getCheckpoint: () => checkpoint,
      }),
    ).toThrow(/could not prove one exact Docker replacement runtime/u);
    expect(revalidateLegacyCompatibilityIdentity).toHaveBeenCalledOnce();
    expect(persistFinalHandoffCommitStarted).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveProperty("exactFinalHandoffCommitStarted");
  });

  it("publishes a resumed compatibility checkpoint only after exact runtime acknowledgement (#10560)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-final-handoff-"));
    vi.stubEnv("HOME", tempHome);
    vi.resetModules();
    try {
      const registry = await import("../../state/registry");
      const lifecycleGeneration = "generation-1";
      const sandboxId = "v0-0-55-replacement-sandbox-id";
      const liveIdentityFingerprint = fingerprintSandboxRecreateValue(sandboxId);
      const selection = {
        provider: "ollama-local",
        model: "qwen3-vl:4b",
        endpointUrl: "http://127.0.0.1:11434/v1",
        endpointSource: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoning: null,
        compatibleEndpointReasoningEffort: null,
        nimContainer: null,
      } as const;
      const authority = {
        sandboxName: "e2e-gw-survivor",
        gatewayName: "nemoclaw",
        sessionId: "session-owner",
        selection,
      } as const;
      registry.reserveSandboxInferenceRoute(authority.sandboxName, {
        ...selection,
        gatewayName: authority.gatewayName,
        reservationSessionId: authority.sessionId,
      });
      const routeDisposition = registry.classifySandboxInferenceRouteReservation(
        authority,
        registry.getSandbox(authority.sandboxName),
      );
      expect(routeDisposition.kind).toBe("owned");
      const routeReservation = (
        routeDisposition as Extract<SandboxInferenceRouteReservationDisposition, { kind: "owned" }>
      ).reservation;
      const createReservation = registry.qualifyPendingSandboxCreateReservation(
        authority,
        registry.getSandbox(authority.sandboxName),
      );
      let checkpoint: PendingSandboxCreateIdentity = {
        schemaVersion: 1,
        state: "verified-create",
        gatewayName: authority.gatewayName,
        gatewayPort: 8080,
        sandboxName: authority.sandboxName,
        lifecycleGeneration,
        sandboxIdentityFingerprint: liveIdentityFingerprint,
        route: "compatibility",
      };
      registry.recordPendingSandboxCreateIdentity(createReservation, checkpoint);
      const checkpointPersistence = createFinalHandoffCheckpointPersistence({
        getCheckpoint: () => checkpoint,
        setCheckpoint: (next) => {
          checkpoint = next;
        },
        persist: (next, expected) => {
          registry.recordPendingSandboxCreateIdentity(createReservation, next, { expected });
        },
      });
      expect(registry.getSandbox(authority.sandboxName)?.pendingCreateIdentity).toEqual(checkpoint);
      expect(checkpoint).not.toHaveProperty("exactFinalHandoffCommitStarted");
      expect(checkpoint).not.toHaveProperty("exactFinalHandoffAcknowledged");

      const replacementRuntimeId = "b".repeat(64);

      const lifecycle = createCreatedSandboxLifecycle(
        {
          targetGeneration: undefined,
          registrationFields: {},
          recordCreated: vi.fn(),
        } as never,
        { sandboxName: authority.sandboxName, gatewayName: authority.gatewayName },
        () => ({ state: "not_ready", liveIdentityFingerprint }),
        lifecycleGeneration,
      );
      const completeRegistration = createOnboardCreatedSandboxRegistrationWithManagedLifecycle({
        sandboxName: authority.sandboxName,
        allowManagedBootstrapNotReady: () => false,
        allowNotReadyWithMatchingIdentity: () =>
          registry.getSandbox(authority.sandboxName)?.pendingCreateIdentity
            ?.exactFinalHandoffAcknowledged === true,
        sandboxGpuEnabled: false,
        createdLifecycle: lifecycle,
        getRecordedRegistration: () => ({
          lifecycleGeneration,
          lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
        }),
        createRegistration: createOnboardCreatedSandboxRegistration,
        registration: {
          completion: {
            complete: async (
              _created,
              _configuredReceipt,
              _providerGpuDisposition,
              _manageDashboard,
              resolveLifecycleRegistrationFields,
              createdLifecycle,
            ) => {
              await createdLifecycle.revalidate(
                await createdLifecycle.capture(resolveLifecycleRegistrationFields()),
              );
              const verifiedCheckpoint = registry.getSandbox(
                authority.sandboxName,
              )?.pendingCreateIdentity;
              expect(verifiedCheckpoint).toBeDefined();
              registry.registerSandbox(
                {
                  name: authority.sandboxName,
                  ...selection,
                  agent: "openclaw",
                  openshellDriver: "docker",
                  gatewayName: authority.gatewayName,
                  gatewayPort: verifiedCheckpoint!.gatewayPort,
                  lifecycleGeneration,
                  lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
                },
                routeReservation,
                {
                  verifiedCreate: {
                    reservation: createReservation,
                    checkpoint: verifiedCheckpoint!,
                  },
                },
              );
            },
          },
          cleanupBuildContext: vi.fn(),
          manageDashboard: false,
          sandboxGpuEnabled: false,
        },
      });

      await expect(
        completeRegistration(
          { lifecycleRegistrationFields: { lifecycleGeneration } } as never,
          null,
        ),
      ).rejects.toThrow(/not report it Ready/u);
      expect(registry.getSandbox(authority.sandboxName)?.pendingCreateIdentity).toEqual(checkpoint);

      const resumedCheckpoint = prepareResumedFinalHandoffCheckpoint({
        checkpoint,
        revalidateLegacyCompatibilityIdentity: () => {
          lifecycle.revalidate(
            {
              lifecycleGeneration,
              lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
            },
            { allowNotReadyWithMatchingIdentity: true },
          );
        },
        resolveLegacyCompatibilityRuntimeId: () => replacementRuntimeId,
        persistFinalHandoffCommitStarted: checkpointPersistence.persistFinalHandoffCommitStarted,
        getCheckpoint: () => checkpoint,
      });
      expect(resumedCheckpoint).toEqual({
        schemaVersion: 1,
        state: "verified-create",
        gatewayName: authority.gatewayName,
        gatewayPort: 8080,
        sandboxName: authority.sandboxName,
        lifecycleGeneration,
        sandboxIdentityFingerprint: liveIdentityFingerprint,
        route: "compatibility",
        exactFinalHandoffCommitStarted: true,
        exactFinalHandoffRuntimeId: replacementRuntimeId,
      });
      expect(resumedCheckpoint).not.toHaveProperty("exactFinalHandoffAcknowledged");

      const flowInput = createGpuFlowInput();
      flowInput.sandboxGpuConfig = {
        mode: "0",
        hostGpuDetected: false,
        hostGpuPlatform: null,
        sandboxGpuEnabled: false,
        sandboxGpuDevice: null,
        errors: [],
      };
      flowInput.gpuRoutePlan = "none";
      flowInput.initialGpuRoute = "none";
      flowInput.sandboxName = authority.sandboxName;
      flowInput.gatewayName = authority.gatewayName;
      flowInput.lifecycleGeneration = lifecycleGeneration;
      flowInput.resumeVerifiedCreate = {
        route: resumedCheckpoint.route,
        liveIdentityFingerprint: resumedCheckpoint.sandboxIdentityFingerprint,
        finalHandoffCommitStarted: true,
        finalHandoffRuntimeId: replacementRuntimeId,
      };
      flowInput.verifyCreatedSandboxBeforeEffects = vi.fn();
      flowInput.revalidateVerifiedSandboxBeforeEffect = vi.fn();
      flowInput.persistRetainedSandboxRecovery = vi.fn(() => true);
      flowInput.persistResumedFinalHandoffAcknowledgement =
        checkpointPersistence.persistResumedFinalHandoffAcknowledgement;
      const deps = createGpuFlowDeps(sandboxId);
      const created = await runSandboxGpuCreateFlow(flowInput, deps);

      expect(registry.getSandbox(authority.sandboxName)?.pendingCreateIdentity).toEqual(checkpoint);
      expect(checkpoint.exactFinalHandoffAcknowledged).toBe(true);
      expect(deps.verifyExactFinalHandoffRuntime).toHaveBeenNthCalledWith(
        1,
        authority.sandboxName,
        replacementRuntimeId,
        false,
      );
      expect(deps.verifyExactFinalHandoffRuntime).toHaveBeenNthCalledWith(
        2,
        authority.sandboxName,
        replacementRuntimeId,
        true,
      );
      expect(mocks.streamSandboxCreate).not.toHaveBeenCalled();
      await expect(completeRegistration(created, null)).resolves.toBeUndefined();
      expect(registry.getSandbox(authority.sandboxName)).toMatchObject({
        name: authority.sandboxName,
        agent: "openclaw",
        gatewayName: authority.gatewayName,
        gatewayPort: 8080,
        lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
      });
      expect(registry.getSandbox(authority.sandboxName)?.pendingCreateIdentity).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(tempHome, { force: true, recursive: true });
    }
  });
});
