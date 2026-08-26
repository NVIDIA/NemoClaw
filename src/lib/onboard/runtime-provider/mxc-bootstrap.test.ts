// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import type {
  RuntimeProviderNativeArtifactBootstrapInput,
  RuntimeProviderNativeArtifactIdentityEvidence,
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

function nativeBootstrap() {
  const surface = createMxcRuntimeProviderBundle({
    hostFacts: {
      platform: "win32",
      nativeArchitecture: "x64",
      release: "10.0.28120",
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
    lifecycleGeneration: plan.lifecycleGeneration,
    artifactDigest: plan.workload.artifact.digest,
    executableDigest: plan.workload.launch.executable.digest,
    ready: true,
  };
}

function artifactIdentityEvidence(
  plan: RuntimeProviderNativeArtifactBootstrapPlan,
): RuntimeProviderNativeArtifactIdentityEvidence {
  return {
    authoritySha256: plan.authoritySha256,
    artifactRoot: plan.artifactRoot,
    artifactDigest: plan.workload.artifact.digest,
    executablePath: plan.executablePath,
    executableDigest: plan.workload.launch.executable.digest,
  };
}

describe("inactive MXC native-artifact bootstrap", () => {
  it("preserves drive-root launch authority across create and readiness checks (#8178)", async () => {
    let observedPlan: RuntimeProviderNativeArtifactBootstrapPlan | null = null;
    const operations: RuntimeProviderNativeArtifactBootstrapOperations = {
      verifyArtifactIdentity: vi.fn(async (plan) => artifactIdentityEvidence(plan)),
      create: vi.fn(async (plan, identity) => {
        observedPlan = plan;
        const authoritySha256 = plan.authoritySha256;
        expect(identity).toEqual(artifactIdentityEvidence(plan));
        Reflect.set(plan, "artifactRoot", SHARE_DIRECTORY);
        Reflect.set(plan.workload.artifact, "digest", "sha256:" + "0".repeat(64));
        Reflect.set(plan.workload.launch.environmentNames, "0", "MUTATED");
        Reflect.set(identity, "artifactDigest", "sha256:" + "0".repeat(64));
        expect(identity.artifactDigest).toBe(NATIVE_RECEIPT.artifact.digest);
        return { status: "created" as const, authoritySha256 };
      }),
      verifyReadiness: vi.fn(async (plan) => {
        expect(plan.artifactRoot).toBe("C:\\openclaw-2026-7-1");
        expect(plan.workload.artifact.digest).toBe(NATIVE_RECEIPT.artifact.digest);
        expect(plan.workload.launch.environmentNames[0]).toBe("HOME");
        return readyEvidence(plan);
      }),
    };

    const receipt = await nativeBootstrap().run(bootstrapInput(), operations);

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
    });
    expect(receipt).toEqual({
      outcome: "ready",
      reason: null,
      authoritySha256: observedPlan!.authoritySha256,
      resourceState: "active",
      cleanup: { attempted: false, resourceRemovalAuthorized: false },
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
    const create = vi.fn();
    await expect(
      nativeBootstrap().run(mutate(bootstrapInput()), {
        verifyArtifactIdentity: vi.fn(),
        create,
        verifyReadiness: vi.fn(),
      }),
    ).rejects.toThrow(message);
    expect(create).not.toHaveBeenCalled();
  });

  it("requires provider-owned artifact verification before the create boundary (#8178)", async () => {
    const create = vi.fn();

    await expect(
      nativeBootstrap().run(bootstrapInput(), {
        create,
        verifyReadiness: vi.fn(),
      } as unknown as RuntimeProviderNativeArtifactBootstrapOperations),
    ).rejects.toThrow(/artifact verification, create, and readiness operations/u);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing artifact evidence",
      verifyArtifactIdentity: async () =>
        undefined as unknown as RuntimeProviderNativeArtifactIdentityEvidence,
    },
    {
      label: "malformed artifact evidence",
      verifyArtifactIdentity: async () =>
        ({
          authoritySha256: "malformed",
        }) as unknown as RuntimeProviderNativeArtifactIdentityEvidence,
    },
    {
      label: "artifact digest drift",
      verifyArtifactIdentity: async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...artifactIdentityEvidence(plan),
        artifactDigest: `sha256:${"0".repeat(64)}`,
      }),
    },
    {
      label: "executable digest drift",
      verifyArtifactIdentity: async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...artifactIdentityEvidence(plan),
        executableDigest: `sha256:${"0".repeat(64)}`,
      }),
    },
    {
      label: "artifact verification failure",
      verifyArtifactIdentity: async (_plan: RuntimeProviderNativeArtifactBootstrapPlan) => {
        throw new Error("untrusted artifact verification detail");
      },
    },
  ])("rejects $label before the create boundary (#8178)", async ({ verifyArtifactIdentity }) => {
    const create = vi.fn();
    const verifyReadiness = vi.fn();
    const receipt = await nativeBootstrap().run(bootstrapInput(), {
      verifyArtifactIdentity,
      create,
      verifyReadiness,
    });

    expect(receipt).toMatchObject({
      outcome: "not-created",
      reason: "artifact-verification-failed",
      resourceState: "absent",
      cleanup: { attempted: false, resourceRemovalAuthorized: false },
    });
    expect(JSON.stringify(receipt)).not.toContain("untrusted artifact verification detail");
    expect(create).not.toHaveBeenCalled();
    expect(verifyReadiness).not.toHaveBeenCalled();
  });

  it("isolates writable shares by sandbox lifecycle generation (#8178)", async () => {
    const plans: RuntimeProviderNativeArtifactBootstrapPlan[] = [];
    const operations: RuntimeProviderNativeArtifactBootstrapOperations = {
      verifyArtifactIdentity: vi.fn(async (plan) => artifactIdentityEvidence(plan)),
      create: vi.fn(async (plan) => {
        plans.push(plan);
        return { status: "not-created" as const };
      }),
      verifyReadiness: vi.fn(),
    };

    await nativeBootstrap().run(bootstrapInput(), operations);
    await nativeBootstrap().run(
      { ...bootstrapInput(), lifecycleGeneration: "generation-8" },
      operations,
    );

    expect(plans).toHaveLength(2);
    expect(plans[0]!.shareDirectory).not.toBe(plans[1]!.shareDirectory);
    expect(plans[0]!.shareDirectory).toMatch(/^C:\\nemoclaw-alpha-[a-f0-9]{12}$/u);
    expect(plans[1]!.shareDirectory).toMatch(/^C:\\nemoclaw-alpha-[a-f0-9]{12}$/u);
  });

  it.each([
    {
      label: "explicit create rejection",
      create: async () => ({ status: "not-created" as const }),
      expected: {
        outcome: "not-created",
        reason: "create-rejected",
        resourceState: "absent",
      },
    },
    {
      label: "ambiguous create result",
      create: async () => ({ status: "unknown" as const }),
      expected: {
        outcome: "retained",
        reason: "create-outcome-unknown",
        resourceState: "possibly-retained",
      },
    },
    {
      label: "create transport failure",
      create: async () => {
        throw new Error("nvapi-secret-must-not-escape");
      },
      expected: {
        outcome: "retained",
        reason: "create-outcome-unknown",
        resourceState: "possibly-retained",
      },
    },
  ])("retains safe state after $label (#8178)", async ({ create, expected }) => {
    const verifyReadiness = vi.fn();
    const receipt = await nativeBootstrap().run(bootstrapInput(), {
      verifyArtifactIdentity: async (plan) => artifactIdentityEvidence(plan),
      create,
      verifyReadiness,
    });

    expect(receipt).toMatchObject({
      ...expected,
      cleanup: { attempted: false, resourceRemovalAuthorized: false },
    });
    expect(JSON.stringify(receipt)).not.toContain("nvapi-secret-must-not-escape");
    expect(verifyReadiness).not.toHaveBeenCalled();
  });

  it.each([
    [
      "create authority drift",
      async (_plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        status: "created" as const,
        authoritySha256: "0".repeat(64),
      }),
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => readyEvidence(plan),
      "create-authority-mismatch",
      false,
    ],
    [
      "readiness identity drift",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        status: "created" as const,
        authoritySha256: plan.authoritySha256,
      }),
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        ...readyEvidence(plan),
        lifecycleGeneration: `${plan.lifecycleGeneration}-drift`,
      }),
      "readiness-not-proven",
      true,
    ],
    [
      "readiness transport failure",
      async (plan: RuntimeProviderNativeArtifactBootstrapPlan) => ({
        status: "created" as const,
        authoritySha256: plan.authoritySha256,
      }),
      async (_plan: RuntimeProviderNativeArtifactBootstrapPlan) => {
        throw new Error("untrusted readiness detail");
      },
      "readiness-not-proven",
      true,
    ],
  ] as const)(
    "retains a created or ambiguous resource after %s (#8178)",
    async (_label, create, verifyReadiness, reason, verificationExpected) => {
      const verify = vi.fn(verifyReadiness);
      const receipt = await nativeBootstrap().run(bootstrapInput(), {
        verifyArtifactIdentity: async (plan) => artifactIdentityEvidence(plan),
        create,
        verifyReadiness: verify,
      });

      expect(receipt).toMatchObject({
        outcome: "retained",
        reason,
        resourceState: "possibly-retained",
        cleanup: { attempted: false, resourceRemovalAuthorized: false },
      });
      expect(verify).toHaveBeenCalledTimes(verificationExpected ? 1 : 0);
    },
  );
});
