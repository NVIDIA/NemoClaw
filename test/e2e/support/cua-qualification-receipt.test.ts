// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CUA_ARTIFACT_CLEANUP_OPERATIONS,
  CUA_DENIED_DESTINATIONS,
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
} from "../../../src/lib/cua/contract.ts";
import { CUA_QUALIFICATION_DENIALS } from "../../../src/lib/cua/qualification-evidence.ts";
import type { CuaRuntimeManifest } from "../../../src/lib/cua/runtime-manifest.ts";
import {
  assertCuaCandidateManifestBindings,
  assertCuaCandidateRuntimeBindings,
  assertCuaQualificationCleanupBindings,
  assertCuaQualificationCliInvocationUnchanged,
  assertCuaQualificationDenialBinding,
  assertCuaQualificationEnvironmentBindings,
  assertCuaQualificationFileDigests,
  assertCuaQualificationFixtureBinding,
  assertCuaQualificationGitCheckout,
  assertCuaQualificationGpuBindings,
  assertCuaQualificationHostToolBindingsUnchanged,
  assertCuaQualificationObservedScenarioBindings,
  assertCuaQualificationProbeImageReference,
  assertCuaQualificationScenarioBindings,
  assertCuaQualificationStatusBindings,
  assertCuaQualificationTargetManifestBindings,
  assertCuaQualificationTaskInputExpectationFree,
  assertCuaReleaseBundleBindings,
  buildCuaQualificationArtifactEnvironment,
  buildCuaQualificationFixtureArgs,
  buildCuaQualificationGpuProbeArgs,
  buildCuaQualificationOracleArgs,
  CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES,
  CUA_QUALIFICATION_EVIDENCE_DIGEST_MAX,
  CUA_QUALIFICATION_FILE_MAX_BYTES,
  CUA_QUALIFICATION_SCENARIOS,
  consumeBoundedCuaQualificationJson,
  getCuaQualificationDenialOutcomeDigest,
  getCuaQualificationSandboxObservationDigest,
  getCuaQualificationTargetObservationDigest,
  hashBoundedCuaQualificationFile,
  parseCuaQualificationEnvironment,
  parseCuaQualificationFixtureOutput,
  parseCuaQualificationOracleOutput,
  parseCuaQualificationReceipt,
  parseCuaReleaseBundleReceipt,
  prepareCuaQualificationAuthority,
  readBoundedCuaQualificationJson,
  resolveCuaQualificationCliInvocation,
  resolveCuaQualificationExecutable,
  resolveCuaQualificationHostToolBindings,
  stageCuaQualificationAuthorityFiles,
} from "../../../tools/e2e/cua-qualification-receipt.mts";

const digest = (value: string): string => `sha256:${value.repeat(64).slice(0, 64)}`;
const tempDirectories: string[] = [];

function createGitCheckout(): { root: string; commit: string; trackedPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-git-checkout-"));
  tempDirectories.push(root);
  execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: root });
  const trackedPath = path.join(root, "tracked.txt");
  fs.writeFileSync(trackedPath, "tracked\n");
  execFileSync("/usr/bin/git", ["add", "tracked.txt"], { cwd: root });
  execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=CUA Test",
      "-c",
      "user.email=cua-test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: root },
  );
  const commit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, commit, trackedPath };
}

function component(name: string, value: string) {
  return { name, version: "1.0.0", digest: digest(value), owner: "fixture" };
}

function receipt(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-receipt",
    status: "passed",
    launchable: { version: "1.0.0", digest: digest("a") },
    gpu: {
      count: 1,
      model: "NVIDIA H100 80GB HBM3",
      driverVersion: "570.86.15",
      cudaVersion: "12.8",
      containerToolkitVersion: "1.17.8",
      probeImageDigest: digest("3"),
    },
    hostTools: {
      node: digest("d1"),
      docker: digest("d2"),
      nvidiaSmi: digest("d3"),
      nvidiaCtk: digest("d4"),
    },
    targetChannel: {
      schemaVersion: "1.0.0",
      kind: "cua-qualification-target-channel-identity",
      protocol: "cua.qualification.target-channel/v1",
      serviceBundleDigest: digest("4"),
      targetImageDigest: digest("3"),
    },
    nemoclawCommit: "c".repeat(40),
    bundleReceiptSha256: "d".repeat(64),
    inference: {
      provider: "nvidia",
      model: "nvidia/nvidia/nemotron-3-ultra",
      routeDigest: digest("a"),
    },
    components: {
      openshell: digest("0"),
      runtime: digest("1"),
      sandboxImage: digest("2"),
      targetAdapter: digest("f"),
      targetImage: digest("3"),
      serviceBundle: digest("4"),
      policy: digest("5"),
      taskProtocol: digest("6"),
      securityVerifier: digest("e"),
      fixture: digest("7"),
      oracle: digest("8"),
    },
    scenarios: CUA_QUALIFICATION_SCENARIOS.map((id, index) => {
      const fixtureStateDigest = digest(["10", "21", "32", "43"][index]);
      const stateDigest = digest(["54", "65", "76", "87"][index]);
      return {
        id,
        taskId: `task-${String(index)}`,
        status: "passed",
        fixtureStateDigest,
        stateDigest,
        evidenceDigests: [
          stateDigest,
          digest(["98", "a9", "ba", "cb"][index]),
          digest(["dc", "ed", "fe", "0f"][index]),
        ],
      };
    }),
    denials: CUA_QUALIFICATION_DENIALS.map((id) => ({
      id,
      outcomeDigest: getCuaQualificationDenialOutcomeDigest(id),
    })),
    cleanup: {
      targetDestroyObservationDigest: digest("a1"),
      nemoclawDestroyObservationDigest: digest("a2"),
      nemoclawStatusAbsenceObservationDigest: digest("a3"),
      nemoclawRegistryAbsenceObservationDigest: digest("a4"),
      openshellInventoryAbsenceObservationDigest: digest("a5"),
    },
  };
}

function qualificationEnvironment(): Record<string, unknown> {
  const valid = receipt();
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-environment",
    launchable: valid.launchable,
    nemoclawCommit: valid.nemoclawCommit,
    bundleReceiptSha256: valid.bundleReceiptSha256,
    gpu: valid.gpu,
    hostTools: valid.hostTools,
    targetChannel: valid.targetChannel,
  };
}

function gpuObservations() {
  const host = structuredClone(qualificationEnvironment().gpu) as {
    count: number;
    model: string;
    driverVersion: string;
    cudaVersion: string;
    containerToolkitVersion: string;
    probeImageDigest: string;
  };
  const { containerToolkitVersion: _containerToolkitVersion, ...probe } = host;
  return { host, probe };
}

const runtimeBindings = {
  sourceRevision: "c".repeat(40),
  sourceClean: true,
  runtimeManifestDigest: digest("a"),
  environmentDigest: digest("b"),
  bundleReceiptDigest: digest("d"),
};

function releaseBundle(): Record<string, unknown> {
  const components = receipt().components as Record<string, string>;
  return {
    schema: "cua.release.bundle/v1",
    releaseId: "nemocua-0.0.20-dev-v3-services-0.0.66-dev-v29",
    platform: "linux/amd64",
    artifacts: {
      cli: {
        version: "0.0.20-dev-v3",
        filename: "nemocua_linux_amd64.tar.gz",
        size: 12_322_325,
        sha256: components.runtime.slice("sha256:".length),
      },
      services: {
        version: "0.0.66-dev-v29",
        filename: "nemocua-services-linux-x86_64-v0.0.66-dev-v29.tar.gz",
        size: 183_706_364,
        sha256: components.serviceBundle.slice("sha256:".length),
      },
      image: {
        version: "v0.0.5",
        filename: "nvlumina-v0.0.5-linux-amd64.oci.tar",
        size: 123_061_760,
        sha256: digest("e").slice("sha256:".length),
        manifestDigest: components.targetImage,
      },
    },
  };
}

