// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retained-recovery-"));
  vi.stubEnv("HOME", home);
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const evidence = {
  sharedInferenceProviders: ["nvidia"],
  sandboxScopedProviders: ["sandbox-telegram"],
  credentialEnvironmentVariables: ["NVIDIA_API_KEY", "TELEGRAM_BOT_TOKEN"],
} as const;

describe("retained sandbox recovery state", () => {
  it("persists verified identity and secret-free resource evidence independently", async () => {
    const recovery = await import("./onboard-session");
    const fingerprint = "a".repeat(64);

    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
      recordedAt: "2026-08-27T00:00:00.000Z",
    });

    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
    expect(recorded).toMatchObject({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      identityWasUnavailable: false,
      resources: evidence,
    });
    expect(fs.readFileSync(recovery.RETAINED_SANDBOX_RECOVERY_FILE, "utf8")).not.toContain(
      "secret-value",
    );
  });

  it("records an explicit missing identity", async () => {
    const recovery = await import("./onboard-session");

    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "missing-id",
      sandboxIdentityFingerprint: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: null,
      resources: {
        sharedInferenceProviders: [],
        sandboxScopedProviders: [],
        credentialEnvironmentVariables: [],
      },
      reason: "retained_after_sandbox_creation_failure",
    });

    expect(recorded).toMatchObject({
      sandboxIdentityFingerprint: null,
      identityWasUnavailable: true,
      lifecycleGeneration: null,
    });
  });

  it("clears only after a durable exact-identity administrator receipt", async () => {
    const recovery = await import("./onboard-session");
    const fingerprint = "b".repeat(64);
    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
    });

    expect(() =>
      recovery.resolveRetainedSandboxRecovery({
        recordId: recorded.recordId,
        receiptId: "c".repeat(64),
        sandboxName: recorded.sandboxName,
        sandboxIdentityFingerprint: "d".repeat(64),
        gatewayName: recorded.gatewayName,
        gatewayPort: recorded.gatewayPort,
        outcome: "removed_verified_identity",
      }),
    ).toThrow(/does not match retained sandbox identity/u);
    expect(recovery.listRetainedSandboxRecoveryRecords()).toHaveLength(1);

    const receipt = recovery.resolveRetainedSandboxRecovery({
      recordId: recorded.recordId,
      receiptId: "c".repeat(64),
      sandboxName: recorded.sandboxName,
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: recorded.gatewayName,
      gatewayPort: recorded.gatewayPort,
      outcome: "removed_verified_identity",
    });

    expect(receipt.recordId).toBe(recorded.recordId);
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([]);
  });
});
