// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { encodeManagedStartupProfile } from "../managed-startup/profile";
import { nativeArtifactWorkloadReceiptFixture } from "../workload/native-artifact-test-fixture";
import type {
  RuntimeProviderNativeArtifactBootstrapInput,
  RuntimeProviderNativeArtifactBootstrapPlan,
  RuntimeProviderNativeArtifactVerifyAndCreateOutcome,
} from "./contract";
import { createMxcNativeArtifactBootstrapSurface } from "./mxc-bootstrap";
import {
  createMxcOpenShellRequestScopedControlPlane,
  projectMxcOpenShellCreateRequest,
  type MxcOpenShellRequestScopedOperations,
} from "./mxc-openshell-create-request";

const REQUIRED_ENVIRONMENT = [
  "HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "PATH",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

type MutableBootstrapPlan = DeepMutable<RuntimeProviderNativeArtifactBootstrapPlan>;

const PLAN_DRIFT_CASES: readonly [string, (plan: MutableBootstrapPlan) => void][] = [
  [
    "artifact digest",
    (plan) => {
      plan.workload.artifact.digest = `sha256:${"d".repeat(64)}`;
    },
  ],
  [
    "executable path",
    (plan) => {
      plan.executablePath = "C:\\other\\node.exe";
    },
  ],
  [
    "launch arguments",
    (plan) => {
      plan.workload.launch.arguments.push("--unsafe");
    },
  ],
  [
    "working directory",
    (plan) => {
      plan.workingDirectory = "C:\\other";
    },
  ],
  [
    "environment",
    (plan) => {
      plan.environment.HOME = "C:\\other";
    },
  ],
  [
    "lifecycle identity",
    (plan) => {
      plan.lifecycleGeneration = "generation-8";
    },
  ],
];

function bootstrapInput(): RuntimeProviderNativeArtifactBootstrapInput {
  const workload = nativeArtifactWorkloadReceiptFixture(
    encodeManagedStartupProfile(managedStartupE2eProfile("openclaw")),
  );
  return {
    providerId: "mxc",
    sandboxName: "alpha",
    lifecycleGeneration: "generation-7",
    driveRoot: "C:\\",
    artifactRoot: "C:\\openclaw-2026-7-1",
    workload: {
      ...workload,
      launch: { ...workload.launch, environmentNames: REQUIRED_ENVIRONMENT },
    },
  };
}

async function bootstrapPlan(): Promise<RuntimeProviderNativeArtifactBootstrapPlan> {
  let observed: RuntimeProviderNativeArtifactBootstrapPlan | undefined;
  const surface = createMxcNativeArtifactBootstrapSurface({
    verifyAndCreate: async (plan) => {
      observed = plan;
      return { status: "not-created", reason: "create-rejected" };
    },
    verifyReadiness: async () => {
      throw new Error("readiness must not run");
    },
    recoverCreate: async () => ({ status: "absent" }),
  });
  await surface.run(bootstrapInput());
  expect(observed).toBeDefined();
  return observed!;
}

function created(
  plan: RuntimeProviderNativeArtifactBootstrapPlan,
): Extract<RuntimeProviderNativeArtifactVerifyAndCreateOutcome, { status: "created" }> {
  return {
    status: "created",
    authoritySha256: plan.authoritySha256,
    providerHandle: plan.providerHandle,
    sandboxName: plan.sandboxName,
    lifecycleGeneration: plan.lifecycleGeneration,
    artifactDigest: plan.workload.artifact.digest,
    executableDigest: plan.workload.launch.executable.digest,
  };
}

describe("inactive MXC OpenShell create request", () => {
  it("projects one provenance-bound per-sandbox driver request (#8178)", async () => {
    const plan = await bootstrapPlan();
    const request = projectMxcOpenShellCreateRequest(plan);

    expect(JSON.parse(request.driverConfigJson)).toEqual({
      mxc: {
        command: ["C:\\openclaw-2026-7-1\\node\\node.exe", "openclaw.mjs", "gateway"],
        cwd: "C:\\openclaw-2026-7-1",
      },
    });
    expect(request).toMatchObject({
      contractVersion: 1,
      providerId: "mxc",
      authoritySha256: plan.authoritySha256,
      providerHandle: plan.providerHandle,
      sandboxName: "alpha",
      lifecycleGeneration: "generation-7",
      workload: {
        agent: "openclaw",
        platform: "windows/x64",
        artifactRoot: "C:\\openclaw-2026-7-1",
        artifactDigest: plan.workload.artifact.digest,
        artifactVersion: "2026.7.1",
        sourceRepository: "NVIDIA/NemoClaw",
        sourceRevision: "b".repeat(40),
        executablePath: "C:\\openclaw-2026-7-1\\node\\node.exe",
        executableDigest: plan.workload.launch.executable.digest,
      },
      writableShare: plan.shareDirectory,
      hostEnvironmentReferences: ["PATH"],
      environment: plan.environment,
    });
    expect(request.requestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(request)).not.toContain("encodedProfile");
    expect(JSON.stringify(request)).not.toContain("NVIDIA_API_KEY");
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.environment)).toBe(true);
    expect(Object.isFrozen(request.workload)).toBe(true);
  });

  it.each(PLAN_DRIFT_CASES)(
    "rejects %s drift before producing an OpenShell request (#8178)",
    async (_label, mutate) => {
      const changed = structuredClone(await bootstrapPlan()) as MutableBootstrapPlan;
      mutate(changed);

      expect(() => projectMxcOpenShellCreateRequest(changed as never)).toThrow(
        /bootstrap plan was not issued by the provider-owned bootstrap surface/u,
      );
    },
  );

  it("rejects a copied self-consistent plan without provider provenance (#8178)", async () => {
    const copied = structuredClone(await bootstrapPlan());

    expect(() => projectMxcOpenShellCreateRequest(copied)).toThrow(
      /bootstrap plan was not issued by the provider-owned bootstrap surface/u,
    );
  });

  it("passes the same canonical request to create, readiness, and recovery (#8178)", async () => {
    const plan = await bootstrapPlan();
    const verifyAndCreate = vi.fn<MxcOpenShellRequestScopedOperations["verifyAndCreate"]>(
      async () => created(plan),
    );
    const verifyReadiness = vi.fn<MxcOpenShellRequestScopedOperations["verifyReadiness"]>(
      async () => ({
        authoritySha256: plan.authoritySha256,
        providerHandle: plan.providerHandle,
        sandboxName: plan.sandboxName,
        lifecycleGeneration: plan.lifecycleGeneration,
        artifactDigest: plan.workload.artifact.digest,
        executableDigest: plan.workload.launch.executable.digest,
        ready: true,
      }),
    );
    const recoverCreate = vi.fn<MxcOpenShellRequestScopedOperations["recoverCreate"]>(async () => ({
      status: "absent",
    }));
    const controlPlane = createMxcOpenShellRequestScopedControlPlane({
      verifyAndCreate,
      verifyReadiness,
      recoverCreate,
    });
    const creation = await controlPlane.verifyAndCreate(plan);
    expect(creation.status).toBe("created");
    await controlPlane.verifyReadiness(plan, created(plan));
    await controlPlane.recoverCreate(plan);

    const createRequest = verifyAndCreate.mock.calls[0]![0];
    expect(verifyReadiness.mock.calls[0]![0]).toEqual(createRequest);
    expect(recoverCreate.mock.calls[0]![0]).toEqual(createRequest);
  });

  it("rejects an incomplete request-scoped operation boundary (#8178)", () => {
    expect(() =>
      createMxcOpenShellRequestScopedControlPlane({
        verifyAndCreate: undefined,
        verifyReadiness: async () => {
          throw new Error("unreachable");
        },
        recoverCreate: async () => ({ status: "absent" }),
      } as never),
    ).toThrow(/verify-and-create, readiness, and recovery operations are required/u);
  });
});