function runtimeManifest(): CuaRuntimeManifest {
  const file = (filename: string, sha256: string) => ({ filename, sizeBytes: 1, sha256 });
  const archive = (name: string, filename: string, sha256: string) => ({
    name,
    version: "1.0.0",
    ...file(filename, sha256),
    sourceRevision: "a".repeat(40),
  });
  const adapter = (name: string, filename: string, sha256: string) => ({
    name,
    version: "1.0.0",
    ...file(filename, sha256),
  });
  return {
    schemaVersion: "1.0.0",
    kind: "cua-runtime-manifest",
    agent: {
      name: "nemocua",
      manifest: file("agent.yaml", "9".repeat(64)),
      dockerfile: file("Dockerfile", "a".repeat(64)),
      baseDockerfile: file("Dockerfile.base", "b".repeat(64)),
      policy: file("policy.yaml", "5".repeat(64)),
    },
    compatibility: {
      status: "candidate",
      issue: 7755,
      candidateSourceRevision: "c".repeat(40),
    },
    bundleReceipt: {
      schema: "cua.release.bundle/v1",
      releaseId: "release-1",
      producerCommit: "a".repeat(40),
      sha256: "d".repeat(64),
    },
    artifacts: {
      hostCli: archive("nemocua", "runtime.tar.gz", "1".repeat(64)),
      sandboxImage: {
        name: "nemocua-sandbox",
        version: "1.0.0",
        platform: "linux/amd64",
        digest: digest("2"),
      },
      targetImage: {
        name: "nemocua-target",
        version: "1.0.0",
        platform: "linux/amd64",
        digest: digest("3"),
      },
      targetServices: archive("nemocua-services", "services.tar.gz", "4".repeat(64)),
      adapters: {
        target: adapter("target-adapter", "target-adapter", "f".repeat(64)),
        task: adapter("task-adapter", "task-adapter", "6".repeat(64)),
        security: adapter("security-adapter", "security-adapter", "e".repeat(64)),
      },
    },
    qualificationEvidence: null,
  };
}

function targetManifest(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    kind: "target-manifest",
    identityDigest: digest("f"),
    platform: "fixture-linux-amd64",
    image: component("target", "3"),
    serviceBundle: component("services", "4"),
    capabilities: [
      { id: "browser", protocolVersion: "1.0.0" },
      { id: "computer", protocolVersion: "1.0.0" },
      { id: "terminal", protocolVersion: "1.0.0" },
    ],
  };
}

