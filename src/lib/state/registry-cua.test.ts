// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
  type CuaTaskResult,
  getCuaRuntimeReadinessDigest,
} from "../cua/contract";
import { createCuaReconciliationState } from "../cua/reconciliation";
import { cuaInferenceRoutesMatch, getCuaInferenceRouteIdentity } from "../cua/runtime-readiness";
import { parseCuaRuntimeReadiness } from "../cua/schema";
import {
  type CuaStateValidationDeps,
  getObservedValidatedCuaState,
  getValidatedCuaState,
} from "../cua/state";
import type { SandboxEntry } from "./registry/types";

const originalHome = process.env.HOME;
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-registry-cua-"));
process.env.HOME = testHome;
const registry = await import("./registry");

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const appliedPolicy = { revision: 17, digest: digest("a") } as const;
const component = (name: string, value: string) => ({
  name,
  version: "1.0.0",
  digest: digest(value),
  owner: "fixture",
});

const readiness: CuaRuntimeReadiness = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "runtime-readiness",
  agent: "nemocua",
  mode: "standalone",
  status: "available",
  sourceRevision: "a".repeat(40),
  sourceClean: true,
  runtimeManifestDigest: digest("b"),
  providerAuthorityDigest: digest("0"),
  qualification: {
    state: "qualified",
    candidateSourceRevision: "c".repeat(40),
    environmentDigest: digest("d"),
    receiptDigest: digest("e"),
    bundleReceiptDigest: digest("f"),
  },
  components: {
    openshell: component("openshell", "0"),
    runtime: component("cua-fixture", "1"),
    sandboxImage: component("sandbox-fixture", "2"),
    targetAdapter: component("target-adapter-fixture", "9"),
    policy: component("policy-fixture", "3"),
    taskProtocol: component("task-fixture", "4"),
    securityVerifier: component("security-verifier", "8"),
  },
  inference: getCuaInferenceRouteIdentity({ provider: "fixture", model: "fixture-model" }),
  commands: { interactive: true, headless: true, version: true, smoke: true },
  limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
  requiredCapabilities: CUA_CAPABILITIES,
  targetOperations: CUA_TARGET_OPERATIONS,
  taskOperations: CUA_TASK_OPERATIONS,
  securityOperations: ["security.status", "security.verify"],
};

const candidateReadiness: CuaRuntimeReadiness = {
  ...readiness,
  status: "candidate",
  qualification: {
    state: "candidate",
    environmentDigest: digest("d"),
    bundleReceiptDigest: digest("f"),
  },
};

const attachment: CuaTargetAttachment = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "target-attachment",
  status: "attached",
  runtimeReadinessDigest: getCuaRuntimeReadinessDigest(readiness),
  target: {
    identityDigest: digest("5"),
    platform: "fixture-linux-amd64",
    image: component("desktop-fixture", "6"),
    serviceBundle: component("service-fixture", "7"),
    capabilities: CUA_CAPABILITIES.map((id) => ({
      id,
      protocolVersion: "1.0.0",
      health: "healthy" as const,
    })),
  },
  activeTask: null,
};

const completedResult: CuaTaskResult = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "task-result",
  taskId: "task-1",
  status: "succeeded",
  targetIdentityDigest: digest("5"),
  runtimeReadinessDigest: getCuaRuntimeReadinessDigest(readiness),
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
  capabilities: [{ id: "browser", protocolVersion: "1.0.0" }],
  agentResult: { status: "succeeded", resultDigest: digest("8") },
  verification: {
    status: "passed",
    checkIds: ["fixture-check"],
    evidenceDigests: [digest("9")],
  },
  receipts: [
    { capability: "browser", status: "completed" as const, evidenceDigests: [digest("9")] },
  ],
  evidence: [
    { digest: digest("8"), classification: "private", mediaType: "application/json" },
    { digest: digest("9"), classification: "private", mediaType: "image/png" },
  ],
};

