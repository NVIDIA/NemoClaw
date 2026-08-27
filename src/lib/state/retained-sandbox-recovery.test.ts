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
const recoveryAuthority = {
  createAttemptNonce: "c".repeat(62),
  policyCreationReceipt: null,
} as const;

describe("retained sandbox recovery state", () => {
  it("persists verified identity and secret-free resource evidence independently", async () => {
    const recovery = await import("./onboard-session");
    const fingerprint = "a".repeat(64);
    const input = {
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
      verifiedEffectivePolicyIdentity: { hash: "sha256:policy-1", activeVersion: 1 },
      ...recoveryAuthority,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
      recordedAt: "2026-08-27T00:00:00.000Z",
    } as const;

    const recorded = recovery.recordRetainedSandboxRecovery(input);

    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
    expect(recorded).toMatchObject({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      identityWasUnavailable: false,
      verifiedEffectivePolicyIdentity: input.verifiedEffectivePolicyIdentity,
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
      verifiedEffectivePolicyIdentity: null,
      ...recoveryAuthority,
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

  it("preserves distinct unresolved lifecycle tuples for one sandbox name (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const first = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "1".repeat(64),
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
      verifiedEffectivePolicyIdentity: { hash: "sha256:policy-1", activeVersion: 1 },
      ...recoveryAuthority,
      resources: evidence,
      reason: "cancelled_after_sandbox_creation",
    });
    const second = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: "2".repeat(64),
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000002",
      verifiedEffectivePolicyIdentity: { hash: "sha256:policy-2", activeVersion: 2 },
      ...recoveryAuthority,
      resources: evidence,
      reason: "retained_after_sandbox_creation_failure",
    });

    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([first, second]);
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

  it("refuses a symbolic-link recovery state directory ancestor (#9833)", async () => {
    const externalStateDirectory = path.join(home, "external-state");
    fs.mkdirSync(externalStateDirectory);
    fs.symlinkSync(externalStateDirectory, path.join(home, ".nemoclaw"), "dir");
    const recovery = await import("./onboard-session");

    expect(() => recovery.listRetainedSandboxRecoveryRecords()).toThrow(/symbolic link/u);
  });

  it("refuses recovery publication after the locked state directory is replaced (#9833)", async () => {
    const recovery = await import("./onboard-session");
    expect(recovery.acquireOnboardLock("recovery directory replacement test").acquired).toBe(true);
    const originalDirectory = path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE);
    const displacedDirectory = `${originalDirectory}.displaced`;
    const replacementDirectory = path.join(home, "replacement-state");
    fs.renameSync(originalDirectory, displacedDirectory);
    fs.mkdirSync(replacementDirectory);
    fs.symlinkSync(replacementDirectory, originalDirectory, "dir");

    expect(() =>
      recovery.recordRetainedSandboxRecovery({
        sandboxName: "retained-sb",
        sandboxIdentityFingerprint: "f".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        verifiedEffectivePolicyIdentity: null,
        ...recoveryAuthority,
        resources: evidence,
        reason: "retained_after_sandbox_creation_failure",
      }),
    ).toThrow(/symbolic link|lock ownership changed/u);
    expect(fs.existsSync(path.join(replacementDirectory, "retained-sandbox-recovery.json"))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(displacedDirectory, "onboard.lock"))).toBe(true);
  });

  it("writes no recovery evidence after the state directory changes at temporary open (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const stateDirectory = path.dirname(recovery.RETAINED_SANDBOX_RECOVERY_FILE);
    const displacedDirectory = `${stateDirectory}.displaced`;
    const openSync = fs.openSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      !replaced &&
        path.basename(String(file)).startsWith(".retained-sandbox-recovery.") &&
        (() => {
          replaced = true;
          fs.renameSync(stateDirectory, displacedDirectory);
          fs.mkdirSync(stateDirectory, { mode: 0o700 });
        })();
      return openSync(file, flags, mode);
    });

    expect(() =>
      recovery.recordRetainedSandboxRecovery({
        sandboxName: "retained-sb",
        sandboxIdentityFingerprint: "f".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        verifiedEffectivePolicyIdentity: null,
        ...recoveryAuthority,
        resources: evidence,
        reason: "retained_after_sandbox_creation_failure",
      }),
    ).toThrow(/state directory changed|lock ownership changed/u);
    expect(replaced).toBe(true);
    expect(
      fs
        .readdirSync(stateDirectory)
        .map((name) => fs.statSync(path.join(stateDirectory, name)).size)
        .filter((size) => size > 0),
    ).toEqual([]);
  });

  it("writes no session evidence after the state directory changes at temporary open (#9833)", async () => {
    const recovery = await import("./onboard-session");
    const stateDirectory = path.dirname(recovery.SESSION_FILE);
    const displacedDirectory = `${stateDirectory}.displaced`;
    const openSync = fs.openSync.bind(fs);
    let replaced = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      !replaced &&
        path.basename(String(file)).startsWith(".onboard-session.") &&
        (() => {
          replaced = true;
          fs.renameSync(stateDirectory, displacedDirectory);
          fs.mkdirSync(stateDirectory, { mode: 0o700 });
        })();
      return openSync(file, flags, mode);
    });

    expect(() =>
      recovery.markRetainedSandboxRecovery(
        "retained-sb",
        "Sandbox creation failed after identity verification.",
        "f".repeat(64),
        {
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          lifecycleGeneration: "generation-1",
          verifiedEffectivePolicyIdentity: null,
          ...recoveryAuthority,
        },
      ),
    ).toThrow(/state directory changed|lock ownership changed/u);
    expect(replaced).toBe(true);
    expect(
      fs
        .readdirSync(stateDirectory)
        .map((name) => fs.statSync(path.join(stateDirectory, name)).size)
        .filter((size) => size > 0),
    ).toEqual([]);
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
      verifiedEffectivePolicyIdentity: null,
      ...recoveryAuthority,
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

});
