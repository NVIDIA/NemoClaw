// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_CAPABILITIES,
  CUA_DENIED_DESTINATIONS,
  CUA_LIFECYCLE_SCHEMA_VERSION,
  CUA_MATERIAL_EXCLUSIONS,
  CUA_PRIVATE_MATERIALS,
  CUA_TASK_OPERATIONS,
  CUA_TARGET_OPERATIONS,
  CUA_UNTRUSTED_INPUTS,
  type CuaRuntimeReadiness,
  type CuaSecurityAttestation,
  type CuaTargetAttachment,
  getCuaRuntimeReadinessDigest,
} from "../../cua/contract";
import { createCuaReconciliationState } from "../../cua/reconciliation";
import { cuaInferenceRoutesMatch, getCuaInferenceRouteIdentity } from "../../cua/runtime-readiness";
import { parseCuaRuntimeReadiness } from "../../cua/schema";
import { type CuaStateValidationDeps, getValidatedCuaState } from "../../cua/state";
import type { SandboxEntry } from "../../state/registry";
import {
  buildCuaRuntimeDoctorCheck,
  buildCuaSecurityDoctorCheck,
  buildCuaTargetDoctorCheck,
  collectCuaDoctorChecks,
} from "./doctor";
import { getSandboxStatusReport } from "./status";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const inferenceRoute = { provider: "fixture", model: "fixture/model" };
const providerAuthorityDigest = digest("d");
const liveInference = { ...inferenceRoute, providerAuthorityDigest };
const appliedPolicy = { revision: 17, digest: digest("e") } as const;
const readiness: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "runtime-readiness",
  agent: "nemocua",
  mode: "standalone",
  status: "available",
  sourceRevision: "a".repeat(40),
  sourceClean: true,
  runtimeManifestDigest: digest("9"),
  providerAuthorityDigest,
  qualification: {
    state: "qualified",
    candidateSourceRevision: "b".repeat(40),
    environmentDigest: digest("a"),
    receiptDigest: digest("b"),
    bundleReceiptDigest: digest("c"),
  },
  components: {
    openshell: { name: "openshell", version: "1", digest: digest("3"), owner: "fixture" },
    runtime: { name: "runtime", version: "1", digest: digest("4"), owner: "fixture" },
    sandboxImage: { name: "sandbox", version: "1", digest: digest("5"), owner: "fixture" },
    targetAdapter: {
      name: "target-adapter",
      version: "1",
      digest: digest("9"),
      owner: "fixture",
    },
    policy: { name: "policy", version: "1", digest: digest("6"), owner: "fixture" },
    taskProtocol: { name: "task", version: "1", digest: digest("7"), owner: "fixture" },
    securityVerifier: { name: "verifier", version: "1", digest: digest("8"), owner: "fixture" },
  },
  inference: getCuaInferenceRouteIdentity(inferenceRoute),
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: CUA_CAPABILITIES,
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_TASK_OPERATIONS,
  securityOperations: ["security.status", "security.verify"],
};
const fixtureValidation: CuaStateValidationDeps = {
  liveAppliedPolicy: appliedPolicy,
  validateRuntimeReadiness: (value, context) => {
    const parsed = parseCuaRuntimeReadiness(value);
    if (
      !context.liveInference ||
      !context.liveProviderAuthorityDigest ||
      parsed.providerAuthorityDigest !== context.liveProviderAuthorityDigest ||
      !cuaInferenceRoutesMatch(parsed.inference, context.recordedInference) ||
      !cuaInferenceRoutesMatch(parsed.inference, context.liveInference)
    ) {
      throw new Error("fixture route drift");
    }
    return parsed;
  },
};
const getFixtureValidatedCuaState: typeof getValidatedCuaState = (
  entry,
  env,
  observedInference,
  validation,
) =>
  getValidatedCuaState(entry, env, observedInference, {
    ...fixtureValidation,
    ...validation,
  });