const securityAttestation: CuaSecurityAttestation = {
  schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
  kind: "security-attestation",
  status: "enforced",
  bindings: {
    runtimeReadinessDigest: getCuaRuntimeReadinessDigest(readiness),
    targetIdentityDigest: attachment.target!.identityDigest,
    components: completedResult.components,
    inference: readiness.inference,
    appliedPolicy,
    capabilities: CUA_CAPABILITIES.map((id) => ({ id, protocolVersion: "1.0.0" })),
  },
  network: {
    defaultAction: "deny",
    managedInference: "only",
    targetServices: CUA_CAPABILITIES,
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
  verifier: readiness.components.securityVerifier,
};

function expectCuaStateQuarantined(
  trigger: string,
  name = "alpha",
  expectedTarget: CuaTargetAttachment = attachment,
): void {
  const entry = registry.getSandbox(name);
  expect(entry?.cuaRuntimeReadiness).toEqual(readiness);
  expect(entry?.cuaTarget).toEqual(expectedTarget);
  expect(entry?.cuaSecurityAttestation).toBeUndefined();
  expect(entry?.cuaTaskResults).toBeUndefined();
  expect(entry?.cuaReconciliation).toMatchObject({
    version: 1,
    phase: "required",
    trigger,
    runtimeReadinessDigest: expectedTarget.runtimeReadinessDigest,
    targetIdentityDigest: expectedTarget.target?.identityDigest ?? null,
  });
}

const fixtureValidation: CuaStateValidationDeps = {
  liveAppliedPolicy: appliedPolicy,
  validateRuntimeReadiness: (value, context) => {
    const parsed = parseCuaRuntimeReadiness(value);
    if (
      !cuaInferenceRoutesMatch(parsed.inference, context.recordedInference) ||
      (context.liveInference !== undefined &&
        !cuaInferenceRoutesMatch(parsed.inference, context.liveInference))
    ) {
      throw new Error("fixture route drift");
    }
    return parsed;
  },
};

function registerCompleteCuaState(extra: Omit<Partial<SandboxEntry>, "name"> = {}): void {
  registry.registerSandbox({
    name: "alpha",
    provider: readiness.inference.provider,
    model: readiness.inference.model,
    cuaRuntimeReadiness: readiness,
    cuaTarget: attachment,
    cuaSecurityAttestation: securityAttestation,
    cuaTaskResults: [completedResult],
    ...extra,
  });
}

beforeEach(() => {
  registry.clearAll();
});

afterAll(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(testHome, { recursive: true, force: true });
});

