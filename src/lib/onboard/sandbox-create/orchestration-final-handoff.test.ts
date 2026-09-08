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
} from "./orchestration";

beforeEach(() => setupGpuFlowMocks(mocks));
afterEach(resetGpuFlowMocks);

describe("durable final-handoff publication", () => {
  it("publishes only after the real pending-create checkpoint is acknowledged (#10560)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-final-handoff-"));
    vi.stubEnv("HOME", tempHome);
    vi.resetModules();
    try {
      const registry = await import("../../state/registry");
      const lifecycleGeneration = "generation-1";
      const sandboxId = "alpha-sandbox-id";
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
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        sessionId: "session-owner",
        selection,
      } as const;
      registry.reserveSandboxInferenceRoute("alpha", {
        ...selection,
        gatewayName: authority.gatewayName,
        reservationSessionId: authority.sessionId,
      });
      const routeDisposition = registry.classifySandboxInferenceRouteReservation(
        authority,
        registry.getSandbox("alpha"),
      );
      expect(routeDisposition.kind).toBe("owned");
      const routeReservation = (
        routeDisposition as Extract<SandboxInferenceRouteReservationDisposition, { kind: "owned" }>
      ).reservation;
      const createReservation = registry.qualifyPendingSandboxCreateReservation(
        authority,
        registry.getSandbox("alpha"),
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
        exactFinalHandoffCommitStarted: true,
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
      expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toEqual(checkpoint);
      expect(checkpoint).not.toHaveProperty("exactFinalHandoffAcknowledged");

      const lifecycle = createCreatedSandboxLifecycle(
        {
          targetGeneration: undefined,
          registrationFields: {},
          recordCreated: vi.fn(),
        } as never,
        { sandboxName: "alpha", gatewayName: authority.gatewayName },
        () => ({ state: "not_ready", liveIdentityFingerprint }),
        lifecycleGeneration,
      );
      const completeRegistration = createOnboardCreatedSandboxRegistrationWithManagedLifecycle({
        sandboxName: authority.sandboxName,
        allowManagedBootstrapNotReady: () => false,
        allowNotReadyWithMatchingIdentity: () =>
          registry.getSandbox("alpha")?.pendingCreateIdentity?.exactFinalHandoffAcknowledged ===
          true,
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
              const verifiedCheckpoint = registry.getSandbox("alpha")?.pendingCreateIdentity;
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
      expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toEqual(checkpoint);

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
      flowInput.gatewayName = authority.gatewayName;
      flowInput.lifecycleGeneration = lifecycleGeneration;
      flowInput.resumeVerifiedCreate = {
        route: "compatibility",
        liveIdentityFingerprint,
        createAttemptNonce: "a".repeat(62),
        finalHandoffCommitStarted: true,
      };
      flowInput.verifyCreatedSandboxBeforeEffects = vi.fn();
      flowInput.revalidateVerifiedSandboxBeforeEffect = vi.fn();
      flowInput.persistRetainedSandboxRecovery = vi.fn(() => true);
      flowInput.persistResumedFinalHandoffAcknowledgement =
        checkpointPersistence.persistResumedFinalHandoffAcknowledgement;
      const runtimePatch = createGpuPatchFixture();
      mocks.createDockerGpuSandboxCreatePatch.mockReturnValue(runtimePatch);
      const created = await runSandboxGpuCreateFlow(flowInput, createGpuFlowDeps(sandboxId));

      expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toEqual(checkpoint);
      expect(checkpoint.exactFinalHandoffAcknowledged).toBe(true);
      await expect(completeRegistration(created, null)).resolves.toBeUndefined();
      expect(registry.getSandbox("alpha")).toMatchObject({
        name: "alpha",
        agent: "openclaw",
        lifecycleGeneration,
        lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
      });
      expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      fs.rmSync(tempHome, { force: true, recursive: true });
    }
  });
});
