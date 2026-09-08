// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type {
  PendingSandboxCreateIdentity,
  SandboxInferenceRouteReservationDisposition,
} from "../../state/registry";
import { createOnboardCreatedSandboxRegistration } from "../created-sandbox-finalization";
import { createCreatedSandboxLifecycle } from "../sandbox-recreate-transaction";
import {
  createOnboardCreatedSandboxRegistrationWithManagedLifecycle,
  persistExactFinalHandoffCommitStarted,
  persistRecoveredFinalHandoffAcknowledgement,
} from "./orchestration";

describe("durable final-handoff publication", () => {
  it("publishes only after the real pending-create checkpoint is acknowledged (#10560)", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-final-handoff-"));
    vi.stubEnv("HOME", tempHome);
    vi.resetModules();
    try {
      const registry = await import("../../state/registry");
      const lifecycleGeneration = "generation-1";
      const liveIdentityFingerprint = "a".repeat(64);
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
      };
      registry.recordPendingSandboxCreateIdentity(createReservation, checkpoint);
      const persist = (
        next: PendingSandboxCreateIdentity,
        expected: PendingSandboxCreateIdentity,
      ) => {
        registry.recordPendingSandboxCreateIdentity(createReservation, next, { expected });
      };
      checkpoint = persistExactFinalHandoffCommitStarted({ checkpoint, persist });
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
        allowManagedBootstrapNotReady: false,
        allowNotReadyWithMatchingIdentity: () =>
          registry.getSandbox("alpha")?.pendingCreateIdentity?.exactFinalHandoffAcknowledged ===
          true,
        sandboxGpuEnabled: false,
        createdLifecycle: lifecycle,
        getRecordedRegistration: () => ({
          lifecycleGeneration,
          lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
        }),
        createRegistration: (({ createdLifecycle }) =>
          async () => {
            createdLifecycle.revalidate(createdLifecycle.capture({ lifecycleGeneration }));
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
          }) as typeof createOnboardCreatedSandboxRegistration,
        registration: {
          completion: {} as never,
          cleanupBuildContext: vi.fn(),
          manageDashboard: false,
          sandboxGpuEnabled: false,
        },
      });

      await expect(completeRegistration({} as never, null)).rejects.toThrow(/not report it Ready/u);
      expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toEqual(checkpoint);

      checkpoint = persistRecoveredFinalHandoffAcknowledgement({ checkpoint, persist });
      expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toEqual(checkpoint);
      await expect(completeRegistration({} as never, null)).resolves.toBeUndefined();
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