describe("CUA canonical registry state (#7751)", () => {
  it("quarantines the target without erasing external state when inference changes", () => {
    registerCompleteCuaState();

    expect(registry.updateSandboxInferenceRoute("alpha", { model: "fixture-model-2" })).toBe(true);

    expect(registry.getSandbox("alpha")).toMatchObject({
      provider: readiness.inference.provider,
      model: "fixture-model-2",
    });
    expectCuaStateQuarantined("inference-change");
    expect(registry.updateSandbox("alpha", { cuaRuntimeReadiness: readiness })).toBe(false);
  });

  it.each([
    ["provider", "compatible-endpoint-next"],
    ["model", "fixture/model-next"],
    ["endpointUrl", "https://next.example/v1"],
    ["endpointSource", "inference-set"],
    ["credentialEnv", "NEXT_API_KEY"],
    ["preferredInferenceApi", "openai-responses"],
    ["compatibleEndpointReasoning", "false"],
    ["compatibleEndpointReasoningEffort", "high"],
    ["nimContainer", "nim-next"],
  ] as const)("invalidates CUA authority when inference identity field %s changes", (field, value) => {
    registerCompleteCuaState({
      provider: "compatible-endpoint",
      model: "fixture/model",
      endpointUrl: "https://fixture.example/v1",
      endpointSource: "onboard",
      credentialEnv: "FIXTURE_API_KEY",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: "true",
      compatibleEndpointReasoningEffort: "low",
      nimContainer: "nim-fixture",
    });

    expect(registry.updateSandbox("alpha", { [field]: value } as Partial<SandboxEntry>)).toBe(true);

    expectCuaStateQuarantined("inference-change");
  });

  it("keeps CUA state when an inference update normalizes to the current identity", () => {
    registerCompleteCuaState({
      endpointUrl: "https://fixture.example/v1",
      endpointSource: "onboard",
    });

    expect(
      registry.updateSandbox("alpha", {
        provider: readiness.inference.provider,
        model: readiness.inference.model,
        endpointUrl: "https://fixture.example/v1",
        endpointSource: "onboard",
      }),
    ).toBe(true);

    expect(registry.getSandbox("alpha")?.cuaRuntimeReadiness).toEqual(readiness);
    expect(registry.getSandbox("alpha")?.cuaTarget).toEqual(attachment);
    expect(registry.getSandbox("alpha")?.cuaSecurityAttestation).toEqual(securityAttestation);
    expect(registry.getSandbox("alpha")?.cuaTaskResults).toEqual([completedResult]);
  });

  it.each([
    ["policies", ["strict"]],
    ["customPolicies", [{ name: "operator", content: "network_policies: {}" }]],
    ["policyTier", "restricted"],
    ["policyPresetsFinalized", true],
  ] as const)("quarantines CUA authority when policy identity field %s changes", (field, value) => {
    registerCompleteCuaState();

    expect(registry.updateSandbox("alpha", { [field]: value } as Partial<SandboxEntry>)).toBe(true);

    expectCuaStateQuarantined("policy-change");
  });

  it("blocks candidate-to-final readiness replacement until the target is reconciled", () => {
    registerCompleteCuaState();
    const replacement: CuaRuntimeReadiness = {
      ...readiness,
      components: {
        ...readiness.components,
        runtime: component("cua-fixture-next", "a"),
      },
    };

    expect(registry.updateSandbox("alpha", { cuaRuntimeReadiness: replacement })).toBe(false);
    expectCuaStateQuarantined("readiness-change");
    expect(registry.updateSandbox("alpha", { cuaRuntimeReadiness: undefined })).toBe(false);
    expectCuaStateQuarantined("readiness-change");
  });

  it("replaces readiness directly when no target effect can be orphaned", () => {
    registry.registerSandbox({ name: "alpha", cuaRuntimeReadiness: readiness });
    const replacement: CuaRuntimeReadiness = {
      ...readiness,
      components: { ...readiness.components, runtime: component("cua-fixture-next", "a") },
    };

    expect(registry.updateSandbox("alpha", { cuaRuntimeReadiness: replacement })).toBe(true);
    expect(registry.getSandbox("alpha")).toMatchObject({ cuaRuntimeReadiness: replacement });
    expect(registry.getSandbox("alpha")?.cuaReconciliation).toBeUndefined();
  });

  it("preserves derived authority when onboarding rewrites identical readiness", () => {
    registerCompleteCuaState();

    expect(
      registry.updateSandbox("alpha", { cuaRuntimeReadiness: structuredClone(readiness) }),
    ).toBe(true);

    expect(registry.getSandbox("alpha")?.cuaTarget).toEqual(attachment);
    expect(registry.getSandbox("alpha")?.cuaSecurityAttestation).toEqual(securityAttestation);
    expect(registry.getSandbox("alpha")?.cuaTaskResults).toEqual([completedResult]);
  });

  it("invalidates CUA authority through custom and baseline policy mutation APIs", () => {
    registerCompleteCuaState();
    expect(
      registry.addCustomPolicy("alpha", {
        name: "operator",
        content: "network_policies: {}",
      }),
    ).toBe(true);
    expectCuaStateQuarantined("policy-change");

    registerCompleteCuaState();
    expect(
      registry.beginBaselineExclusionTransition("alpha", {
        id: "00000000-0000-4000-8000-000000000001",
        operation: "exclude",
        exclusion: {
          version: 1,
          agent: "openclaw",
          key: "github",
          digest: "a".repeat(64),
        },
        targetLiveDigest: null,
        startedAt: "2026-08-04T00:00:00.000Z",
      }),
    ).toBe(true);
    expectCuaStateQuarantined("policy-change");
  });

  it("preserves an active task and reconciliation gate across restart", () => {
    const activeTarget: CuaTargetAttachment = {
      ...attachment,
      activeTask: { taskId: "task-live", status: "running", appliedPolicy },
    };
    registerCompleteCuaState({ cuaTarget: activeTarget });

    expect(registry.updateSandbox("alpha", { model: "fixture-model-2" })).toBe(true);
    expectCuaStateQuarantined("inference-change", "alpha", activeTarget);

    const reloaded = registry.load().sandboxes.alpha;
    expect(reloaded?.cuaTarget?.activeTask).toEqual(activeTarget.activeTask);
    expect(reloaded?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "inference-change",
      taskId: "task-live",
    });
  });

  it("recovers a crashed pending adapter journal as reconciliation-required", () => {
    registry.registerSandbox({
      name: "alpha",
      provider: readiness.inference.provider,
      model: readiness.inference.model,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaReconciliation: createCuaReconciliationState({
        phase: "pending",
        trigger: "target.destroy",
        operation: "target.destroy",
        runtimeReadinessDigest: attachment.runtimeReadinessDigest,
        targetIdentityDigest: attachment.target!.identityDigest,
      }),
    });

    expect(registry.load().sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "target.destroy",
    });
  });

  it("persists a snapshot-restore cleanup gate before sandbox mutation", () => {
    registerCompleteCuaState();

    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
    expectCuaStateQuarantined("snapshot-restore");
  });

  it("fails closed on a malformed persisted reconciliation journal", () => {
    const activeTarget: CuaTargetAttachment = {
      ...attachment,
      activeTask: { taskId: "task-live", status: "running", appliedPolicy },
    };
    registerCompleteCuaState({ cuaTarget: activeTarget });
    registry.registerSandbox({ name: "beta", agent: "hermes" });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    disk.sandboxes.alpha.cuaReconciliation = {
      phase: "required",
      endpoint: "https://private.invalid",
    };
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load();
    expect(loaded.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "registry-recovery",
      runtimeReadinessDigest: null,
      targetIdentityDigest: null,
      taskId: null,
      appliedPolicy: null,
    });
    expect(loaded.sandboxes.alpha?.cuaTarget?.activeTask).toEqual(activeTarget.activeTask);
    expect(loaded.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(loaded.sandboxes.beta).toMatchObject({ name: "beta", agent: "hermes" });
    expect(JSON.stringify(loaded.sandboxes.alpha?.cuaReconciliation)).not.toContain("private");
    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
  });

  it("keeps unrelated rows loadable when the journal and target are both malformed", () => {
    registerCompleteCuaState();
    registry.registerSandbox({ name: "beta", agent: "hermes" });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    disk.sandboxes.alpha.cuaReconciliation = {
      phase: "required",
      endpoint: "https://private.invalid",
    };
    disk.sandboxes.alpha.cuaTarget.runtimeReadinessDigest = "not-a-digest";
    disk.sandboxes.alpha.cuaTarget.target.identityDigest = "sk-private-coordinate";
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load();
    expect(loaded.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "registry-recovery",
      runtimeReadinessDigest: null,
      targetIdentityDigest: null,
      taskId: null,
      appliedPolicy: null,
    });
    expect(loaded.sandboxes.alpha?.cuaTarget).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(loaded.sandboxes.beta).toMatchObject({ name: "beta", agent: "hermes" });
    expect(JSON.stringify(loaded.sandboxes.alpha?.cuaReconciliation)).not.toMatch(
      /private|coordinate|endpoint/i,
    );
    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
  });

  it("round-trips only versioned runtime and target projections", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });

    expect(registry.getSandbox("alpha")).toMatchObject({
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    expect(JSON.stringify(disk.sandboxes.alpha.cuaTarget)).not.toMatch(
      /credential|password|secret|token|endpoint|hostName|ssh|vnc/i,
    );
  });

  it("quarantines a malformed persisted target before sandbox mutation", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    disk.sandboxes.alpha.cuaTarget.target.capabilities[0].health = "unchecked";
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load().sandboxes.alpha;
    expect(loaded).toMatchObject({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaReconciliation: {
        phase: "required",
        trigger: "registry-recovery",
        runtimeReadinessDigest: null,
        targetIdentityDigest: null,
        taskId: null,
        appliedPolicy: null,
      },
    });
    expect(loaded?.cuaTarget).toBeUndefined();
    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
  });

  it("quarantines a legacy malformed readiness chain without breaking unrelated rows", () => {
    registry.registerSandbox({ name: "alpha", agent: "openclaw" });
    registry.registerSandbox({ name: "beta", agent: "hermes" });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    disk.sandboxes.alpha.cuaRuntimeReadiness = {
      schemaVersion: CUA_LIFECYCLE_SCHEMA_VERSION,
      kind: "runtime-readiness",
      status: "available",
    };
    disk.sandboxes.alpha.cuaTarget = attachment;
    disk.sandboxes.alpha.cuaSecurityAttestation = securityAttestation;
    disk.sandboxes.alpha.cuaTaskResults = [completedResult];
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load();
    expect(loaded.sandboxes.alpha).toMatchObject({ name: "alpha", agent: "openclaw" });
    expect(loaded.sandboxes.alpha?.cuaRuntimeReadiness).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaTarget).toEqual(attachment);
    expect(loaded.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "registry-recovery",
      runtimeReadinessDigest: null,
      targetIdentityDigest: null,
      taskId: null,
      appliedPolicy: null,
    });
    expect(loaded.sandboxes.beta).toMatchObject({ name: "beta", agent: "hermes" });
    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
  });

  it("suppresses validated CUA state when the live inference route drifts", () => {
    const entry: SandboxEntry = {
      name: "alpha",
      provider: readiness.inference.provider,
      model: readiness.inference.model,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: securityAttestation,
    };

    expect(
      getValidatedCuaState(
        entry,
        { NEMOCLAW_CUA_ENABLED: "1" },
        readiness.inference,
        fixtureValidation,
      ),
    ).toMatchObject({ readiness, target: attachment, security: securityAttestation });
    expect(
      getValidatedCuaState(
        entry,
        { NEMOCLAW_CUA_ENABLED: "1" },
        {
          provider: "different",
          model: readiness.inference.model,
        },
        fixtureValidation,
      ),
    ).toEqual({ readiness: null, target: null, security: null });
    expect(getValidatedCuaState(entry, {})).toEqual({
      readiness: null,
      target: null,
      security: null,
    });
  });

  it("suppresses a policy-stale active task from every validated public projection", () => {
    const activeTarget: CuaTargetAttachment = {
      ...attachment,
      activeTask: { taskId: "task-1", status: "running", appliedPolicy },
    };
    const entry: SandboxEntry = {
      name: "alpha",
      provider: readiness.inference.provider,
      model: readiness.inference.model,
      cuaRuntimeReadiness: readiness,
      cuaTarget: activeTarget,
      cuaSecurityAttestation: securityAttestation,
    };

    const observed = getValidatedCuaState(
      entry,
      { NEMOCLAW_CUA_ENABLED: "1" },
      readiness.inference,
      {
        ...fixtureValidation,
        liveAppliedPolicy: { revision: 18, digest: digest("b") },
      },
    );

    expect(observed).toEqual({
      readiness,
      target: { ...activeTarget, activeTask: null },
      security: null,
    });
    expect(entry.cuaTarget?.activeTask?.taskId).toBe("task-1");
  });

  it("re-observes provider authority before projecting public CUA state", () => {
    const entry: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      provider: readiness.inference.provider,
      model: readiness.inference.model,
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: securityAttestation,
    };
    let observations = 0;
    const env = { NEMOCLAW_CUA_ENABLED: "1" };

    expect(
      getObservedValidatedCuaState(entry, env, {
        observeLiveInference: () => {
          observations += 1;
          return {
            ...readiness.inference,
            providerAuthorityDigest: readiness.providerAuthorityDigest,
          };
        },
        validation: fixtureValidation,
      }),
    ).toMatchObject({
      observation: "verified",
      readiness,
      target: attachment,
      security: securityAttestation,
    });
    expect(observations).toBe(1);

    expect(
      getObservedValidatedCuaState(entry, env, {
        observeLiveInference: () => {
          throw new Error("provider unavailable");
        },
        validation: fixtureValidation,
      }),
    ).toEqual({
      observation: "failed",
      failure: "inference",
      readiness: null,
      target: null,
      security: null,
    });

    expect(
      getObservedValidatedCuaState({ ...entry, agent: "openclaw" }, env, {
        observeLiveInference: () => {
          observations += 1;
          return readiness.inference;
        },
      }),
    ).toEqual({
      observation: "not-applicable",
      readiness: null,
      target: null,
      security: null,
    });
    expect(observations).toBe(1);
  });

  it("projects candidate readiness only through the dedicated qualification gate", () => {
    const entry: SandboxEntry = {
      name: "alpha",
      agent: "nemocua",
      provider: candidateReadiness.inference.provider,
      model: candidateReadiness.inference.model,
      cuaRuntimeReadiness: candidateReadiness,
    };
    const acceptances: Array<string | undefined> = [];
    const validation: CuaStateValidationDeps = {
      validateRuntimeReadiness: (value, context) => {
        acceptances.push(context.acceptance);
        return parseCuaRuntimeReadiness(value);
      },
    };

    expect(
      getValidatedCuaState(
        entry,
        {
          NEMOCLAW_CUA_ENABLED: "1",
          NEMOCLAW_CUA_QUALIFICATION: "1",
        },
        null,
        validation,
      ),
    ).toEqual({ readiness: candidateReadiness, target: null, security: null });
    expect(acceptances.at(-1)).toBe("candidate-qualification");

    expect(getValidatedCuaState(entry, { NEMOCLAW_CUA_ENABLED: "1" }, null, validation)).toEqual({
      readiness: null,
      target: null,
      security: null,
    });
    expect(acceptances.at(-1)).toBe("final");
  });
});

