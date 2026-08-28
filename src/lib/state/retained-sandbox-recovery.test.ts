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

const recoveryAuthority = {
  createAttemptNonce: "c".repeat(62),
  policyCreationReceipt: null,
} as const;

describe("retained sandbox recovery state", () => {
  it("persists verified identity independently", async () => {
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
      reason: "cancelled_after_sandbox_creation",
      recordedAt: "2026-08-27T00:00:00.000Z",
    } as const;

    const recorded = recovery.recordRetainedSandboxRecovery(input);

    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
    expect(recorded).toMatchObject({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      verifiedEffectivePolicyIdentity: input.verifiedEffectivePolicyIdentity,
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
      reason: "retained_after_sandbox_creation_failure",
    });

    expect(recorded).toMatchObject({
      sandboxIdentityFingerprint: null,
      lifecycleGeneration: null,
    });
  });

  it("rejects a recovery target outside the canonical sandbox-name contract", async () => {
    const recovery = await import("./onboard-session");

    expect(() =>
      recovery.recordRetainedSandboxRecovery({
        sandboxName: "1sandbox",
        sandboxIdentityFingerprint: "a".repeat(64),
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "00000000-0000-4000-8000-000000000001",
        verifiedEffectivePolicyIdentity: null,
        ...recoveryAuthority,
        reason: "retained_after_sandbox_creation_failure",
      }),
    ).toThrow("Cannot persist invalid retained sandbox recovery evidence");
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

  it("retires only the exact retained recovery record after verified cleanup (#10547)", async () => {
    const recovery = await import("./onboard-session");
    const fingerprint = "b".repeat(64);
    const recorded = recovery.recordRetainedSandboxRecovery({
      sandboxName: "retained-sb",
      sandboxIdentityFingerprint: fingerprint,
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      lifecycleGeneration: "generation-1",
      verifiedEffectivePolicyIdentity: null,
      ...recoveryAuthority,
      reason: "cancelled_after_sandbox_creation",
    });

    expect(() =>
      recovery.resolveRetainedSandboxRecovery({
        ...recorded,
        sandboxIdentityFingerprint: "d".repeat(64),
      }),
    ).toThrow(/changed before cleanup completed/u);
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);

    expect(recovery.resolveRetainedSandboxRecovery(recorded)).toBe(true);
    expect(recovery.resolveRetainedSandboxRecovery(recorded)).toBe(false);
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([]);
  });

  it("releases the matching recovery-only onboarding session after cleanup (#10547)", async () => {
    const recovery = await import("./onboard-session");
    recovery.markRetainedSandboxRecovery(
      "retained-sb",
      "Sandbox creation failed after identity verification.",
      "b".repeat(64),
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        verifiedEffectivePolicyIdentity: null,
        ...recoveryAuthority,
      },
    );
    const [recorded] = recovery.listRetainedSandboxRecoveryRecords();

    expect(() =>
      recovery.resolveRetainedSandboxRecovery({
        ...recorded!,
        reason: "cancelled_after_sandbox_creation",
      }),
    ).toThrow(/changed before cleanup completed/u);
    expect(recovery.loadSession()).toMatchObject({
      status: "recovery_required",
      sandboxName: "retained-sb",
    });

    expect(recovery.resolveRetainedSandboxRecovery(recorded!)).toBe(true);

    expect(recovery.loadSession()).toMatchObject({
      status: "failed",
      resumable: false,
      sandboxName: null,
      cancellationRecovery: null,
    });
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([]);
  });

  it("keeps the exact record when retirement fails after session release (#10547)", async () => {
    const recovery = await import("./onboard-session");
    recovery.markRetainedSandboxRecovery(
      "retained-sb",
      "Sandbox creation failed after identity verification.",
      "b".repeat(64),
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        verifiedEffectivePolicyIdentity: null,
        ...recoveryAuthority,
      },
    );
    const [recorded] = recovery.listRetainedSandboxRecoveryRecords();
    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      String(destination) === recovery.RETAINED_SANDBOX_RECOVERY_FILE
        ? (() => {
            throw new Error("simulated recovery retirement write failure");
          })()
        : renameSync(source, destination),
    );

    expect(() => recovery.resolveRetainedSandboxRecovery(recorded!)).toThrow(
      /simulated recovery retirement write failure/u,
    );
    expect(recovery.loadSession()).toMatchObject({
      status: "failed",
      resumable: false,
      sandboxName: null,
      cancellationRecovery: null,
    });
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
  });

  it("preserves the exact record when recovery-only session release cannot be written (#10547)", async () => {
    const recovery = await import("./onboard-session");
    recovery.markRetainedSandboxRecovery(
      "retained-sb",
      "Sandbox creation failed after identity verification.",
      "b".repeat(64),
      {
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        lifecycleGeneration: "generation-1",
        verifiedEffectivePolicyIdentity: null,
        ...recoveryAuthority,
      },
    );
    const [recorded] = recovery.listRetainedSandboxRecoveryRecords();
    const renameSync = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) =>
      String(destination) === recovery.SESSION_FILE
        ? (() => {
            throw new Error("simulated recovery session release write failure");
          })()
        : renameSync(source, destination),
    );

    expect(() => recovery.resolveRetainedSandboxRecovery(recorded!)).toThrow(
      /simulated recovery session release write failure/u,
    );
    expect(recovery.loadSession()).toMatchObject({
      status: "recovery_required",
      sandboxName: "retained-sb",
    });
    expect(recovery.listRetainedSandboxRecoveryRecords()).toEqual([recorded]);
  });
});