const attachment: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
  runtimeReadinessDigest: getCuaRuntimeReadinessDigest(readiness),
  target: {
    identityDigest: digest("1"),
    platform: "fixture-linux-amd64",
    image: { name: "fixture-image", version: "1", digest: digest("2"), owner: "fixture" },
    serviceBundle: {
      name: "fixture-services",
      version: "1",
      digest: digest("3"),
      owner: "fixture",
    },
    capabilities: [
      { id: "browser", protocolVersion: "1", health: "healthy" },
      { id: "computer", protocolVersion: "1", health: "healthy" },
      { id: "terminal", protocolVersion: "1", health: "healthy" },
    ],
  },
  activeTask: null,
};

beforeEach(() => {
  vi.stubEnv("NEMOCLAW_CUA_ENABLED", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const security: CuaSecurityAttestation = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "security-attestation",
  status: "enforced",
  bindings: {
    runtimeReadinessDigest: getCuaRuntimeReadinessDigest(readiness),
    targetIdentityDigest: attachment.target!.identityDigest,
    components: {
      openshell: readiness.components.openshell,
      runtime: readiness.components.runtime,
      sandboxImage: readiness.components.sandboxImage,
      targetImage: attachment.target!.image,
      serviceBundle: attachment.target!.serviceBundle,
      policy: readiness.components.policy,
      taskProtocol: readiness.components.taskProtocol,
    },
    inference: readiness.inference,
    appliedPolicy,
    capabilities: attachment.target!.capabilities.map(({ id, protocolVersion }) => ({
      id,
      protocolVersion,
    })),
  },
  network: {
    defaultAction: "deny",
    managedInference: "only",
    targetServices: ["browser", "computer", "terminal"],
    deniedDestinations: CUA_DENIED_DESTINATIONS,
  },
  materialBoundary: {
    delivery: "host-side-secret-boundary",
    sandboxMaterial: "absent",
    excludedFrom: CUA_MATERIAL_EXCLUSIONS,
  },
  isolation: {
    runAs: "non-root",
    privileged: false,
    hostDockerSocket: false,
    hostDesktop: false,
    broadWritableHostMounts: false,
  },
  artifacts: {
    materials: CUA_PRIVATE_MATERIALS,
    classification: "private",
    contentIdentity: "sha256",
    access: "owner-only",
    metadata: "bounded",
    retention: "until-target-detach-or-destroy",
    cleanupOperations: CUA_ARTIFACT_CLEANUP_OPERATIONS,
    backup: "excluded",
  },
  authority: {
    fixtureScope: "synthetic-local",
    externalSideEffects: "denied",
    untrustedInputs: CUA_UNTRUSTED_INPUTS,
    mayExpand: false,
  },
  verifier: { name: "verifier", version: "1", digest: digest("8"), owner: "fixture" },
};

describe("CUA target status and doctor projection (#7751)", () => {
  it("adds only the secret-free target projection to sandbox status JSON", async () => {
    const sandbox = {
      name: "alpha",
      agent: "nemocua",
      ...inferenceRoute,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: security,
    } as SandboxEntry;
    const observeCuaLiveInferenceImpl = vi.fn(() => liveInference);
    const observeCuaLiveAppliedPolicyImpl = vi.fn(() => appliedPolicy);

    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      getValidatedCuaStateImpl: getFixtureValidatedCuaState,
      observeCuaLiveInferenceImpl,
      observeCuaLiveAppliedPolicyImpl,
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });

    expect(report.cuaTarget).toEqual(attachment);
    expect(report.cuaRuntime).toEqual(readiness);
    expect(report.cuaSecurity).toEqual(security);
    expect(report.cuaReconciliation).toBeNull();
    expect(observeCuaLiveInferenceImpl).toHaveBeenCalledOnce();
    expect(observeCuaLiveInferenceImpl).toHaveBeenCalledWith(sandbox);
    expect(observeCuaLiveAppliedPolicyImpl).toHaveBeenCalledOnce();
    expect(observeCuaLiveAppliedPolicyImpl).toHaveBeenCalledWith(sandbox);
    expect(JSON.stringify(report.cuaTarget)).not.toMatch(
      /credential|password|secret|token|endpoint|hostname|ssh|vnc/i,
    );
  });

  it("suppresses reusable authority and reports durable reconciliation state", async () => {
    const reconciliation = createCuaReconciliationState({
      attemptId: "55555555-5555-4555-8555-555555555555",
      trigger: "policy-change",
      runtimeReadinessDigest: attachment.runtimeReadinessDigest,
      targetIdentityDigest: attachment.target!.identityDigest,
    });
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      ...inferenceRoute,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaReconciliation: reconciliation,
    };

    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      getValidatedCuaStateImpl: getFixtureValidatedCuaState,
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });

    expect(report).toMatchObject({
      cuaRuntime: null,
      cuaTarget: null,
      cuaSecurity: null,
      cuaReconciliation: reconciliation,
    });
    expect(collectCuaDoctorChecks("alpha", sandbox)).toEqual([
      expect.objectContaining({
        label: "CUA reconciliation",
        status: "fail",
        detail: expect.stringContaining("policy-change"),
      }),
    ]);
    expect(JSON.stringify(report.cuaReconciliation)).not.toMatch(
      /credential|password|secret|token|endpoint|hostname|url/i,
    );
  });

  it("does not read or project CUA status and doctor state while the feature is disabled", async () => {
    vi.stubEnv("NEMOCLAW_CUA_ENABLED", "");
    const reconciliation = createCuaReconciliationState({
      attemptId: "55555555-5555-4555-8555-555555555555",
      trigger: "policy-change",
      runtimeReadinessDigest: attachment.runtimeReadinessDigest,
      targetIdentityDigest: attachment.target!.identityDigest,
    });
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      ...inferenceRoute,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: security,
      cuaReconciliation: reconciliation,
    };
    const observeCuaLiveInferenceImpl = vi.fn(() => liveInference);
    const observeCuaLiveAppliedPolicyImpl = vi.fn(() => appliedPolicy);
    const getValidatedCuaStateImpl = vi.fn(getFixtureValidatedCuaState);

    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      getValidatedCuaStateImpl,
      observeCuaLiveInferenceImpl,
      observeCuaLiveAppliedPolicyImpl,
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });

    expect(report).toMatchObject({
      agent: "nemocua",
      agentRuntime: "unknown",
      cuaRuntime: null,
      cuaTarget: null,
      cuaSecurity: null,
      cuaReconciliation: null,
    });
    expect(report.agentLoadError).toContain("supported Brev Launchable activation");
    expect(
      collectCuaDoctorChecks("alpha", sandbox, {
        observeCuaLiveInferenceImpl,
        observeCuaLiveAppliedPolicyImpl,
        validationDeps: fixtureValidation,
      }),
    ).toEqual([]);
    expect(getValidatedCuaStateImpl).not.toHaveBeenCalled();
    expect(observeCuaLiveInferenceImpl).not.toHaveBeenCalled();
    expect(observeCuaLiveAppliedPolicyImpl).not.toHaveBeenCalled();
  });

  it("reports only an identity-bound, content-free security projection", () => {
    const check = buildCuaSecurityDoctorCheck(
      "alpha",
      {
        name: "alpha",
        agent: "nemocua",
        ...inferenceRoute,
        cuaRuntimeReadiness: readiness,
        cuaTarget: attachment,
        cuaSecurityAttestation: security,
      },
      liveInference,
      fixtureValidation,
    );

    expect(check).toMatchObject({
      group: "Sandbox",
      label: "CUA security",
      status: "ok",
      detail: expect.stringContaining("enforced"),
    });
    expect(check?.detail).not.toMatch(/endpoint|hostname|credential|cookie|ssh|vnc/i);

    expect(
      buildCuaSecurityDoctorCheck(
        "alpha",
        {
          name: "alpha",
          agent: "nemocua",
          ...inferenceRoute,
          cuaRuntimeReadiness: readiness,
          cuaTarget: attachment,
        },
        liveInference,
        fixtureValidation,
      ),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("not verified") });
  });

  it("reports an attached target and its three capability health states", () => {
    const check = buildCuaTargetDoctorCheck(
      "alpha",
      {
        name: "alpha",
        agent: "nemocua",
        ...inferenceRoute,
        cuaRuntimeReadiness: readiness,
        cuaTarget: attachment,
      },
      liveInference,
      fixtureValidation,
    );

    expect(check).toMatchObject({
      group: "Sandbox",
      label: "CUA target",
      status: "ok",
      detail: expect.stringContaining("browser=healthy"),
    });
    expect(check?.detail).toContain("computer=healthy");
    expect(check?.detail).toContain("terminal=healthy");
    expect(check?.detail).not.toMatch(/endpoint|hostname|credential/i);
  });

  it("fails doctor for replaced target state and reports detached state as informational", () => {
    expect(
      buildCuaTargetDoctorCheck(
        "alpha",
        {
          name: "alpha",
          agent: "nemocua",
          ...inferenceRoute,
          cuaRuntimeReadiness: readiness,
          cuaTarget: { ...attachment, status: "replaced" },
        },
        liveInference,
        fixtureValidation,
      ),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("replaced") });

    expect(
      buildCuaTargetDoctorCheck(
        "alpha",
        {
          name: "alpha",
          agent: "nemocua",
          ...inferenceRoute,
          cuaRuntimeReadiness: readiness,
        },
        liveInference,
        fixtureValidation,
      ),
    ).toMatchObject({ status: "info", detail: "no target attached" });
  });

  it("suppresses status and fails doctor when the live inference route drifts", async () => {
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      ...inferenceRoute,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: security,
    };
    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      getValidatedCuaStateImpl: getFixtureValidatedCuaState,
      observeCuaLiveInferenceImpl: () => ({
        provider: "different",
        model: "fixture/other",
        providerAuthorityDigest,
      }),
      listSandboxes: () => ({ sandboxes: [sandbox], defaultSandbox: "alpha" }),
      reconcile: async () => ({ state: "present", output: "Phase: Ready" }),
      captureOpenshellForStatusImpl: async () => ({
        status: 0,
        output: "Gateway inference:\n  Provider: different\n  Model: fixture/other\n",
      }),
      probeProviderHealthImpl: () => null,
      probeSandboxInferenceGatewayHealthImpl: async () => ({
        ok: true,
        endpoint: "https://inference.local/v1/models",
        httpStatus: 200,
        detail: "healthy fixture",
      }),
    });

    expect(report.cuaRuntime).toBeNull();
    expect(report.cuaTarget).toBeNull();
    expect(report.cuaSecurity).toBeNull();
    expect(
      buildCuaRuntimeDoctorCheck(
        sandbox,
        {
          provider: "different",
          model: "fixture/other",
          providerAuthorityDigest,
        },
        fixtureValidation,
      ),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("does not match") });
    expect(
      buildCuaTargetDoctorCheck(
        "alpha",
        sandbox,
        {
          provider: "different",
          model: "fixture/other",
          providerAuthorityDigest,
        },
        fixtureValidation,
      ),
    ).toBeNull();
  });

  it("re-observes the provider binding once before building CUA doctor checks", () => {
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      ...inferenceRoute,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: security,
    };
    const observeCuaLiveInferenceImpl = vi.fn(() => liveInference);
    const observeCuaLiveAppliedPolicyImpl = vi.fn(() => appliedPolicy);

    const checks = collectCuaDoctorChecks("alpha", sandbox, {
      observeCuaLiveInferenceImpl,
      observeCuaLiveAppliedPolicyImpl,
      validationDeps: fixtureValidation,
    });

    expect(observeCuaLiveInferenceImpl).toHaveBeenCalledOnce();
    expect(observeCuaLiveInferenceImpl).toHaveBeenCalledWith(sandbox);
    expect(observeCuaLiveAppliedPolicyImpl).toHaveBeenCalledOnce();
    expect(observeCuaLiveAppliedPolicyImpl).toHaveBeenCalledWith(sandbox);
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "CUA target", status: "ok" }),
        expect.objectContaining({ label: "CUA security", status: "ok" }),
      ]),
    );
  });

  it("fails closed when the CUA provider binding cannot be observed", async () => {
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      ...inferenceRoute,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: security,
    };

    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      getValidatedCuaStateImpl: getFixtureValidatedCuaState,
      observeCuaLiveInferenceImpl: () => {
        throw new Error("provider unavailable");
      },
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });
    expect(report).toMatchObject({ cuaRuntime: null, cuaTarget: null, cuaSecurity: null });

    expect(
      collectCuaDoctorChecks("alpha", sandbox, {
        observeCuaLiveInferenceImpl: () => {
          throw new Error("provider unavailable");
        },
        validationDeps: fixtureValidation,
      }),
    ).toEqual([expect.objectContaining({ label: "CUA runtime", status: "fail" })]);
  });

  it("suppresses status and fails doctor when the effective policy drifts", async () => {
    const preDriftTarget: CuaTargetAttachment = {
      ...attachment,
      activeTask: { taskId: "task-1", status: "running", appliedPolicy },
    };
    const sandbox: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      ...inferenceRoute,
      cuaRuntimeReadiness: readiness,
      cuaTarget: preDriftTarget,
      cuaSecurityAttestation: security,
    };
    const changedPolicy = { revision: 18, digest: digest("f") };
    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      getValidatedCuaStateImpl: getFixtureValidatedCuaState,
      observeCuaLiveInferenceImpl: () => liveInference,
      observeCuaLiveAppliedPolicyImpl: () => changedPolicy,
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });

    expect(report).toMatchObject({
      cuaRuntime: readiness,
      cuaTarget: attachment,
      cuaSecurity: null,
    });
    expect(report.cuaTarget?.activeTask).toBeNull();
    expect(sandbox.cuaTarget?.activeTask?.taskId).toBe("task-1");
    expect(
      collectCuaDoctorChecks("alpha", sandbox, {
        observeCuaLiveInferenceImpl: () => liveInference,
        observeCuaLiveAppliedPolicyImpl: () => changedPolicy,
        validationDeps: fixtureValidation,
      }),
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: "CUA security", status: "fail" })]),
    );
  });

  it("does not add a provider-binding probe to ordinary sandbox status or doctor", async () => {
    const observeCuaLiveInferenceImpl = vi.fn(() => liveInference);
    const observeCuaLiveAppliedPolicyImpl = vi.fn(() => appliedPolicy);
    const sandbox = {
      name: "alpha",
      agent: "openclaw",
      ...inferenceRoute,
    } as SandboxEntry;

    const report = await getSandboxStatusReport("alpha", {
      getSandbox: () => sandbox,
      observeCuaLiveInferenceImpl,
      observeCuaLiveAppliedPolicyImpl,
      reconcile: async () => ({ state: "missing", output: "not found" }),
    });
    const checks = collectCuaDoctorChecks("alpha", sandbox, {
      observeCuaLiveInferenceImpl,
      observeCuaLiveAppliedPolicyImpl,
      validationDeps: fixtureValidation,
    });

    expect(report).toMatchObject({ cuaRuntime: null, cuaTarget: null, cuaSecurity: null });
    expect(checks).toEqual([]);
    expect(observeCuaLiveInferenceImpl).not.toHaveBeenCalled();
    expect(observeCuaLiveAppliedPolicyImpl).not.toHaveBeenCalled();
  });
});