describe("CUA completed-task registry state (#7752)", () => {
  it("round-trips bounded secret-free task results for reconnect", () => {
    const completedResults = Array.from({ length: 17 }, (_, index) => ({
      ...completedResult,
      taskId: `task-${String(index + 1)}`,
    }));
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: securityAttestation,
      cuaTaskResults: completedResults,
    });

    expect(registry.getSandbox("alpha")?.cuaTaskResults).toHaveLength(16);
    expect(registry.getSandbox("alpha")?.cuaTaskResults?.[0].taskId).toBe("task-2");
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    expect(disk.sandboxes.alpha.cuaTaskResults).toHaveLength(16);
    expect(disk.sandboxes.alpha.cuaTaskResults[15].taskId).toBe("task-17");
    expect(JSON.stringify(disk.sandboxes.alpha.cuaTaskResults)).not.toMatch(
      /credential|password|secret|token|endpoint|hostName|ssh|vnc|path|url/i,
    );
  });

  it("quarantines legacy policy-unbound derived authority without losing valid state", () => {
    registerCompleteCuaState();
    registry.registerSandbox({ name: "beta", agent: "hermes" });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    delete disk.sandboxes.alpha.cuaSecurityAttestation.bindings.appliedPolicy;
    delete disk.sandboxes.alpha.cuaTaskResults[0].appliedPolicy;
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load();
    expect(loaded.sandboxes.alpha).toMatchObject({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
    });
    expect(loaded.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "registry-recovery",
      runtimeReadinessDigest: null,
      targetIdentityDigest: null,
      taskId: null,
      appliedPolicy: null,
    });
    expect(loaded.sandboxes.beta).toMatchObject({ name: "beta", agent: "hermes" });
    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
  });

  it("quarantines a legacy policy-unbound active task before sandbox mutation", () => {
    const activeTarget: CuaTargetAttachment = {
      ...attachment,
      activeTask: { taskId: "task-1", status: "running", appliedPolicy },
    };
    registerCompleteCuaState({ cuaTarget: activeTarget });
    registry.registerSandbox({ name: "beta", agent: "hermes" });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    delete disk.sandboxes.alpha.cuaTarget.activeTask.appliedPolicy;
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load();
    expect(loaded.sandboxes.alpha).toMatchObject({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
    });
    expect(loaded.sandboxes.alpha?.cuaTarget).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "registry-recovery",
      runtimeReadinessDigest: null,
      targetIdentityDigest: null,
      taskId: null,
      appliedPolicy: null,
    });
    expect(loaded.sandboxes.beta).toMatchObject({ name: "beta", agent: "hermes" });
    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
  });

  it("quarantines malformed retained task authority after restart", () => {
    registerCompleteCuaState();
    registry.registerSandbox({ name: "beta", agent: "hermes" });
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    disk.sandboxes.alpha.cuaTaskResults[0].endpoint = "https://private.invalid";
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load();
    expect(loaded.sandboxes.alpha).toMatchObject({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaReconciliation: {
        phase: "required",
        trigger: "registry-recovery",
        runtimeReadinessDigest: null,
        targetIdentityDigest: null,
        taskId: null,
        appliedPolicy: null,
      },
    });
    expect(loaded.sandboxes.alpha?.cuaSecurityAttestation).toBeUndefined();
    expect(loaded.sandboxes.alpha?.cuaTaskResults).toBeUndefined();
    expect(loaded.sandboxes.beta).toMatchObject({ name: "beta", agent: "hermes" });
    expect(
      registry.requireCuaReconciliationBeforeSandboxMutation("alpha", "snapshot-restore"),
    ).toBe(true);
  });
});

