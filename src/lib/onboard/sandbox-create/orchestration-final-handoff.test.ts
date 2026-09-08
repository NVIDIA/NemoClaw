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
  createGpuPatchFixture,
  resetGpuFlowMocks,
  setupGpuFlowMocks,
} from "../__test-helpers__/sandbox-gpu-create-flow";
import { createOnboardCreatedSandboxRegistration } from "../created-sandbox-finalization";
import { runSandboxGpuCreateFlow } from "../sandbox-gpu-create-flow";
import { createCreatedSandboxLifecycle } from "../sandbox-recreate-transaction";
import { fingerprintSandboxRecreateValue } from "../sandbox-recreate-transaction";
import {
  createFinalHandoffCheckpointPersistence,
  createOnboardCreatedSandboxRegistrationWithManagedLifecycle,
  prepareResumedFinalHandoffCheckpoint,
} from "./orchestration";
import { resolveLegacyCompatibilityFinalHandoffRuntime } from "./identity-boundary";

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
              createdLifecycle.revalidate(
                createdLifecycle.capture(resolveLifecycleRegistrationFields()),
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
      const runtimePatch = createGpuPatchFixture();
      flowInput.managedBootstrap = {
        bootstrapIdentity: "managed-bootstrap-identity",
        stateRoot: path.join(tempHome, "managed-bootstrap"),
        runtimeProvider: {
          identity: { id: "docker" },
          bootstrap: {
            createOnboardRouting: () => null,
            createLifecycle: (options: { readonly launchArgv: readonly string[] }) => ({
              launchArgv: options.launchArgv,
              patch: runtimePatch,
              recoverUnfinished: async () => null,
              prepareNetwork: async () => undefined,
              runCreate: async () => {
                throw new Error("resumed handoff must not create another sandbox");
              },
            }),
          },
        },
        authorityStore: {},
        request: {},
        image: {},
        agentIdentity: {},
        workspaceRoot: {},
        managedStateRoots: [],
        intendedWorkloadArgv: flowInput.sandboxStartupCommand,
        expectedSupervisorArgv: [],
      } as never;
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
