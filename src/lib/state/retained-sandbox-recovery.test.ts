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

  it("refuses a symbolic-link recovery state without reading its target", async () => {
    const recovery = await import("./onboard-session");
    const externalState = path.join(home, "external-recovery.json");
    const externalContents = "{not recovery json";
    fs.writeFileSync(externalState, externalContents);
    fs.mkdirSync(path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE), { recursive: true });
    fs.symlinkSync(externalState, recovery.RETAINED_SANDBOX_RECOVERY_FILE);

    expect(() => recovery.listRetainedSandboxRecoveryRecords()).toThrow(/symbolic link/u);
    expect(fs.readFileSync(externalState, "utf8")).toBe(externalContents);
  });

  it("does not expose a caller-supplied recovery resolution path (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const recoveryStore = await import("./onboard-session/retained-sandbox-recovery");
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
    const unsupportedClear = (recovery as unknown as Record<string, unknown>)[
      "resolveRetainedSandboxRecovery"
    ];
    (unsupportedClear as undefined | ((input: Record<string, unknown>) => unknown))?.({
      recordId: recorded.recordId,
      receiptId: "c".repeat(64),
      sandboxName: recorded.sandboxName,
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: recorded.gatewayName,
      gatewayPort: recorded.gatewayPort,
      outcome: "removed_verified_identity",
    });

    expect(unsupportedClear).toBeUndefined();
    expect(
      (recoveryStore as unknown as Record<string, unknown>)["resolveRetainedSandboxRecovery"],
    ).toBeUndefined();
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
  });

  it("preserves legacy resolution evidence while recording new recovery state (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "legacy-sb",
      sandboxIdentityFingerprint: "d".repeat(64),
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "legacy-generation",
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
    });
    const legacyResolution = {
      schemaVersion: 1,
      receiptId: "e".repeat(64),
      recordId: recorded.recordId,
      sandboxName: recorded.sandboxName,
      sandboxIdentityFingerprint: recorded.sandboxIdentityFingerprint,
      gatewayName: recorded.gatewayName,
      gatewayPort: recorded.gatewayPort,
      outcome: "removed_verified_identity",
      resolvedAt: "2026-08-27T00:00:00.000Z",
    };
    const legacyState = JSON.parse(
      fs.readFileSync(recovery.RETAINED_SANDBOX_RECOVERY_FILE, "utf8"),
    );
    legacyState.unresolved = [];
    legacyState.resolutions = [legacyResolution];
    fs.writeFileSync(recovery.RETAINED_SANDBOX_RECOVERY_FILE, JSON.stringify(legacyState));

    recovery.recordRetainedSandboxRecovery({
      sandboxName: "new-sb",
      sandboxIdentityFingerprint: null,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: null,
      resources: evidence,
      reason: "retained_after_sandbox_creation_failure",
    });

    const durableState = JSON.parse(
      fs.readFileSync(recovery.RETAINED_SANDBOX_RECOVERY_FILE, "utf8"),
    );
    expect(durableState.resolutions).toEqual([legacyResolution]);
  });
});