describe("CUA security registry state (#7754)", () => {
  it("round-trips only a content-free attestation and rejects authority fields", () => {
    registry.registerSandbox({
      name: "alpha",
      cuaRuntimeReadiness: readiness,
      cuaTarget: attachment,
      cuaSecurityAttestation: securityAttestation,
    });

    expect(registry.getSandbox("alpha")?.cuaSecurityAttestation).toEqual(securityAttestation);
    const disk = JSON.parse(fs.readFileSync(registry.REGISTRY_FILE, "utf8"));
    expect(JSON.stringify(disk.sandboxes.alpha.cuaSecurityAttestation)).not.toMatch(
      /"(endpoint|hostname|cookie|password|token|credential|ssh|vnc|path|url)"\s*:/i,
    );
    disk.sandboxes.alpha.cuaSecurityAttestation.endpoint = "https://host.invalid";
    fs.writeFileSync(registry.REGISTRY_FILE, JSON.stringify(disk));

    const loaded = registry.load().sandboxes.alpha;
    expect(loaded?.cuaRuntimeReadiness).toEqual(readiness);
    expect(loaded?.cuaTarget).toEqual(attachment);
    expect(loaded?.cuaSecurityAttestation).toBeUndefined();
    expect(loaded?.cuaReconciliation).toMatchObject({
      phase: "required",
      trigger: "registry-recovery",
      runtimeReadinessDigest: null,
      targetIdentityDigest: null,
      taskId: null,
      appliedPolicy: null,
    });
  });
});
