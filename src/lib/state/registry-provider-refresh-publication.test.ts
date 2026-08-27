// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingSandboxPolicyVerification, SandboxEntry } from "./registry/types";

const ROUTE = {
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

const AUTHORITY = {
  sandboxName: "alpha",
  gatewayName: "nemoclaw",
  sessionId: "session-owner",
  selection: ROUTE,
} as const;

function managedCheckpoint(
  phase: "attaching" | "ready" = "attaching",
): PendingSandboxPolicyVerification {
  const gatewayPort = 8080;
  const lifecycleGeneration = "123e4567-e89b-42d3-a456-426614174983";
  const sandboxIdentityFingerprint = "a".repeat(64);
  const policyHash = "sha256:policy-1";
  const policyVersion = 1;
  return {
    schemaVersion: 1,
    state: "verified-create",
    policyAuthority: "nemoclaw-managed",
    observedPolicyAuthority: "owner-unknown",
    gatewayName: AUTHORITY.gatewayName,
    gatewayPort,
    sandboxName: AUTHORITY.sandboxName,
    lifecycleGeneration,
    sandboxIdentityFingerprint,
    route: "none",
    policyHash,
    policyVersion,
    policyCreationReceipt: {
      schemaVersion: 1,
      origin: "sandbox-create",
      gatewayName: AUTHORITY.gatewayName,
      gatewayPort,
      sandboxName: AUTHORITY.sandboxName,
      lifecycleGeneration,
      sandboxIdentityFingerprint,
      policyHash,
      policyVersion,
    },
    providerRefresh: {
      schemaVersion: 1,
      phase,
      attachedProviders: ["alpha-telegram"],
    },
  };
}

function completedEntry(checkpoint: PendingSandboxPolicyVerification): SandboxEntry {
  return {
    name: AUTHORITY.sandboxName,
    ...ROUTE,
    agent: "hermes",
    openshellDriver: "docker",
    gatewayName: AUTHORITY.gatewayName,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    policyAuthority: checkpoint.policyAuthority,
    policyCreationReceipt: checkpoint.policyCreationReceipt,
  };
}

describe("sandbox provider refresh publication", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("publishes a staged registration only after its provider refresh reaches ready (#10153)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-provider-publication-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute(AUTHORITY.sandboxName, {
        ...ROUTE,
        gatewayName: AUTHORITY.gatewayName,
        reservationSessionId: AUTHORITY.sessionId,
      });
      const routeDisposition = registry.classifySandboxInferenceRouteReservation(
        AUTHORITY,
        registry.getSandbox(AUTHORITY.sandboxName),
      );
      expect(routeDisposition.kind).toBe("owned");
      const route = (
        routeDisposition as Extract<typeof routeDisposition, { readonly kind: "owned" }>
      ).reservation;
      const create = registry.qualifyPendingSandboxCreateReservation(
        AUTHORITY,
        registry.getSandbox(AUTHORITY.sandboxName),
      );
      const attaching = managedCheckpoint();
      registry.recordPendingSandboxPolicyVerification(create, attaching);

      const staged = registry.registerSandbox(completedEntry(attaching), route, {
        pending: true,
        reservationSessionId: create.authority.sessionId,
        verifiedCreate: { reservation: create, checkpoint: attaching },
      });
      expect(staged).toMatchObject({
        pendingRouteReservation: true,
        pendingRegistrationPublication: true,
        pendingPolicyVerification: attaching,
      });
      expect(staged).not.toHaveProperty("policyAuthority");
      expect(registry.getDefault()).toBeNull();
      expect(registry.updateSandbox("alpha", { dashboardPort: 18791 })).toBe(true);
      expect(() => registry.updateSandbox("alpha", { policies: ["telegram"] })).toThrow(
        /checkpoint is incomplete/u,
      );

      const ready = registry.advancePendingSandboxProviderRefresh(
        "alpha",
        create.authority.sessionId,
        attaching,
        {
          schemaVersion: 1,
          phase: "ready",
          attachedProviders: ["alpha-telegram"],
        },
      );
      const published = registry.publishPendingSandboxProviderRefresh(
        "alpha",
        create.authority.sessionId,
        ready,
      );

      expect(published).toMatchObject({
        name: "alpha",
        policyAuthority: "nemoclaw-managed",
      });
      expect(published).not.toHaveProperty("pendingPolicyVerification");
      expect(published).not.toHaveProperty("pendingRegistrationPublication");
      expect(published.pendingRouteReservation).toBeUndefined();
      expect(registry.getDefault()).toBe("alpha");
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("rejects pending registration after provider refresh is already ready (#10153)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-provider-ready-pending-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("./registry");
      registry.reserveSandboxInferenceRoute(AUTHORITY.sandboxName, {
        ...ROUTE,
        gatewayName: AUTHORITY.gatewayName,
        reservationSessionId: AUTHORITY.sessionId,
      });
      const routeDisposition = registry.classifySandboxInferenceRouteReservation(
        AUTHORITY,
        registry.getSandbox(AUTHORITY.sandboxName),
      );
      expect(routeDisposition.kind).toBe("owned");
      const route = (
        routeDisposition as Extract<typeof routeDisposition, { readonly kind: "owned" }>
      ).reservation;
      const create = registry.qualifyPendingSandboxCreateReservation(
        AUTHORITY,
        registry.getSandbox(AUTHORITY.sandboxName),
      );
      const ready = managedCheckpoint("ready");
      registry.recordPendingSandboxPolicyVerification(create, ready);

      expect(() =>
        registry.registerSandbox(completedEntry(ready), route, {
          pending: true,
          reservationSessionId: create.authority.sessionId,
          verifiedCreate: { reservation: create, checkpoint: ready },
        }),
      ).toThrow(/Cannot attach NemoClaw policy ownership to a pending sandbox registration/u);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
