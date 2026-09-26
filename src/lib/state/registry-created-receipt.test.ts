// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PendingSandboxCreateIdentity, SandboxEntry } from "./registry/types";

const routeSelection = {
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
  selection: routeSelection,
} as const;
const managedCheckpoint = (): PendingSandboxCreateIdentity => ({
  schemaVersion: 1,
  state: "verified-create",
  gatewayName: authority.gatewayName,
  gatewayPort: 8080,
  sandboxName: authority.sandboxName,
  lifecycleGeneration: "123e4567-e89b-42d3-a456-426614174983",
  sandboxIdentityFingerprint: "a".repeat(64),
  route: "none",
});
function reserveCreate(registry: typeof import("./registry")) {
  registry.reserveSandboxInferenceRoute(authority.sandboxName, {
    ...routeSelection,
    gatewayName: authority.gatewayName,
    reservationSessionId: authority.sessionId,
  });
  const entry = registry.getSandbox(authority.sandboxName);
  const route = registry.classifySandboxInferenceRouteReservation(authority, entry);
  expect(route.kind).toBe("owned");
  return {
    create: registry.qualifyPendingSandboxCreateReservation(authority, entry),
    route: (route as Extract<typeof route, { kind: "owned" }>).reservation,
  };
}
function completedEntry(checkpoint: PendingSandboxCreateIdentity): SandboxEntry {
  return {
    name: authority.sandboxName,
    ...routeSelection,
    agent: "hermes",
    openshellDriver: "docker",
    gatewayName: authority.gatewayName,
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
  };
}
async function withRegistry(run: (registry: typeof import("./registry")) => void): Promise<void> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-create-receipt-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
  try {
    run(await import("./registry"));
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

describe("created sandbox identity receipts", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("promotes an exact created-but-unverified checkpoint before registration (#12290)", async () => {
    await withRegistry((registry) => {
      const { route, create } = reserveCreate(registry);
      const unverified = {
        ...managedCheckpoint(),
        state: "created-unverified" as const,
        managedBootstrapIdentity: "b".repeat(64),
      };
      registry.recordPendingSandboxCreateIdentity(create, unverified);
      expect(() =>
        registry.registerSandbox(completedEntry(unverified), route, {
          verifiedCreate: { reservation: create, checkpoint: unverified },
        }),
      ).toThrow(/before its create identity is verified/u);
      const verified = { ...unverified, state: "verified-create" as const };
      expect(
        registry.recordPendingSandboxCreateIdentity(create, verified, { expected: unverified }),
      ).toMatchObject({ pendingCreateIdentity: verified });
    });
  });

  it.each([
    ["sandbox identity fingerprint", { sandboxIdentityFingerprint: "b".repeat(64) }],
    ["create-attempt nonce", { createAttemptNonce: "c".repeat(62) }],
    ["route", { route: "native" as const }],
    ["managed bootstrap identity", { managedBootstrapIdentity: "d".repeat(64) }],
  ])(
    "refuses created-but-unverified promotion when the %s changes (#12290)",
    async (_field, changed) => {
      await withRegistry((registry) => {
        const { create } = reserveCreate(registry);
        const unverified = {
          ...managedCheckpoint(),
          state: "created-unverified" as const,
          createAttemptNonce: "e".repeat(62),
          managedBootstrapIdentity: "f".repeat(64),
        };
        registry.recordPendingSandboxCreateIdentity(create, unverified);
        expect(() =>
          registry.recordPendingSandboxCreateIdentity(
            create,
            { ...unverified, ...changed, state: "verified-create" },
            { expected: unverified },
          ),
        ).toThrow(/exact immutable receipt/u);
        expect(registry.getSandbox("alpha")?.pendingCreateIdentity).toEqual(unverified);
      });
    },
  );

  it("allows a new route reservation after a created receipt is removed (#12290)", async () => {
    await withRegistry((registry) => {
      const { create } = reserveCreate(registry);
      const unverified = { ...managedCheckpoint(), state: "created-unverified" as const };
      registry.recordPendingSandboxCreateIdentity(create, unverified);
      expect(registry.removeSandbox("alpha")).toBe(true);
      expect(
        registry.reserveSandboxInferenceRoute("alpha", {
          ...routeSelection,
          gatewayName: authority.gatewayName,
          reservationSessionId: "replacement-session",
        }),
      ).toBe(true);
    });
  });
});
