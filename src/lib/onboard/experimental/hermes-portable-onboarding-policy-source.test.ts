// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as openshellRuntimeModule from "../../adapters/openshell/runtime";
import {
  createHermesPortableTestInput,
  createHermesPortableTransactionFixture,
  HERMES_PORTABLE_TEST_LIVE_IDENTITY,
  HERMES_PORTABLE_TEST_POLICY,
  hermesPortableReservationForOnboarding,
} from "../../../../test/helpers/hermes-portable-onboarding-fixture";
import type { SandboxEntry } from "../../state/registry";
import {
  pendingSandboxPolicyVerificationForBoundary,
  revalidateCreatedSandboxPolicyRegistration,
  type CreatedSandboxPolicyRegistrationInput,
} from "../sandbox-create/policy-creation-receipt";
import {
  runSandboxCreateWithPolicyAuthorityChecks,
  verifyCreatedSandboxEffectivePolicy,
  type EffectiveVerifiedSandboxPolicyBoundary,
} from "../sandbox-create/orchestration";
import {
  runHermesPortableOnboardCreate,
  runHermesPortableOnboardingTransaction,
} from "./hermes-portable-onboarding";
import type { SelectedDockerGpuRoute } from "../docker-gpu-route";

const GATEWAY_PORT = 8080;
const LIFECYCLE_GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
type CreatedPolicyIdentity = { readonly route: SelectedDockerGpuRoute };
let stateDir: string;
let policyPath: string;

function gatewayInfo(): { status: number; output: string; stdout: string; stderr: string } {
  const output = `Gateway endpoint: http://127.0.0.1:${GATEWAY_PORT}\n`;
  return { status: 0, output, stdout: output, stderr: "" };
}

function metadata(): { status: number; output: string; stdout: string; stderr: string } {
  const stdout = JSON.stringify({
    scope: "sandbox",
    sandbox: "alpha",
    status: "effective",
    policy_source: "sandbox",
    active_version: 4,
    hash: "sha256:effective",
    policy: { version: 1 },
  });
  return { status: 0, output: stdout, stdout, stderr: "" };
}

