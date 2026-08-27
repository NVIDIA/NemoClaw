// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import type {
  RuntimeProviderNativeArtifactBootstrapInput,
  RuntimeProviderNativeArtifactBootstrapOperations,
  RuntimeProviderNativeArtifactBootstrapPlan,
  RuntimeProviderNativeArtifactReadinessEvidence,
  RuntimeProviderNativeArtifactBootstrapSurface,
} from "./contract";
import { createMxcRuntimeProviderBundle } from "./mxc";

const NATIVE_RECEIPT = nativeArtifactWorkloadReceiptFixture(
  encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
);
const LIFECYCLE_GENERATION = "generation-7";
const SHARE_DIRECTORY = `C:\\nemoclaw-alpha-${createHash("sha256")
  .update(LIFECYCLE_GENERATION, "utf8")
  .digest("hex")
  .slice(0, 12)}`;

function bootstrapInput(): RuntimeProviderNativeArtifactBootstrapInput {
  return {
    providerId: "mxc",
    sandboxName: "alpha",
    lifecycleGeneration: LIFECYCLE_GENERATION,
    driveRoot: "C:\\",
    artifactRoot: "C:\\openclaw-2026-7-1",
    workload: {
      ...NATIVE_RECEIPT,
      launch: {
        ...NATIVE_RECEIPT.launch,
        environmentNames: [
          "HOME",
          "OPENCLAW_CONFIG_PATH",
          "OPENCLAW_HOME",
          "OPENCLAW_STATE_DIR",
          "PATH",
          "TEMP",
          "TMP",
          "USERPROFILE",
        ],
      },
    },
  };
}

function nativeBootstrap(
  operations: Omit<RuntimeProviderNativeArtifactBootstrapOperations, "recoverCreate"> &
    Partial<Pick<RuntimeProviderNativeArtifactBootstrapOperations, "recoverCreate">>,
) {
  const surface = createMxcRuntimeProviderBundle({
    hostFacts: {
      platform: "win32",
      nativeArchitecture: "x64",
      release: "10.0.28120",
    },
    bootstrapControlPlane: {
      contractVersion: 1,
      providerId: "mxc",
      recoverCreate: async (plan) => ({
        status: "retained",
        authoritySha256: plan.authoritySha256,
        providerHandle: plan.providerHandle,
        sandboxName: plan.sandboxName,
        lifecycleGeneration: plan.lifecycleGeneration,
      }),
      ...operations,
    },
  }).bootstrap;
  expect(surface).toMatchObject({ supported: true, bootstrapKind: "native-artifact" });
  return surface as RuntimeProviderNativeArtifactBootstrapSurface;
}

function readyEvidence(
  plan: RuntimeProviderNativeArtifactBootstrapPlan,
): RuntimeProviderNativeArtifactReadinessEvidence {
  return {
    authoritySha256: plan.authoritySha256,
    providerHandle: plan.providerHandle,
    sandboxName: plan.sandboxName,
    lifecycleGeneration: plan.lifecycleGeneration,
    artifactDigest: plan.workload.artifact.digest,
    executableDigest: plan.workload.launch.executable.digest,
    ready: true,
  };
}

function verifiedCreateOutcome(plan: RuntimeProviderNativeArtifactBootstrapPlan) {
  return {
    status: "created" as const,
    authoritySha256: plan.authoritySha256,
    providerHandle: plan.providerHandle,
    sandboxName: plan.sandboxName,
    lifecycleGeneration: plan.lifecycleGeneration,
    artifactDigest: plan.workload.artifact.digest,
    executableDigest: plan.workload.launch.executable.digest,
  };
}