function publicStatus(): Record<string, unknown> {
  const appliedPolicy = { revision: 17, digest: digest("a") } as const;
  const valid = receipt();
  const identities = valid.components as Record<string, string>;
  const inference = valid.inference as {
    provider: string;
    model: string;
    routeDigest: string;
  };
  const runtime: CuaRuntimeReadiness = {
    schemaVersion: "1.1.0",
    kind: "runtime-readiness",
    agent: "nemocua",
    mode: "standalone",
    status: "candidate",
    sourceRevision: "c".repeat(40),
    sourceClean: true,
    runtimeManifestDigest: runtimeBindings.runtimeManifestDigest,
    providerAuthorityDigest: digest("0"),
    qualification: {
      state: "candidate",
      environmentDigest: runtimeBindings.environmentDigest,
      bundleReceiptDigest: runtimeBindings.bundleReceiptDigest,
    },
    components: {
      openshell: component("openshell", "0"),
      runtime: component("runtime", "1"),
      sandboxImage: component("sandbox", "2"),
      targetAdapter: component("target-adapter", "f"),
      policy: component("policy", "5"),
      taskProtocol: component("protocol", "6"),
      securityVerifier: component("verifier", "e"),
    },
    inference,
    commands: { interactive: true, headless: true, version: true, smoke: true },
    limits: { targetsPerWorker: 1, activeTasksPerTarget: 1 },
    requiredCapabilities: ["browser", "computer", "terminal"],
    targetOperations: CUA_TARGET_OPERATIONS,
    taskOperations: CUA_TASK_OPERATIONS,
    securityOperations: ["security.status", "security.verify"],
  };
  const readinessDigest = getCuaRuntimeReadinessDigest(runtime);
  const target: CuaTargetAttachment = {
    schemaVersion: "1.1.0",
    kind: "target-attachment",
    status: "attached",
    runtimeReadinessDigest: readinessDigest,
    target: {
      identityDigest: digest("f"),
      platform: "fixture-linux-amd64",
      image: component("target", "3"),
      serviceBundle: component("services", "4"),
      capabilities: [
        { id: "browser", protocolVersion: "1.0.0", health: "healthy" },
        { id: "computer", protocolVersion: "1.0.0", health: "healthy" },
        { id: "terminal", protocolVersion: "1.0.0", health: "healthy" },
      ],
    },
    activeTask: null,
  };
  const targetProjection = target.target!;
  const security: CuaSecurityAttestation = {
    schemaVersion: "1.1.0",
    kind: "security-attestation",
    status: "enforced",
    bindings: {
      runtimeReadinessDigest: readinessDigest,
      targetIdentityDigest: targetProjection.identityDigest,
      components: {
        openshell: runtime.components.openshell,
        runtime: runtime.components.runtime,
        sandboxImage: runtime.components.sandboxImage,
        targetImage: targetProjection.image,
        serviceBundle: targetProjection.serviceBundle,
        policy: runtime.components.policy,
        taskProtocol: runtime.components.taskProtocol,
      },
      inference,
      appliedPolicy,
      capabilities: [
        { id: "browser", protocolVersion: "1.0.0" },
        { id: "computer", protocolVersion: "1.0.0" },
        { id: "terminal", protocolVersion: "1.0.0" },
      ],
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
    verifier: runtime.components.securityVerifier,
  };
  expect(runtime.components.runtime.digest).toBe(identities.runtime);
  return { cuaRuntime: runtime, cuaTarget: target, cuaSecurity: security };
}

function scenarioObservation(id: (typeof CUA_QUALIFICATION_SCENARIOS)[number]): {
  scenario: ReturnType<typeof parseCuaQualificationReceipt>["scenarios"][number];
  result: CuaTaskResult;
} {
  const parsedReceipt = parseCuaQualificationReceipt(receipt());
  const scenario = parsedReceipt.scenarios.find((entry) => entry.id === id)!;
  if (scenario.id !== id) throw new Error(`missing ${id} scenario fixture`);
  const status = publicStatus();
  const runtime = status.cuaRuntime as CuaRuntimeReadiness;
  const target = (status.cuaTarget as CuaTargetAttachment).target!;
  const appliedPolicy = (status.cuaSecurity as CuaSecurityAttestation).bindings.appliedPolicy;
  const result: CuaTaskResult = {
    schemaVersion: "1.1.0",
    kind: "task-result",
    taskId: scenario.taskId,
    status: "succeeded",
    targetIdentityDigest: target.identityDigest,
    runtimeReadinessDigest: getCuaRuntimeReadinessDigest(runtime),
    components: {
      openshell: runtime.components.openshell,
      runtime: runtime.components.runtime,
      sandboxImage: runtime.components.sandboxImage,
      targetImage: target.image,
      serviceBundle: target.serviceBundle,
      policy: runtime.components.policy,
      taskProtocol: runtime.components.taskProtocol,
    },
    inference: runtime.inference,
    appliedPolicy,
    capabilities: target.capabilities
      .filter(({ id: capabilityId }) => capabilityId === "browser")
      .map(({ id: capabilityId, protocolVersion }) => ({ id: capabilityId, protocolVersion })),
    agentResult: { status: "succeeded", resultDigest: scenario.stateDigest },
    verification: {
      status: "passed",
      checkIds: [`${id}-oracle`],
      evidenceDigests: [scenario.evidenceDigests[1]],
    },
    receipts: [
      {
        capability: "browser",
        status: "completed" as const,
        evidenceDigests: [scenario.evidenceDigests[1]],
      },
    ],
    evidence: scenario.evidenceDigests.map((evidenceDigest) => ({
      digest: evidenceDigest,
      classification: "private" as const,
      mediaType: "application/json",
    })),
  };
  return { scenario, result };
}

function scenarioProtocol(id: (typeof CUA_QUALIFICATION_SCENARIOS)[number]): ReturnType<
  typeof scenarioObservation
> & {
  binding: {
    scenario: (typeof CUA_QUALIFICATION_SCENARIOS)[number];
    taskId: string;
    sandboxName: string;
    targetIdentityDigest: string;
    runtimeReadinessDigest: string;
  };
  fixtureStdout: string;
  oracleStdout: string;
} {
  const observation = scenarioObservation(id);
  const binding = {
    scenario: id,
    taskId: observation.scenario.taskId,
    sandboxName: "cua-qualification-test",
    targetIdentityDigest: observation.result.targetIdentityDigest,
    runtimeReadinessDigest: observation.result.runtimeReadinessDigest,
  } as const;
  return {
    ...observation,
    binding,
    fixtureStdout: JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "cua-qualification-fixture-state",
      scenario: id,
      taskId: observation.scenario.taskId,
      sandboxName: binding.sandboxName,
      targetIdentityDigest: binding.targetIdentityDigest,
      runtimeReadinessDigest: binding.runtimeReadinessDigest,
      fixtureStateDigest: observation.scenario.fixtureStateDigest,
    }),
    oracleStdout: JSON.stringify({
      schemaVersion: "1.0.0",
      kind: "cua-qualification-oracle-observation",
      scenario: id,
      taskId: observation.scenario.taskId,
      sandboxName: binding.sandboxName,
      targetIdentityDigest: binding.targetIdentityDigest,
      runtimeReadinessDigest: binding.runtimeReadinessDigest,
      stateDigest: observation.scenario.stateDigest,
      evidenceDigests: observation.scenario.evidenceDigests,
    }),
  };
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    if (!fs.existsSync(directory)) continue;
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CUA GPU qualification receipt (#7753)", () => {
  it("accepts exact content-free identities and binds the full public runtime tuple", () => {
    const parsed = parseCuaQualificationReceipt(receipt());
    expect(parsed).toEqual(receipt());
    const environment = parseCuaQualificationEnvironment(qualificationEnvironment());
    expect(environment).toEqual(qualificationEnvironment());
    expect(() => assertCuaQualificationEnvironmentBindings(environment, parsed)).not.toThrow();
    expect(() =>
      assertCuaQualificationFileDigests(
        {
          environment: digest("a"),
          receipt: digest("b"),
          bundleReceipt: digest("c"),
        },
        {
          environment: digest("a"),
          receipt: digest("b"),
          bundleReceipt: digest("c"),
        },
      ),
    ).not.toThrow();
    expect(() =>
      assertCuaQualificationGpuBindings(environment, parsed, gpuObservations()),
    ).not.toThrow();
    const bundle = parseCuaReleaseBundleReceipt(releaseBundle());
    expect(bundle).toEqual(releaseBundle());
    expect(() => assertCuaReleaseBundleBindings(bundle, parsed)).not.toThrow();
    expect(() => assertCuaCandidateManifestBindings(runtimeManifest(), parsed)).not.toThrow();
    expect(() =>
      assertCuaQualificationTargetManifestBindings(targetManifest(), parsed),
    ).not.toThrow();
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, publicStatus().cuaRuntime, runtimeBindings),
    ).not.toThrow();
    expect(() =>
      assertCuaQualificationStatusBindings(parsed, publicStatus(), runtimeBindings),
    ).not.toThrow();
  });

  it("strictly parses and binds the fixed qualification target channel", () => {
    const missingEnvironment = qualificationEnvironment();
    delete missingEnvironment.targetChannel;
    expect(() => parseCuaQualificationEnvironment(missingEnvironment)).toThrow(/contain exactly/);

    const missingReceipt = receipt();
    delete missingReceipt.targetChannel;
    expect(() => parseCuaQualificationReceipt(missingReceipt)).toThrow(/contain exactly/);

    const extra = receipt();
    Object.assign(extra.targetChannel as Record<string, unknown>, {
      endpoint: "private.invalid",
    });
    expect(() => parseCuaQualificationReceipt(extra)).toThrow(/contain exactly/);

    const wrongKind = qualificationEnvironment();
    (wrongKind.targetChannel as Record<string, unknown>).kind = "target-channel";
    expect(() => parseCuaQualificationEnvironment(wrongKind)).toThrow(/targetChannel kind/);

    const wrongProtocol = receipt();
    (wrongProtocol.targetChannel as Record<string, unknown>).protocol =
      "cua.qualification.target-channel/v2";
    expect(() => parseCuaQualificationReceipt(wrongProtocol)).toThrow(/targetChannel protocol/);

    const mutableDigest = receipt();
    (mutableDigest.targetChannel as Record<string, unknown>).targetImageDigest = "latest";
    expect(() => parseCuaQualificationReceipt(mutableDigest)).toThrow(/sha256 digest/);

    const mismatchedIdentity = qualificationEnvironment();
    (mismatchedIdentity.targetChannel as Record<string, unknown>).targetImageDigest = digest("f");
    expect(() =>
      assertCuaQualificationEnvironmentBindings(
        parseCuaQualificationEnvironment(mismatchedIdentity),
        parseCuaQualificationReceipt(receipt()),
      ),
    ).toThrow(/identities do not match/);

    const changedService = receipt();
    (changedService.targetChannel as Record<string, unknown>).serviceBundleDigest = digest("f");
    (changedService.components as Record<string, unknown>).serviceBundle = digest("f");
    expect(() =>
      assertCuaCandidateManifestBindings(
        runtimeManifest(),
        parseCuaQualificationReceipt(changedService),
      ),
    ).toThrow(/targetChannel serviceBundleDigest/);

    const changedImage = receipt();
    (changedImage.targetChannel as Record<string, unknown>).targetImageDigest = digest("f");
    (changedImage.components as Record<string, unknown>).targetImage = digest("f");
    expect(() =>
      assertCuaCandidateManifestBindings(
        runtimeManifest(),
        parseCuaQualificationReceipt(changedImage),
      ),
    ).toThrow(/targetChannel targetImageDigest/);
  });

  it("binds independently classified final cleanup", () => {
    const sandboxName = "cua-qualification-test";
    const attached = publicStatus().cuaTarget as CuaTargetAttachment;
    const detached: CuaTargetAttachment = {
      schemaVersion: "1.1.0",
      kind: "target-attachment",
      status: "detached",
      runtimeReadinessDigest: attached.runtimeReadinessDigest,
      target: null,
      activeTask: null,
    };
    const value = receipt();
    value.cleanup = {
      targetDestroyObservationDigest: getCuaQualificationTargetObservationDigest(
        "cleanup-target-destroy",
        detached,
      ),
      nemoclawDestroyObservationDigest: getCuaQualificationSandboxObservationDigest(
        "nemoclaw-destroyed",
        sandboxName,
      ),
      nemoclawStatusAbsenceObservationDigest: getCuaQualificationSandboxObservationDigest(
        "nemoclaw-status-absent",
        sandboxName,
      ),
      nemoclawRegistryAbsenceObservationDigest: getCuaQualificationSandboxObservationDigest(
        "nemoclaw-registry-absent",
        sandboxName,
      ),
      openshellInventoryAbsenceObservationDigest: getCuaQualificationSandboxObservationDigest(
        "openshell-inventory-absent",
        sandboxName,
      ),
    };
    const parsed = parseCuaQualificationReceipt(value);
    expect(() =>
      assertCuaQualificationCleanupBindings(parsed, {
        targetDestroy: detached,
        sandboxName,
        nemoclawDestroy: "completed",
        nemoclawStatus: "absent",
        nemoclawRegistry: "absent",
        openshellInventory: "absent",
      }),
    ).not.toThrow();

    expect(() =>
      assertCuaQualificationCleanupBindings(parsed, {
        targetDestroy: detached,
        sandboxName: "another-sandbox",
        nemoclawDestroy: "completed",
        nemoclawStatus: "absent",
        nemoclawRegistry: "absent",
        openshellInventory: "absent",
      }),
    ).toThrow(/do not match/);
  });

  it("rejects missing browser evidence, incomplete cleanup, and extra data", () => {
    const missing = receipt();
    (missing.scenarios as unknown[]).pop();
    expect(() => parseCuaQualificationReceipt(missing)).toThrow(/exactly one browser/);

    const extraScenario = receipt();
    (extraScenario.scenarios as unknown[]).push(
      structuredClone((extraScenario.scenarios as unknown[])[0]),
    );
    expect(() => parseCuaQualificationReceipt(extraScenario)).toThrow(/exactly one browser/);

    const incompleteCleanup = receipt();
    delete (incompleteCleanup.cleanup as Record<string, unknown>)
      .openshellInventoryAbsenceObservationDigest;
    expect(() => parseCuaQualificationReceipt(incompleteCleanup)).toThrow(/contain exactly/);

    const mutableIdentity = receipt();
    (mutableIdentity.components as Record<string, unknown>).runtime = "latest";
    expect(() => parseCuaQualificationReceipt(mutableIdentity)).toThrow(/sha256 digest/);

    const missingFixtureState = receipt();
    delete (missingFixtureState.scenarios as Array<Record<string, unknown>>)[0].fixtureStateDigest;
    expect(() => parseCuaQualificationReceipt(missingFixtureState)).toThrow(/contain exactly/);

    const unchangedFixtureState = receipt();
    const unchangedScenario = (
      unchangedFixtureState.scenarios as Array<Record<string, unknown>>
    )[0];
    unchangedScenario.fixtureStateDigest = unchangedScenario.stateDigest;
    expect(() => parseCuaQualificationReceipt(unchangedFixtureState)).toThrow(
      /fixture state must be distinct/,
    );

    const missingStateEvidence = receipt();
    const missingStateScenario = (
      missingStateEvidence.scenarios as Array<Record<string, unknown>>
    )[0];
    missingStateScenario.evidenceDigests = [digest("f")];
    expect(() => parseCuaQualificationReceipt(missingStateEvidence)).toThrow(
      /state digest must be included/,
    );

    const missingDenial = receipt();
    (missingDenial.denials as unknown[]).pop();
    expect(() => parseCuaQualificationReceipt(missingDenial)).toThrow(/exactly four/);

    const mismatchedEnvironment = qualificationEnvironment();
    mismatchedEnvironment.nemoclawCommit = "d".repeat(40);
    expect(() =>
      assertCuaQualificationEnvironmentBindings(
        parseCuaQualificationEnvironment(mismatchedEnvironment),
        parseCuaQualificationReceipt(receipt()),
      ),
    ).toThrow(/identities do not match/);

    const mismatchedProbeTarget = receipt();
    (mismatchedProbeTarget.components as Record<string, unknown>).targetImage = digest("f");
    expect(() =>
      assertCuaQualificationEnvironmentBindings(
        parseCuaQualificationEnvironment(qualificationEnvironment()),
        parseCuaQualificationReceipt(mismatchedProbeTarget),
      ),
    ).toThrow(/probe image does not match the targetImage/);

    const authorityBearing = receipt();
    authorityBearing.endpoint = "private.example";
    expect(() => parseCuaQualificationReceipt(authorityBearing)).toThrow(/contain exactly/);
  });

  it("binds each required denial to a concrete public fail-closed observation", () => {
    const parsed = parseCuaQualificationReceipt(receipt());
    const observations = {
      "target-adapter-substitution": {
        schemaVersion: "1.1.0",
        kind: "failure",
        operation: "target.health",
        family: "validation_failed",
        retryable: false,
        component: "target",
      },
      "task-adapter-substitution": {
        schemaVersion: "1.1.0",
        kind: "failure",
        operation: "task.status",
        family: "validation_failed",
        retryable: false,
      },
      "security-adapter-substitution": {
        schemaVersion: "1.1.0",
        kind: "failure",
        operation: "security.verify",
        family: "validation_failed",
        retryable: false,
        component: "runtime",
      },
      "policy-boundary-violation": {
        schemaVersion: "1.1.0",
        kind: "failure",
        operation: "security.verify",
        family: "policy_invalid",
        retryable: false,
        component: "policy",
      },
    } as const;
    for (const id of CUA_QUALIFICATION_DENIALS) {
      expect(assertCuaQualificationDenialBinding(parsed, id, observations[id])).toEqual(
        observations[id],
      );
    }

    const mismatchedReceipt = parseCuaQualificationReceipt(receipt());
    mismatchedReceipt.denials[0]!.outcomeDigest = digest("f");
    expect(() =>
      assertCuaQualificationDenialBinding(
        mismatchedReceipt,
        "target-adapter-substitution",
        observations["target-adapter-substitution"],
      ),
    ).toThrow(/does not match the qualification receipt/);
    expect(() =>
      assertCuaQualificationDenialBinding(parsed, "target-adapter-substitution", {
        ...observations["target-adapter-substitution"],
        family: "target_unreachable",
      }),
    ).toThrow(/required fail-closed public outcome/);
  });

  it.each([
    ["URL", "https://private.example/model"],
    ["userinfo", "operator@private.example"],
    ["query", "model?token=value"],
    ["fragment", "model#private"],
    ["control character", "model\nnext"],
    ["GitHub token", "ghp_abcdefghijklmnopqrstuvwxyz"],
    ["API key", "sk-abcdefghijklmnopqrstuvwxyz"],
    ["IPv4 coordinate", "127.0.0.1/model"],
    ["IPv6 coordinate", "[::1]/model"],
    ["localhost coordinate", "localhost/model"],
  ])("rejects %s-shaped inference values", (_label, value) => {
    const invalid = receipt();
    (invalid.inference as Record<string, unknown>).model = value;
    expect(() => parseCuaQualificationReceipt(invalid)).toThrow(/coordinate- and credential-free/);
  });

  it("uses the immutable final evidence parser for the live qualification boundary", () => {
    const invalidReceipt = receipt();
    (invalidReceipt.gpu as Record<string, unknown>).driverVersion = "570 86 15";
    expect(() => parseCuaQualificationReceipt(invalidReceipt)).toThrow();

    const invalidEnvironment = qualificationEnvironment();
    (invalidEnvironment.gpu as Record<string, unknown>).containerToolkitVersion = "1 17 8";
    expect(() => parseCuaQualificationEnvironment(invalidEnvironment)).toThrow();
  });

  it("rejects raw qualification file-hash drift", () => {
    const actual = {
      environment: digest("a"),
      receipt: digest("b"),
      bundleReceipt: digest("c"),
    };
    for (const key of ["environment", "receipt", "bundleReceipt"] as const) {
      expect(() =>
        assertCuaQualificationFileDigests(actual, { ...actual, [key]: digest("f") }),
      ).toThrow(new RegExp(`${key} file digest`));
    }
  });

  it("requires Docker to resolve the exact immutable GPU probe image", () => {
    const reference = `nvcr.io/nvidia/cuda@${digest("a")}`;
    expect(assertCuaQualificationProbeImageReference(reference, [reference])).toBe(digest("a"));
    expect(() =>
      assertCuaQualificationProbeImageReference(reference, [`nvcr.io/nvidia/cuda@${digest("b")}`]),
    ).toThrow(/exact immutable repository digest/);
    expect(() =>
      assertCuaQualificationProbeImageReference("nvcr.io/nvidia/cuda:latest", [reference]),
    ).toThrow(/exact immutable repository digest/);
    expect(() =>
      assertCuaQualificationProbeImageReference(reference, [reference, "https://private.invalid"]),
    ).toThrow(/exact immutable repository digest/);

    const argv = buildCuaQualificationGpuProbeArgs(reference, digest("a"), "model");
    expect(argv).toEqual([
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--user=65534:65534",
      "--pids-limit=64",
      "--memory=512m",
      "--cpus=1",
      "--ulimit=nofile=64:64",
      "--gpus=all",
      "--entrypoint=/usr/bin/nvidia-smi",
      reference,
      "--query-gpu=name",
      "--format=csv,noheader",
    ]);
    expect(() => buildCuaQualificationGpuProbeArgs(reference, digest("b"), "summary")).toThrow(
      /approved immutable digest/,
    );
  });

  it("rejects hidden Git index state and compares tracked bytes to the exact HEAD", () => {
    const clean = createGitCheckout();
    expect(() => assertCuaQualificationGitCheckout(clean.root, clean.commit)).not.toThrow();

    const dirty = createGitCheckout();
    fs.writeFileSync(dirty.trackedPath, "changed\n");
    expect(() => assertCuaQualificationGitCheckout(dirty.root, dirty.commit)).toThrow(
      /not the exact clean receipt-bound source/,
    );

    const assumed = createGitCheckout();
    execFileSync("/usr/bin/git", ["update-index", "--assume-unchanged", "tracked.txt"], {
      cwd: assumed.root,
    });
    fs.writeFileSync(assumed.trackedPath, "hidden change\n");
    expect(() => assertCuaQualificationGitCheckout(assumed.root, assumed.commit)).toThrow(
      /not the exact clean receipt-bound source/,
    );

    const skipped = createGitCheckout();
    execFileSync("/usr/bin/git", ["update-index", "--skip-worktree", "tracked.txt"], {
      cwd: skipped.root,
    });
    fs.writeFileSync(skipped.trackedPath, "hidden change\n");
    expect(() => assertCuaQualificationGitCheckout(skipped.root, skipped.commit)).toThrow(
      /not the exact clean receipt-bound source/,
    );
  });

  it("pins live qualification to the checkout launcher despite CLI and PATH shadowing (#7753)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-cli-invocation-"));
    tempDirectories.push(root);
    const bin = path.join(root, "bin");
    const shadow = path.join(root, "shadow");
    fs.mkdirSync(bin);
    fs.mkdirSync(shadow);
    const launcher = path.join(bin, "nemoclaw.js");
    const shadowLauncher = path.join(shadow, "nemoclaw");
    fs.writeFileSync(launcher, "#!/usr/bin/env node\n", { mode: 0o755 });
    fs.writeFileSync(shadowLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const invocation = resolveCuaQualificationCliInvocation(
      root,
      {
        NEMOCLAW_CLI_BIN: launcher,
        PATH: shadow,
      },
      "/bin/sh",
    );

    expect(invocation.command).toBe(fs.realpathSync("/bin/sh"));
    expect(invocation.argsPrefix).toEqual([fs.realpathSync(launcher)]);
    expect(invocation.cwd).toBe(fs.realpathSync(root));
    expect(invocation.path.split(":")).not.toContain(shadow);
    expect(() => assertCuaQualificationCliInvocationUnchanged(invocation)).not.toThrow();
    expect(() =>
      resolveCuaQualificationCliInvocation(
        root,
        {
          NEMOCLAW_CLI_BIN: shadowLauncher,
          PATH: shadow,
        },
        "/bin/sh",
      ),
    ).toThrow(/exact qualification checkout launcher/);

    fs.writeFileSync(launcher, "#!/usr/bin/env node\nthrow new Error('replaced');\n");
    expect(() => assertCuaQualificationCliInvocationUnchanged(invocation)).toThrow(
      /changed during live execution/,
    );
  });

  it("binds every host qualification tool to root-owned immutable bytes", () => {
    const paths = {
      node: "/bin/sh",
      docker: "/usr/bin/true",
      nvidiaSmi: "/usr/bin/false",
      nvidiaCtk: "/usr/bin/printf",
    };
    const expected = Object.fromEntries(
      Object.entries(paths).map(([key, executablePath]) => [
        key,
        resolveCuaQualificationExecutable(executablePath, key).digest,
      ]),
    ) as Record<keyof typeof paths, string>;
    const bindings = resolveCuaQualificationHostToolBindings(expected, paths);
    expect(() => assertCuaQualificationHostToolBindingsUnchanged(bindings)).not.toThrow();
    expect(() =>
      resolveCuaQualificationHostToolBindings({ ...expected, docker: digest("f") }, paths),
    ).toThrow(/hostTools.docker/);

    const mutableDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-host-tool-"));
    tempDirectories.push(mutableDirectory);
    const mutable = path.join(mutableDirectory, "mutable-tool");
    fs.writeFileSync(mutable, "#!/bin/sh\n", { mode: 0o755 });
    expect(() =>
      resolveCuaQualificationExecutable(fs.realpathSync(mutable), "mutable tool"),
    ).toThrow(/root-owned/);
  });

  it("rejects every unobserved or mismatched GPU and probe-image claim", () => {
    const environment = parseCuaQualificationEnvironment(qualificationEnvironment());
    const parsedReceipt = parseCuaQualificationReceipt(receipt());
    for (const key of [
      "count",
      "model",
      "driverVersion",
      "cudaVersion",
      "containerToolkitVersion",
      "probeImageDigest",
    ] as const) {
      const changed = gpuObservations();
      const host = changed.host as unknown as Record<string, unknown>;
      host[key] =
        key === "count" ? 2 : key === "probeImageDigest" ? digest("f") : `${String(host[key])}x`;
      expect(() => assertCuaQualificationGpuBindings(environment, parsedReceipt, changed)).toThrow(
        new RegExp(`live host GPU ${key}`),
      );
    }

    for (const key of [
      "count",
      "model",
      "driverVersion",
      "cudaVersion",
      "probeImageDigest",
    ] as const) {
      const changed = gpuObservations();
      const probe = changed.probe as unknown as Record<string, unknown>;
      probe[key] =
        key === "count" ? 2 : key === "probeImageDigest" ? digest("f") : `${String(probe[key])}x`;
      expect(() => assertCuaQualificationGpuBindings(environment, parsedReceipt, changed)).toThrow(
        new RegExp(`live probe GPU ${key}`),
      );
    }
  });

  it("caps evidence cardinality and rejects public tuple mismatches", () => {
    const tooMany = receipt();
    ((tooMany.scenarios as Array<Record<string, unknown>>)[0].evidenceDigests as string[]) =
      Array.from({ length: CUA_QUALIFICATION_EVIDENCE_DIGEST_MAX + 1 }, (_, index) =>
        digest(String(index % 10)),
      );
    expect(() => parseCuaQualificationReceipt(tooMany)).toThrow(/1 through 16/);

    const parsed = parseCuaQualificationReceipt(receipt());
    const status = publicStatus();
    (
      (status.cuaTarget as Record<string, unknown>).target as Record<string, unknown>
    ).serviceBundle = component("services", "a");
    expect(() => assertCuaQualificationStatusBindings(parsed, status, runtimeBindings)).toThrow(
      /serviceBundle does not match/,
    );

    const verifierStatus = publicStatus();
    (verifierStatus.cuaSecurity as CuaSecurityAttestation).verifier = component(
      "unregistered-verifier",
      "f",
    );
    expect(() =>
      assertCuaQualificationStatusBindings(parsed, verifierStatus, runtimeBindings),
    ).toThrow(/security\.verifier does not match/);

    const securityRoute = publicStatus();
    const securityAttestation = securityRoute.cuaSecurity as CuaSecurityAttestation;
    securityAttestation.bindings.inference = {
      ...securityAttestation.bindings.inference,
      routeDigest: digest("f"),
    };
    expect(() =>
      assertCuaQualificationStatusBindings(parsed, securityRoute, runtimeBindings),
    ).toThrow(/inference state is not bound/);
  });

  it("rejects drift in every manifest and public-status component binding", () => {
    for (const key of [
      "runtime",
      "sandboxImage",
      "targetAdapter",
      "targetImage",
      "serviceBundle",
      "policy",
      "taskProtocol",
      "securityVerifier",
    ] as const) {
      const changedReceipt = parseCuaQualificationReceipt(receipt());
      changedReceipt.components[key] = digest("b");
      expect(() => assertCuaCandidateManifestBindings(runtimeManifest(), changedReceipt)).toThrow(
        new RegExp(key),
      );
    }

    for (const key of [
      "openshell",
      "runtime",
      "sandboxImage",
      "targetAdapter",
      "policy",
      "taskProtocol",
      "securityVerifier",
    ] as const) {
      const status = publicStatus();
      const runtime = status.cuaRuntime as CuaRuntimeReadiness;
      runtime.components[key] = component(`changed-${key}`, "b");
      expect(() =>
        assertCuaCandidateRuntimeBindings(
          parseCuaQualificationReceipt(receipt()),
          runtime,
          runtimeBindings,
        ),
      ).toThrow(new RegExp(key));
    }

    for (const key of [
      "runtime",
      "sandboxImage",
      "targetImage",
      "serviceBundle",
      "policy",
      "taskProtocol",
    ] as const) {
      const status = publicStatus();
      const security = status.cuaSecurity as CuaSecurityAttestation;
      security.bindings.components[key] = component(`changed-${key}`, "b");
      expect(() =>
        assertCuaQualificationStatusBindings(
          parseCuaQualificationReceipt(receipt()),
          status,
          runtimeBindings,
        ),
      ).toThrow(new RegExp(`security\\.bindings\\.components\\.${key}`));
    }

    for (const key of ["image", "serviceBundle"] as const) {
      const status = publicStatus();
      const target = (status.cuaTarget as CuaTargetAttachment).target!;
      target[key] = component(`changed-${key}`, "f");
      expect(() =>
        assertCuaQualificationStatusBindings(
          parseCuaQualificationReceipt(receipt()),
          status,
          runtimeBindings,
        ),
      ).toThrow(new RegExp(key === "image" ? "targetImage" : "serviceBundle"));
    }
  });

  it("binds every scenario receipt claim to independently observed public task output", () => {
    const parsedReceipt = parseCuaQualificationReceipt(receipt());
    for (const id of CUA_QUALIFICATION_SCENARIOS) {
      const observation = scenarioObservation(id);
      expect(
        assertCuaQualificationScenarioBindings(
          parsedReceipt,
          observation.scenario,
          observation.result,
        ),
      ).toEqual(observation.result);
    }
  });

  it("executes the exact content-free fixture and oracle protocol for each scenario", () => {
    const parsedReceipt = parseCuaQualificationReceipt(receipt());
    const inputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-task-input-"));
    tempDirectories.push(inputDirectory);
    const sourceTaskInputPath = path.join(inputDirectory, "task.txt");
    fs.writeFileSync(sourceTaskInputPath, "perform the pinned qualification scenario\n", {
      mode: 0o400,
    });
    const taskInputPath = fs.realpathSync(sourceTaskInputPath);
    const artifactEnvironment = buildCuaQualificationArtifactEnvironment("/usr/bin:/bin");
    expect(artifactEnvironment).toEqual({ LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" });

    for (const id of CUA_QUALIFICATION_SCENARIOS) {
      const protocol = scenarioProtocol(id);
      const fixtureArgs = buildCuaQualificationFixtureArgs(protocol.binding);
      const oracleArgs = buildCuaQualificationOracleArgs(protocol.binding);
      expect(fixtureArgs).toEqual([
        "prepare",
        "--protocol",
        "cua.qualification.fixture/v1",
        "--scenario",
        id,
        "--task-id",
        protocol.scenario.taskId,
        "--sandbox",
        protocol.binding.sandboxName,
        "--target-identity-digest",
        protocol.binding.targetIdentityDigest,
        "--runtime-readiness-digest",
        protocol.binding.runtimeReadinessDigest,
        "--task-input",
        "/run/nemoclaw-cua-artifact/task-input",
      ]);
      expect(oracleArgs).toEqual([
        "observe",
        "--protocol",
        "cua.qualification.oracle/v1",
        "--scenario",
        id,
        "--task-id",
        protocol.scenario.taskId,
        "--sandbox",
        protocol.binding.sandboxName,
        "--target-identity-digest",
        protocol.binding.targetIdentityDigest,
        "--runtime-readiness-digest",
        protocol.binding.runtimeReadinessDigest,
      ]);
      expect(
        assertCuaQualificationFixtureBinding(
          protocol.scenario,
          protocol.binding,
          protocol.fixtureStdout,
        ).fixtureStateDigest,
      ).toBe(protocol.scenario.fixtureStateDigest);
      expect(
        assertCuaQualificationObservedScenarioBindings(
          parsedReceipt,
          protocol.scenario,
          protocol.binding,
          protocol.oracleStdout,
          protocol.result,
        ),
      ).toEqual(protocol.result);
    }
  });

  it("keeps receipt paths and expected observations out of artifact inputs and task input", () => {
    const parsedReceipt = parseCuaQualificationReceipt(receipt());
    const protocol = scenarioProtocol("browser");
    const inputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-task-input-"));
    tempDirectories.push(inputDirectory);
    const sourceTaskInputPath = path.join(inputDirectory, "task.txt");
    const receiptPath = path.join(inputDirectory, "private-receipt.json");
    fs.writeFileSync(sourceTaskInputPath, "perform the browser scenario\n", { mode: 0o400 });
    const taskInputPath = fs.realpathSync(sourceTaskInputPath);
    const fixtureArgs = buildCuaQualificationFixtureArgs(protocol.binding);
    const oracleArgs = buildCuaQualificationOracleArgs(protocol.binding);
    const artifactInputs = JSON.stringify({
      fixtureArgs,
      oracleArgs,
      env: buildCuaQualificationArtifactEnvironment("/usr/bin:/bin"),
    });
    for (const forbidden of [
      taskInputPath,
      receiptPath,
      ...parsedReceipt.scenarios.flatMap(({ fixtureStateDigest, stateDigest, evidenceDigests }) => [
        fixtureStateDigest,
        stateDigest,
        ...evidenceDigests,
      ]),
    ]) {
      expect(artifactInputs).not.toContain(forbidden);
    }
    expect(
      assertCuaQualificationTaskInputExpectationFree(taskInputPath, parsedReceipt, [receiptPath])
        .sizeBytes,
    ).toBeGreaterThan(0);

    fs.chmodSync(taskInputPath, 0o600);
    fs.writeFileSync(taskInputPath, `expected ${protocol.scenario.stateDigest}\n`);
    expect(() =>
      assertCuaQualificationTaskInputExpectationFree(taskInputPath, parsedReceipt, [receiptPath]),
    ).toThrow(/must not contain expected observations/);
    fs.writeFileSync(taskInputPath, `expected ${protocol.scenario.stateDigest.slice(7)}\n`);
    expect(() =>
      assertCuaQualificationTaskInputExpectationFree(taskInputPath, parsedReceipt, [receiptPath]),
    ).toThrow(/must not contain expected observations/);
    fs.writeFileSync(taskInputPath, `load ${receiptPath}\n`);
    expect(() =>
      assertCuaQualificationTaskInputExpectationFree(taskInputPath, parsedReceipt, [receiptPath]),
    ).toThrow(/authority coordinates/);
  });

  it("rejects malformed extra oversized and mismatched fixture or oracle output", () => {
    const protocol = scenarioProtocol("browser");
    expect(() => parseCuaQualificationFixtureOutput("{")).toThrow(/strict JSON/);

    const extraFixture = JSON.parse(protocol.fixtureStdout) as Record<string, unknown>;
    extraFixture.expectedStateDigest = protocol.scenario.stateDigest;
    expect(() => parseCuaQualificationFixtureOutput(JSON.stringify(extraFixture))).toThrow(
      /contain exactly/,
    );

    expect(() =>
      parseCuaQualificationOracleOutput(
        JSON.stringify({
          padding: "x".repeat(CUA_QUALIFICATION_ARTIFACT_OUTPUT_MAX_BYTES),
        }),
      ),
    ).toThrow(/bounded JSON/);

    const mismatchedFixture = JSON.parse(protocol.fixtureStdout) as Record<string, unknown>;
    mismatchedFixture.runtimeReadinessDigest = digest("f");
    expect(() =>
      assertCuaQualificationFixtureBinding(
        protocol.scenario,
        protocol.binding,
        JSON.stringify(mismatchedFixture),
      ),
    ).toThrow(/fixture state does not match/);

    const mismatchedOracleIdentity = JSON.parse(protocol.oracleStdout) as Record<string, unknown>;
    mismatchedOracleIdentity.sandboxName = "other-sandbox";
    expect(() =>
      assertCuaQualificationObservedScenarioBindings(
        parseCuaQualificationReceipt(receipt()),
        protocol.scenario,
        protocol.binding,
        JSON.stringify(mismatchedOracleIdentity),
        protocol.result,
      ),
    ).toThrow(/oracle observation does not match the receipt/);

    const malformedOracle = JSON.parse(protocol.oracleStdout) as Record<string, unknown>;
    malformedOracle.evidenceDigests = Array.from(
      { length: CUA_QUALIFICATION_EVIDENCE_DIGEST_MAX + 1 },
      (_, index) => `sha256:${index.toString(16).padStart(64, "0")}`,
    );
    expect(() => parseCuaQualificationOracleOutput(JSON.stringify(malformedOracle))).toThrow(
      /bounded evidence/,
    );
  });

  it("rejects adapter output that echoes the receipt when the independent oracle differs", () => {
    const parsedReceipt = parseCuaQualificationReceipt(receipt());
    const protocol = scenarioProtocol("browser");
    const mismatchedOracle = JSON.parse(protocol.oracleStdout) as Record<string, unknown>;
    mismatchedOracle.stateDigest = digest("f");
    mismatchedOracle.evidenceDigests = [digest("f")];

    expect(() =>
      assertCuaQualificationObservedScenarioBindings(
        parsedReceipt,
        protocol.scenario,
        protocol.binding,
        JSON.stringify(mismatchedOracle),
        protocol.result,
      ),
    ).toThrow(/oracle observation does not match the receipt/);
  });

  it("rejects scenario state and evidence mismatches", () => {
    const parsedReceipt = parseCuaQualificationReceipt(receipt());
    const observation = scenarioObservation("browser");

    const state = structuredClone(observation.result);
    state.agentResult.resultDigest = observation.scenario.evidenceDigests[2];
    expect(() =>
      assertCuaQualificationScenarioBindings(parsedReceipt, observation.scenario, state),
    ).toThrow(/state digest does not match/);

    const resultEvidence = {
      ...observation.scenario,
      evidenceDigests: [observation.scenario.stateDigest, digest("f")],
    };
    expect(() =>
      assertCuaQualificationScenarioBindings(parsedReceipt, resultEvidence, observation.result),
    ).toThrow(/evidence digests do not match/);
  });

  it("rejects candidate source, evidence, manifest, route, and optional-operation drift", () => {
    const parsed = parseCuaQualificationReceipt(receipt());

    const finalStatus = publicStatus();
    (finalStatus.cuaRuntime as CuaRuntimeReadiness).status = "available";
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, finalStatus.cuaRuntime, runtimeBindings),
    ).toThrow();

    const source = publicStatus();
    (source.cuaRuntime as CuaRuntimeReadiness).sourceRevision = "d".repeat(40);
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, source.cuaRuntime, runtimeBindings),
    ).toThrow(/source or qualification identity/);

    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, publicStatus().cuaRuntime, {
        ...runtimeBindings,
        sourceRevision: "d".repeat(40),
      }),
    ).toThrow(/source or qualification identity/);
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, publicStatus().cuaRuntime, {
        ...runtimeBindings,
        sourceClean: false,
      }),
    ).toThrow(/source or qualification identity/);

    const evidence = publicStatus();
    (evidence.cuaRuntime as CuaRuntimeReadiness).qualification = {
      state: "candidate",
      environmentDigest: digest("c"),
      bundleReceiptDigest: runtimeBindings.bundleReceiptDigest,
    };
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, evidence.cuaRuntime, runtimeBindings),
    ).toThrow(/source or qualification identity/);

    const manifestDigest = publicStatus();
    (manifestDigest.cuaRuntime as CuaRuntimeReadiness).runtimeManifestDigest = digest("f");
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, manifestDigest.cuaRuntime, runtimeBindings),
    ).toThrow(/source or qualification identity/);

    const route = publicStatus();
    (route.cuaRuntime as CuaRuntimeReadiness).inference.routeDigest = digest("f");
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, route.cuaRuntime, runtimeBindings),
    ).toThrow(/inference identity/);

    const optional = publicStatus();
    (optional.cuaRuntime as unknown as { taskOperations: string[] }).taskOperations = [
      ...CUA_TASK_OPERATIONS,
      "task.pause",
    ];
    expect(() =>
      assertCuaCandidateRuntimeBindings(parsed, optional.cuaRuntime, runtimeBindings),
    ).toThrow(/taskOperations/);

    const manifest = runtimeManifest();
    manifest.bundleReceipt.sha256 = "f".repeat(64);
    expect(() => assertCuaCandidateManifestBindings(manifest, parsed)).toThrow(
      /candidate identity/,
    );
  });

  it("rejects bundle coordinates, extra keys, and target-image tuple drift", () => {
    const coordinate = releaseBundle();
    ((coordinate.artifacts as Record<string, unknown>).cli as Record<string, unknown>).filename =
      "https://private.invalid/nemocua.tar.gz";
    expect(() => parseCuaReleaseBundleReceipt(coordinate)).toThrow(
      /coordinate- and credential-free/,
    );

    const extra = releaseBundle();
    (extra.artifacts as Record<string, unknown>).repository = "private.invalid";
    expect(() => parseCuaReleaseBundleReceipt(extra)).toThrow(/contain exactly/);

    const bundle = parseCuaReleaseBundleReceipt(releaseBundle());
    const changed = parseCuaQualificationReceipt(receipt());
    changed.components.targetImage = digest("f");
    expect(() => assertCuaReleaseBundleBindings(bundle, changed)).toThrow(/NVLumina/);

    const changedRuntime = structuredClone(bundle);
    changedRuntime.artifacts.cli.sha256 = "f".repeat(64);
    expect(() =>
      assertCuaReleaseBundleBindings(changedRuntime, parseCuaQualificationReceipt(receipt())),
    ).toThrow(/runtime/);

    const changedServices = structuredClone(bundle);
    changedServices.artifacts.services.sha256 = "f".repeat(64);
    expect(() =>
      assertCuaReleaseBundleBindings(changedServices, parseCuaQualificationReceipt(receipt())),
    ).toThrow(/serviceBundle/);
  });

  it("checks regular-file identity and size before bounded allocation and hashing", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-receipt-"));
    tempDirectories.push(directory);
    const validPath = path.join(directory, "receipt.json");
    fs.writeFileSync(validPath, JSON.stringify(receipt()));
    expect(readBoundedCuaQualificationJson(validPath).sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    const symlinkPath = path.join(directory, "receipt-link.json");
    fs.symlinkSync(validPath, symlinkPath);
    expect(() => readBoundedCuaQualificationJson(symlinkPath)).toThrow(/regular file/);

    const oversizedPath = path.join(directory, "oversized.json");
    fs.writeFileSync(oversizedPath, "x".repeat(CUA_QUALIFICATION_FILE_MAX_BYTES + 1));
    expect(() => readBoundedCuaQualificationJson(oversizedPath)).toThrow(/no larger/);

    const tamperedPath = path.join(directory, "tampered.json");
    fs.writeFileSync(tamperedPath, JSON.stringify(receipt()));
    const realReadSync = fs.readSync.bind(fs);
    let tampered = false;
    vi.spyOn(fs, "readSync").mockImplementation(((
      fd: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number | null,
    ) => {
      const read = realReadSync(fd, buffer, offset, length, position);
      if (!tampered) {
        tampered = true;
        fs.appendFileSync(tamperedPath, " ");
      }
      return read;
    }) as typeof fs.readSync);
    expect(() => readBoundedCuaQualificationJson(tamperedPath)).toThrow(
      /changed during bounded validation/,
    );
  });

  it("consumes exact qualification bytes only from a private non-writable authority snapshot", () => {
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cua-authority-source-"),
    );
    tempDirectories.push(sourceDirectory);
    const jsonPath = path.join(sourceDirectory, "input.json");
    const fixturePath = path.join(sourceDirectory, "fixture");
    const oraclePath = path.join(sourceDirectory, "oracle");
    fs.writeFileSync(jsonPath, '{"value":1}\n', { mode: 0o600 });
    fs.writeFileSync(fixturePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    fs.writeFileSync(oraclePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const jsonDigest = readBoundedCuaQualificationJson(jsonPath).sha256;
    const fixtureDigest = hashBoundedCuaQualificationFile(fixturePath).sha256;
    const oracleDigest = hashBoundedCuaQualificationFile(oraclePath).sha256;

    const snapshot = stageCuaQualificationAuthorityFiles({
      json: {
        sourcePath: jsonPath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: jsonDigest,
      },
      fixture: {
        sourcePath: fixturePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: fixtureDigest,
        executable: true,
      },
      oracle: {
        sourcePath: oraclePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: oracleDigest,
        executable: true,
      },
    });
    tempDirectories.push(snapshot.directory);
    expect(fs.statSync(snapshot.files.json!).mode & 0o777).toBe(0o400);
    expect(fs.statSync(snapshot.files.fixture!).mode & 0o777).toBe(0o500);
    expect(fs.statSync(snapshot.files.oracle!).mode & 0o777).toBe(0o500);
    snapshot.seal();
    expect(fs.statSync(snapshot.directory).mode & 0o777).toBe(0o500);
    expect(fs.readFileSync(snapshot.files.json!, "utf8")).toBe('{"value":1}\n');
    expect(() => fs.renameSync(snapshot.files.json!, `${snapshot.files.json!}.replaced`)).toThrow();
    expect(() => fs.writeFileSync(snapshot.files.json!, "replacement\n")).toThrow();

    fs.writeFileSync(jsonPath, '{"value":2}\n');
    fs.writeFileSync(fixturePath, "#!/bin/sh\nexit 9\n");
    fs.writeFileSync(oraclePath, "#!/bin/sh\nexit 9\n");
    expect(fs.readFileSync(snapshot.files.json!, "utf8")).toBe('{"value":1}\n');
    expect(hashBoundedCuaQualificationFile(snapshot.files.fixture!).sha256).toBe(fixtureDigest);
    expect(hashBoundedCuaQualificationFile(snapshot.files.oracle!).sha256).toBe(oracleDigest);

    const symlinkPath = path.join(sourceDirectory, "input-link.json");
    fs.symlinkSync(jsonPath, symlinkPath);
    expect(() =>
      stageCuaQualificationAuthorityFiles({
        linked: {
          sourcePath: symlinkPath,
          maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
          expectedDigest: jsonDigest,
        },
      }),
    ).toThrow(/regular file/);
    snapshot.cleanup();
  });

  it("consumes expected receipt bytes before any same-UID qualification artifact can read them", () => {
    const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-private-receipt-"));
    tempDirectories.push(sourceDirectory);
    fs.chmodSync(sourceDirectory, 0o700);
    const sourceReceiptPath = path.join(sourceDirectory, "receipt.json");
    fs.writeFileSync(sourceReceiptPath, '{"expected":"controller-only-expected-state"}\n', {
      mode: 0o600,
    });
    const attackerPath = path.join(sourceDirectory, "fixture");
    fs.writeFileSync(
      attackerPath,
      `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const [sourceReceipt, authority] = process.argv.slice(2);
const expected = ["controller", "only", "expected", "state"].join("-");
for (const candidate of [sourceReceipt, path.join(authority, ".receipt")]) {
  try {
    fs.readFileSync(candidate);
    process.exit(11);
  } catch (error) {
    if (error.code !== "ENOENT") process.exit(12);
  }
}
for (const child of fs.readdirSync(authority)) {
  if (fs.readFileSync(path.join(authority, child)).includes(expected)) process.exit(13);
}
process.stdout.write("isolated\\n");
`,
      { mode: 0o700 },
    );
    const attackerDigest = hashBoundedCuaQualificationFile(attackerPath).sha256;

    const consumed = consumeBoundedCuaQualificationJson(sourceReceiptPath);
    expect(consumed.value).toEqual({ expected: "controller-only-expected-state" });
    expect(consumed.consumedPath).toBe(fs.realpathSync(sourceDirectory) + "/receipt.json");
    expect(fs.existsSync(sourceReceiptPath)).toBe(false);

    const snapshot = stageCuaQualificationAuthorityFiles({
      fixture: {
        sourcePath: attackerPath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: attackerDigest,
        executable: true,
      },
      publicInput: {
        sourcePath: attackerPath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: attackerDigest,
      },
    });
    tempDirectories.push(snapshot.directory);
    snapshot.seal();

    expect(
      execFileSync(snapshot.files.fixture!, [sourceReceiptPath, snapshot.directory], {
        encoding: "utf8",
      }),
    ).toBe("isolated\n");
    snapshot.cleanup();
  });

  it("rejects a reusable or same-UID-discoverable expected receipt handoff", () => {
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cua-reusable-receipt-"),
    );
    tempDirectories.push(sourceDirectory);
    const sourceReceiptPath = path.join(sourceDirectory, "receipt.json");
    const hardLinkPath = path.join(sourceDirectory, "receipt-copy.json");
    fs.writeFileSync(sourceReceiptPath, "{}\n", { mode: 0o600 });
    fs.linkSync(sourceReceiptPath, hardLinkPath);

    expect(() => consumeBoundedCuaQualificationJson(sourceReceiptPath)).toThrow(/no hard links/);
    expect(fs.existsSync(sourceReceiptPath)).toBe(true);
    fs.unlinkSync(hardLinkPath);
    fs.chmodSync(sourceDirectory, 0o755);
    expect(() => consumeBoundedCuaQualificationJson(sourceReceiptPath)).toThrow(
      /owner-only directory/,
    );
    expect(fs.existsSync(sourceReceiptPath)).toBe(true);
  });

  it("rejects extra authority children and removes the unsealed snapshot", () => {
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cua-authority-extra-source-"),
    );
    tempDirectories.push(sourceDirectory);
    const sourcePath = path.join(sourceDirectory, "input.json");
    fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
    const snapshot = stageCuaQualificationAuthorityFiles({
      input: {
        sourcePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: hashBoundedCuaQualificationFile(sourcePath).sha256,
      },
    });
    tempDirectories.push(snapshot.directory);
    fs.writeFileSync(path.join(snapshot.directory, ".unexpected"), "denied\n", { mode: 0o400 });

    expect(() => snapshot.seal()).toThrow(/exact expected file set/);
    expect(fs.existsSync(snapshot.directory)).toBe(false);
  });

  it.each([
    "runtime staging",
    "chmod",
    "generated write",
    "seal",
  ])("removes the authority snapshot when %s fails during preparation", (phase) => {
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cua-authority-prepare-source-"),
    );
    tempDirectories.push(sourceDirectory);
    const sourcePath = path.join(sourceDirectory, "input.json");
    fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
    let authorityDirectory = "";

    expect(() =>
      prepareCuaQualificationAuthority(
        {
          input: {
            sourcePath,
            maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
            expectedDigest: hashBoundedCuaQualificationFile(sourcePath).sha256,
          },
        },
        (snapshot) => {
          authorityDirectory = snapshot.directory;
          if (phase === "runtime staging") {
            fs.writeFileSync(path.join(snapshot.directory, "runtime-payload"), "partial\n");
            throw new Error("injected runtime staging failure");
          }
          if (phase === "chmod") {
            fs.chmodSync(snapshot.files.input!, 0o400);
            throw new Error("injected chmod failure");
          }
          if (phase === "generated write") {
            fs.writeFileSync(path.join(snapshot.directory, "generated"), "partial\n");
            throw new Error("injected generated write failure");
          }
          fs.writeFileSync(path.join(snapshot.directory, "unexpected"), "partial\n");
          snapshot.seal();
        },
      ),
    ).toThrow(/injected|exact expected file set/);
    expect(authorityDirectory).not.toBe("");
    expect(fs.existsSync(authorityDirectory)).toBe(false);
  });

  it("restores authority directory permissions before seal-time cleanup", () => {
    const sourceDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cua-authority-seal-source-"),
    );
    tempDirectories.push(sourceDirectory);
    const sourcePath = path.join(sourceDirectory, "input.json");
    fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
    const snapshot = stageCuaQualificationAuthorityFiles({
      input: {
        sourcePath,
        maxBytes: CUA_QUALIFICATION_FILE_MAX_BYTES,
        expectedDigest: hashBoundedCuaQualificationFile(sourcePath).sha256,
      },
    });
    tempDirectories.push(snapshot.directory);
    const chmodSync = fs.chmodSync.bind(fs);
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation((target, mode) => {
      chmodSync(target, mode);
      if (target === snapshot.directory && mode === 0o500) {
        throw new Error("simulated post-seal validation failure");
      }
    });
    try {
      expect(() => snapshot.seal()).toThrow(/simulated post-seal validation failure/);
    } finally {
      chmodSpy.mockRestore();
    }
    expect(fs.existsSync(snapshot.directory)).toBe(false);
  });
});