function captureResult(status = 0) {
  return { status, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
}

function checkpointFor(
  input: ReturnType<typeof createHermesPortableTestInput>,
  liveIdentityFingerprint = HERMES_PORTABLE_TEST_LIVE_IDENTITY,
) {
  const policyCreationReceipt = {
    schemaVersion: 1 as const,
    origin: "sandbox-create" as const,
    gatewayName: input.gatewayName,
    gatewayPort: GATEWAY_PORT,
    sandboxName: input.sandboxName,
    lifecycleGeneration: input.lifecycleGeneration,
    sandboxIdentityFingerprint: liveIdentityFingerprint,
    policyHash: "sha256:effective",
    policyVersion: 4,
  };
  return pendingSandboxPolicyVerificationForBoundary({
    registration: {
      policyAuthority: "nemoclaw-managed" as const,
      policyCreationReceipt,
      observedPolicyAuthority: "owner-unknown" as const,
    },
    sandboxName: input.sandboxName,
    gatewayName: input.gatewayName,
    gatewayPort: GATEWAY_PORT,
    lifecycleGeneration: input.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: liveIdentityFingerprint,
    route: "none" as const,
  });
}

function checkpointEntry(
  input: ReturnType<typeof createHermesPortableTestInput>,
  checkpoint: ReturnType<typeof checkpointFor>,
): SandboxEntry {
  return {
    ...hermesPortableReservationForOnboarding(input),
    gatewayPort: checkpoint.gatewayPort,
    lifecycleGeneration: checkpoint.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: checkpoint.sandboxIdentityFingerprint,
    pendingPolicyVerification: checkpoint,
  };
}

function policyRegistrationInput(boundary: EffectiveVerifiedSandboxPolicyBoundary): Omit<
  CreatedSandboxPolicyRegistrationInput,
  "plannedAuthority"
> & {
  readonly registration: EffectiveVerifiedSandboxPolicyBoundary["registration"];
} {
  return {
    sandboxName: boundary.sandboxName,
    gatewayName: boundary.gatewayName,
    gatewayPort: boundary.gatewayPort,
    lifecycleGeneration: boundary.lifecycleGeneration,
    lifecycleLiveIdentityFingerprint: boundary.lifecycleLiveIdentityFingerprint,
    policySourcePath: boundary.policySourcePath,
    route: boundary.route,
    operation: "continue composed Hermes Portable onboarding",
    registration: boundary.registration,
  };
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-policy-source-"));
  policyPath = path.join(stateDir, "create.yaml");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("Hermes portable create policy source", () => {
  it("carries the receipt-owned source through the generic create gate (#10423)", async () => {
    fs.writeFileSync(
      policyPath,
      `version: 1
network_policies:
  temporary-only:
    name: temporary-only
    endpoints:
      - host: temporary.example
        port: 443
`,
      { mode: 0o600 },
    );
    const current = {
      ...createHermesPortableTestInput(stateDir, policyPath),
      lifecycleGeneration: LIFECYCLE_GENERATION,
      createPolicySourceBytes: Buffer.from(HERMES_PORTABLE_TEST_POLICY),
    };
    vi.spyOn(openshellRuntimeModule, "captureResolvedOpenshell")
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce({
        status: 0,
        output: HERMES_PORTABLE_TEST_POLICY,
        stdout: HERMES_PORTABLE_TEST_POLICY,
        stderr: "",
      })
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce(gatewayInfo())
      .mockReturnValueOnce(metadata())
      .mockReturnValueOnce(metadata());
    const readFile = vi.spyOn(fs, "readFileSync");
    let routeFallbackCalls = 0;
    let verifiedCreateEffectCalls = 0;
    let createSandboxCalls = 0;
    let recordedCheckpointEntry: SandboxEntry | null = null;
    let updateRegistry: (name: string, updates: Partial<SandboxEntry>) => boolean;
    const persistedPolicySources: string[] = [];
    const routeFallback = () => {
      routeFallbackCalls += 1;
      return policyPath;
    };
    const persistVerifiedPolicy = (boundary: EffectiveVerifiedSandboxPolicyBoundary) => {
      persistedPolicySources.push(boundary.policySourcePath);
      const checkpoint = pendingSandboxPolicyVerificationForBoundary(boundary);
      recordedCheckpointEntry = checkpointEntry(current, checkpoint);
      const { name, ...updates } = recordedCheckpointEntry;
      expect(updateRegistry(name, updates)).toBe(true);
    };
    const runVerifiedCreateEffects = async () => {
      verifiedCreateEffectCalls += 1;
    };
    const createSandbox = async (
      argv: readonly string[],
      _readyCapture: unknown,
      _readyRunner: unknown,
      _buildContextPath: string,
      effectivePolicySourcePath: string,
    ) => {
      createSandboxCalls += 1;
      const readCountBeforeVerification = readFile.mock.calls.length;
      const result = await runSandboxCreateWithPolicyAuthorityChecks<
        CreatedPolicyIdentity,
        EffectiveVerifiedSandboxPolicyBoundary,
        { ready: true }
      >({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          expect(fs.existsSync(policyPath)).toBe(false);
          expect(argv[argv.indexOf("--policy") + 1]).toBe(effectivePolicySourcePath);
          await verifyCreatedSandbox({ route: "none" as const });
          return { ready: true as const };
        },
        captureCreatedSandboxIdentity: () => HERMES_PORTABLE_TEST_LIVE_IDENTITY,
        revalidateCreatedSandboxIdentity: vi.fn(),
        verifyCreatedPolicy: (identity) =>
          verifyCreatedSandboxEffectivePolicy({
            sandboxName: "alpha",
            gatewayName: "nemoclaw",
            gatewayPort: GATEWAY_PORT,
            lifecycleGeneration: current.lifecycleGeneration,
            lifecycleLiveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
            route: identity.route,
            hermesPortable: true,
            effectivePolicySourcePath,
            policySourcePathForRoute: routeFallback,
            apfInterceptorRequested: false,
            plannedAuthority: "nemoclaw-managed",
            operation: "verify composed Hermes Portable policy",
          }),
        persistVerifiedPolicy: (_identity, _exactIdentity, boundary) => {
          persistVerifiedPolicy(boundary);
        },
        revalidateVerifiedPolicy: (_identity, _exactIdentity, boundary) => {
          expect(boundary.policySourcePath).toBe(effectivePolicySourcePath);
          revalidateCreatedSandboxPolicyRegistration(policyRegistrationInput(boundary));
        },
        runVerifiedCreateEffects,
        cleanupTemporarySources: vi.fn(),
      });
      const verifierReads = readFile.mock.calls
        .slice(readCountBeforeVerification)
        .map(([source]) => String(source));
      expect(verifierReads).toContain(effectivePolicySourcePath);
      expect(verifierReads).not.toContain(policyPath);
      expect(fs.readFileSync(effectivePolicySourcePath)).toEqual(
        Buffer.from(HERMES_PORTABLE_TEST_POLICY),
      );
      return result;
    };
    const captureOpenShell = vi.fn(() => captureResult());
    const fixture = createHermesPortableTransactionFixture(current, {
      createSandbox: (argv, buildContextPath, effectivePolicySourcePath) =>
        runHermesPortableOnboardCreate({
          argv,
          buildContextPath,
          effectivePolicySourcePath,
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          captureOpenShell,
          readyRunner: vi.fn(() => captureResult()),
          createSandbox,
        }),
      revalidatePendingCreateRegistry: () => {
        expect(recordedCheckpointEntry).not.toBeNull();
        return structuredClone(recordedCheckpointEntry!);
      },
    });
    updateRegistry = fixture.updateRegistry;

    const completed = await runHermesPortableOnboardingTransaction(current, fixture.value);

    expect(completed.active.receipt.phase).toBe("active");
    expect(persistedPolicySources).toEqual([expect.stringMatching(/policy\..+\.yaml$/u)]);
    expect(routeFallbackCalls).toBe(0);
    expect(verifiedCreateEffectCalls).toBe(1);
    expect(createSandboxCalls).toBe(1);
  });

  it("rejects a separately valid checkpoint replacement before configuration effects (#10423)", async () => {
    fs.writeFileSync(policyPath, HERMES_PORTABLE_TEST_POLICY, { mode: 0o600 });
    const current = {
      ...createHermesPortableTestInput(stateDir, policyPath),
      lifecycleGeneration: LIFECYCLE_GENERATION,
    };
    const expectedEntry = checkpointEntry(current, checkpointFor(current));
    const replacementEntry = checkpointEntry(current, checkpointFor(current, "b".repeat(64)));
    let updateRegistry: (name: string, updates: Partial<SandboxEntry>) => boolean;
    const fixture = createHermesPortableTransactionFixture(current, {
      createSandbox: async () => {
        const { name, ...updates } = replacementEntry;
        expect(updateRegistry(name, updates)).toBe(true);
        return { ready: true };
      },
      revalidatePendingCreateRegistry: () => structuredClone(expectedEntry),
    });
    updateRegistry = fixture.updateRegistry;

    await expect(runHermesPortableOnboardingTransaction(current, fixture.value)).rejects.toThrow(
      "verified create checkpoint changed during revalidation",
    );
    expect(fixture.events).not.toContain("restart-policy");
    expect(fixture.events).not.toContain("registry");
  });

  it("rejects a checkpoint without the current in-process revalidator before effects (#10423)", async () => {
    fs.writeFileSync(policyPath, HERMES_PORTABLE_TEST_POLICY, { mode: 0o600 });
    const current = {
      ...createHermesPortableTestInput(stateDir, policyPath),
      lifecycleGeneration: LIFECYCLE_GENERATION,
    };
    const recordedEntry = checkpointEntry(current, checkpointFor(current));
    let updateRegistry: (name: string, updates: Partial<SandboxEntry>) => boolean;
    const fixture = createHermesPortableTransactionFixture(current, {
      createSandbox: async () => {
        const { name, ...updates } = recordedEntry;
        expect(updateRegistry(name, updates)).toBe(true);
        return { ready: true };
      },
    });
    updateRegistry = fixture.updateRegistry;

    await expect(runHermesPortableOnboardingTransaction(current, fixture.value)).rejects.toThrow(
      "verified create checkpoint lacks current transaction authority",
    );
    expect(fixture.events).not.toContain("restart-policy");
    expect(fixture.events).not.toContain("registry");
  });

  it("rejects a source and argv mismatch before the generic create gate (#10423)", async () => {
    let createSandboxCalls = 0;
    const createSandbox = async () => {
      createSandboxCalls += 1;
      return { ready: true as const };
    };

    expect(() =>
      runHermesPortableOnboardCreate({
        argv: ["openshell", "sandbox", "create", "--policy", "/temporary.yaml"],
        buildContextPath: "/build",
        effectivePolicySourcePath: "/durable.yaml",
        sandboxName: "alpha",
        gatewayName: "nemoclaw",
        captureOpenShell: vi.fn(() => captureResult()),
        readyRunner: vi.fn(() => captureResult()),
        createSandbox,
      }),
    ).toThrow("policy option does not name the captured source");
    expect(createSandboxCalls).toBe(0);
  });

  it("rejects a compatibility result before policy persistence or effects (#10423)", async () => {
    let persistVerifiedPolicyCalls = 0;
    let verifiedCreateEffectCalls = 0;
    let routeFallbackCalls = 0;
    const routeFallback = () => {
      routeFallbackCalls += 1;
      return policyPath;
    };

    await expect(
      runSandboxCreateWithPolicyAuthorityChecks<
        CreatedPolicyIdentity,
        EffectiveVerifiedSandboxPolicyBoundary,
        string
      >({
        sandboxName: "alpha",
        revalidate: vi.fn(),
        create: async (verifyCreatedSandbox) => {
          await verifyCreatedSandbox({ route: "compatibility" as const });
          return "created";
        },
        captureCreatedSandboxIdentity: () => HERMES_PORTABLE_TEST_LIVE_IDENTITY,
        revalidateCreatedSandboxIdentity: vi.fn(),
        verifyCreatedPolicy: (identity) =>
          verifyCreatedSandboxEffectivePolicy({
            sandboxName: "alpha",
            gatewayName: "nemoclaw",
            gatewayPort: GATEWAY_PORT,
            lifecycleGeneration: "generation-1",
            lifecycleLiveIdentityFingerprint: HERMES_PORTABLE_TEST_LIVE_IDENTITY,
            route: identity.route,
            hermesPortable: true,
            effectivePolicySourcePath: "/durable.yaml",
            policySourcePathForRoute: routeFallback,
            apfInterceptorRequested: false,
            plannedAuthority: "nemoclaw-managed",
            operation: "verify incompatible Hermes Portable policy",
          }),
        persistVerifiedPolicy: () => {
          persistVerifiedPolicyCalls += 1;
        },
        revalidateVerifiedPolicy: vi.fn(),
        runVerifiedCreateEffects: async () => {
          verifiedCreateEffectCalls += 1;
        },
        cleanupTemporarySources: vi.fn(),
      }),
    ).rejects.toThrow("automatic sandbox cleanup was not safe");
    expect(routeFallbackCalls).toBe(0);
    expect(persistVerifiedPolicyCalls).toBe(0);
    expect(verifiedCreateEffectCalls).toBe(0);
  });
});