describe("inactive MXC native-artifact bootstrap", () => {
  it("preserves drive-root launch authority across atomic create and readiness checks (#8178)", async () => {
    let observedPlan: RuntimeProviderNativeArtifactBootstrapPlan | null = null;
    const operations: RuntimeProviderNativeArtifactBootstrapOperations = {
      verifyAndCreate: vi.fn(async (plan) => {
        observedPlan = plan;
        const created = verifiedCreateOutcome(plan);
        Reflect.set(plan, "artifactRoot", SHARE_DIRECTORY);
        Reflect.set(plan.workload.artifact, "digest", "sha256:" + "0".repeat(64));
        Reflect.set(plan.workload.launch.environmentNames, "0", "MUTATED");
        return created;
      }),
      verifyReadiness: vi.fn(async (plan, created) => {
        expect(plan.artifactRoot).toBe("C:\\openclaw-2026-7-1");
        expect(plan.workload.artifact.digest).toBe(NATIVE_RECEIPT.artifact.digest);
        expect(plan.workload.launch.environmentNames[0]).toBe("HOME");
        expect(created).toEqual(verifiedCreateOutcome(plan));
        return readyEvidence(plan);
      }),
      recoverCreate: vi.fn(async () => ({ status: "absent" as const })),
    };

    const receipt = await nativeBootstrap(operations).run(bootstrapInput());

    expect(observedPlan).toMatchObject({
      schemaVersion: 1,
      providerId: "mxc",
      sandboxName: "alpha",
      lifecycleGeneration: LIFECYCLE_GENERATION,
      driveRoot: "C:\\",
      artifactRoot: "C:\\openclaw-2026-7-1",
      shareDirectory: SHARE_DIRECTORY,
      homeDirectory: `${SHARE_DIRECTORY}\\home`,
      stateDirectory: `${SHARE_DIRECTORY}\\openclaw-state`,
      temporaryDirectory: `${SHARE_DIRECTORY}\\temp`,
      executablePath: "C:\\openclaw-2026-7-1\\node\\node.exe",
      workingDirectory: "C:\\openclaw-2026-7-1",
      environment: {
        HOME: `${SHARE_DIRECTORY}\\home`,
        OPENCLAW_CONFIG_PATH: `${SHARE_DIRECTORY}\\openclaw-state\\openclaw.json`,
        OPENCLAW_HOME: `${SHARE_DIRECTORY}\\home`,
        OPENCLAW_STATE_DIR: `${SHARE_DIRECTORY}\\openclaw-state`,
        TEMP: `${SHARE_DIRECTORY}\\temp`,
        TMP: `${SHARE_DIRECTORY}\\temp`,
        USERPROFILE: `${SHARE_DIRECTORY}\\home`,
      },
      authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      providerHandle: expect.stringMatching(/^mxc-native-artifact-v1:[a-f0-9]{64}$/u),
    });
    expect(receipt).toEqual({
      outcome: "ready",
      reason: null,
      authoritySha256: observedPlan!.authoritySha256,
      providerHandle: observedPlan!.providerHandle,
      sandboxName: "alpha",
      lifecycleGeneration: LIFECYCLE_GENERATION,
      resourceState: "active",
      cleanup: { attempted: false, resourceRemovalAuthorized: false, removed: false },
      recoveryRequired: false,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.cleanup)).toBe(true);
    expect(JSON.stringify(observedPlan)).not.toMatch(/C:\\\\Users/iu);
  });

  it.each([
    [
      "provider drift",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({ ...input, providerId: "docker" }),
      /provider identity/u,
    ],
    [
      "missing lifecycle generation",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        lifecycleGeneration: "",
      }),
      /lifecycle generation/u,
    ],
    [
      "nested artifact staging",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        artifactRoot: "C:\\stage\\openclaw-2026-7-1",
      }),
      /artifact root must be a direct child/u,
    ],
    [
      "broad user directory as the provider root",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        driveRoot: "C:\\Users\\alpha",
      }),
      /drive root must name one Windows drive root/u,
    ],
    [
      "writable share reused as the artifact root",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        artifactRoot: SHARE_DIRECTORY,
      }),
      /artifact root and provider-owned writable share must remain separate/u,
    ],
    [
      "writable share with a trailing separator reused as the artifact root",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        artifactRoot: `${SHARE_DIRECTORY}\\`,
      }),
      /artifact root and provider-owned writable share must remain separate/u,
    ],
    [
      "writable share with a trailing period reused as the artifact root",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        artifactRoot: `${SHARE_DIRECTORY}.`,
      }),
      /artifact root must be a direct child/u,
    ],
    [
      "writable share with a trailing space reused as the artifact root",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        artifactRoot: `${SHARE_DIRECTORY} `,
      }),
      /artifact root must be a direct child/u,
    ],
    [
      "OpenClaw writable mappings omitted",
      (input: RuntimeProviderNativeArtifactBootstrapInput) => ({
        ...input,
        workload: {
          ...input.workload,
          launch: { ...input.workload.launch, environmentNames: ["PATH"] },
        },
      }),
      /bind OpenClaw home, state, config, TEMP, and TMP/u,
    ],
  ] as const)("rejects %s before the create boundary (#8178)", async (_label, mutate, message) => {
    const verifyAndCreate = vi.fn();
    const bootstrap = nativeBootstrap({
      verifyAndCreate,
      verifyReadiness: vi.fn(),
    });
    await expect(bootstrap.run(mutate(bootstrapInput()))).rejects.toThrow(message);
    expect(verifyAndCreate).not.toHaveBeenCalled();
  });

  it("reports an absent resource when the provider rejects artifact substitution (#8178)", async () => {
    const verifyReadiness = vi.fn();
    const verifyAndCreate = vi.fn(async () => ({
      status: "not-created" as const,
      reason: "artifact-verification-failed" as const,
    }));

    const receipt = await nativeBootstrap({
      verifyAndCreate,
      verifyReadiness,
    }).run(bootstrapInput());

    expect(receipt).toMatchObject({
      outcome: "not-created",
      reason: "artifact-verification-failed",
      resourceState: "absent",
      cleanup: { attempted: false, resourceRemovalAuthorized: false, removed: false },
      recoveryRequired: false,
    });
    expect(verifyAndCreate).toHaveBeenCalledOnce();
    expect(verifyReadiness).not.toHaveBeenCalled();
  });

  it("isolates writable shares by sandbox lifecycle generation (#8178)", async () => {
    const plans: RuntimeProviderNativeArtifactBootstrapPlan[] = [];
    const operations: RuntimeProviderNativeArtifactBootstrapOperations = {
      verifyAndCreate: vi.fn(async (plan) => {
        plans.push(plan);
        return { status: "not-created" as const, reason: "create-rejected" as const };
      }),
      verifyReadiness: vi.fn(),
      recoverCreate: vi.fn(async () => ({ status: "absent" as const })),
    };

    const bootstrap = nativeBootstrap(operations);
    await bootstrap.run(bootstrapInput());
    await bootstrap.run({ ...bootstrapInput(), lifecycleGeneration: "generation-8" });

    expect(plans).toHaveLength(2);
    expect(plans[0]!.shareDirectory).not.toBe(plans[1]!.shareDirectory);
    expect(plans[0]!.shareDirectory).toMatch(/^C:\\nemoclaw-alpha-[a-f0-9]{12}$/u);
    expect(plans[1]!.shareDirectory).toMatch(/^C:\\nemoclaw-alpha-[a-f0-9]{12}$/u);
  });

  it.each([
    {
      label: "explicit create rejection",
      verifyAndCreate: async () => ({
        status: "not-created" as const,
        reason: "create-rejected" as const,
      }),
      expected: {
        outcome: "not-created",
        reason: "create-rejected",
        resourceState: "absent",
      },
    },
    {
      label: "ambiguous create result",
      verifyAndCreate: async () => ({ status: "unknown" as const }),
      expected: {
        outcome: "retained",
        reason: "recovery-not-proven",
        resourceState: "possibly-retained",
      },
    },
    {
      label: "create transport failure",
      verifyAndCreate: async () => {
        throw new Error("nvapi-secret-must-not-escape");
      },
      expected: {
        outcome: "retained",
        reason: "recovery-not-proven",
        resourceState: "possibly-retained",
      },
    },
  ])("reports fail-closed state after $label (#8178)", async ({ verifyAndCreate, expected }) => {
    const verifyReadiness = vi.fn();
    const receipt = await nativeBootstrap({
      verifyAndCreate,
      verifyReadiness,
    }).run(bootstrapInput());

    expect(receipt).toMatchObject({
      ...expected,
      cleanup: {
        attempted: expected.resourceState === "possibly-retained",
        resourceRemovalAuthorized: expected.resourceState === "possibly-retained",
        removed: false,
      },
      recoveryRequired: expected.resourceState === "possibly-retained",
    });
    expect(JSON.stringify(receipt)).not.toContain("nvapi-secret-must-not-escape");
    expect(verifyReadiness).not.toHaveBeenCalled();
  });

  it.each([
    [
      "create authority drift",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...verifiedCreateOutcome(plan),
        authoritySha256: "0".repeat(64),
      }),
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => readyEvidence(plan),
      "recovery-not-proven",
      false,
    ],
    [
      "create sandbox identity drift",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...verifiedCreateOutcome(plan),
        sandboxName: `${plan.sandboxName}-drift`,
      }),
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => readyEvidence(plan),
      "recovery-not-proven",
      false,
    ],
    [
      "create provider handle drift",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...verifiedCreateOutcome(plan),
        providerHandle: `mxc-native-artifact-v1:${"0".repeat(64)}`,
      }),
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => readyEvidence(plan),
      "recovery-not-proven",
      false,
    ],
    [
      "readiness identity drift",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => verifiedCreateOutcome(plan),
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...readyEvidence(plan),
        lifecycleGeneration: `${plan.lifecycleGeneration}-drift`,
      }),
      "recovery-not-proven",
      true,
    ],
    [
      "readiness provider handle drift",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => verifiedCreateOutcome(plan),
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...readyEvidence(plan),
        providerHandle: `mxc-native-artifact-v1:${"0".repeat(64)}`,
      }),
      "recovery-not-proven",
      true,
    ],
    [
      "readiness transport failure",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => verifiedCreateOutcome(plan),
      async (_plan: RuntimeProviderNativeArtifactBootstrapPlan) => {
        throw new Error("untrusted readiness detail");
      },
      "recovery-not-proven",
      true,
    ],
  ] as const)(
    "retains a created or ambiguous resource after %s (#8178)",
    async (_label, verifyAndCreate, verifyReadiness, reason, readinessExpected) => {
      const verify = vi.fn(verifyReadiness);
      const receipt = await nativeBootstrap({
        verifyAndCreate,
        verifyReadiness: verify,
      }).run(bootstrapInput());

      expect(receipt).toMatchObject({
        outcome: "retained",
        reason,
        resourceState: "possibly-retained",
        cleanup: {
          attempted: readinessExpected,
          resourceRemovalAuthorized: readinessExpected,
          removed: false,
        },
        recoveryRequired: true,
      });
      expect(verify).toHaveBeenCalledTimes(readinessExpected ? 1 : 0);
    },
  );

  it("keeps mismatched create evidence when plan recovery reports absent (#8178)", async () => {
    const recoverCreate = vi.fn(async () => ({ status: "absent" as const }));
    const verifyReadiness = vi.fn();
    const receipt = await nativeBootstrap({
      verifyAndCreate: async (plan) => ({
        ...verifiedCreateOutcome(plan),
        sandboxName: `${plan.sandboxName}-drift`,
      }),
      verifyReadiness,
      recoverCreate,
    }).run(bootstrapInput());

    expect(receipt).toMatchObject({
      outcome: "retained",
      reason: "recovery-not-proven",
      resourceState: "possibly-retained",
      cleanup: { attempted: false, resourceRemovalAuthorized: false, removed: false },
      recoveryRequired: true,
    });
    expect(recoverCreate).not.toHaveBeenCalled();
    expect(verifyReadiness).not.toHaveBeenCalled();
  });

  it("recovers the exact operation handle after an ambiguous create and on retry (#8178)", async () => {
    const recoveredHandles: string[] = [];
    const recoverCreate = vi.fn(async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => {
      recoveredHandles.push(plan.providerHandle);
      return recoveredHandles.length === 1
        ? {
            status: "removed" as const,
            authoritySha256: plan.authoritySha256,
            providerHandle: plan.providerHandle,
            sandboxName: plan.sandboxName,
            lifecycleGeneration: plan.lifecycleGeneration,
          }
        : { status: "absent" as const };
    });
    const bootstrap = nativeBootstrap({
      verifyAndCreate: async () => ({ status: "unknown" }),
      verifyReadiness: vi.fn(),
      recoverCreate,
    });

    const first = await bootstrap.run(bootstrapInput());
    const retry = await bootstrap.recover(bootstrapInput());

    expect(first).toMatchObject({
      outcome: "not-created",
      reason: "recovered",
      resourceState: "absent",
      cleanup: { attempted: true, resourceRemovalAuthorized: true, removed: true },
      recoveryRequired: false,
    });
    expect(retry).toMatchObject({
      outcome: "not-created",
      reason: "recovered",
      resourceState: "absent",
      cleanup: { attempted: true, resourceRemovalAuthorized: true, removed: true },
      recoveryRequired: false,
    });
    expect(recoveredHandles).toEqual([first.providerHandle, first.providerHandle]);
  });

  it("does not authorize removal when recovery evidence changes resource identity (#8178)", async () => {
    const receipt = await nativeBootstrap({
      verifyAndCreate: async () => ({ status: "unknown" }),
      verifyReadiness: vi.fn(),
      recoverCreate: async (plan) => ({
        status: "removed",
        authoritySha256: plan.authoritySha256,
        providerHandle: plan.providerHandle,
        sandboxName: `${plan.sandboxName}-drift`,
        lifecycleGeneration: plan.lifecycleGeneration,
      }),
    }).run(bootstrapInput());

    expect(receipt).toMatchObject({
      outcome: "retained",
      reason: "recovery-not-proven",
      resourceState: "possibly-retained",
      cleanup: { attempted: true, resourceRemovalAuthorized: false, removed: false },
      recoveryRequired: true,
    });
  });
});
