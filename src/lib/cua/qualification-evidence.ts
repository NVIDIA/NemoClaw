// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { CuaInferenceIdentity } from "./contract";
import {
  CUA_DOMAIN_COORDINATE,
  CUA_HOST_COORDINATE,
  CUA_SENSITIVE_VALUE,
} from "./shared-primitives";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RAW_DIGEST = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,127}$/;
const MODEL_SELECTOR =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}){0,7}$/;

export const CUA_QUALIFICATION_SCENARIOS = ["browser"] as const;

export const CUA_QUALIFICATION_DENIALS = [
  "target-adapter-substitution",
  "task-adapter-substitution",
  "security-adapter-substitution",
  "policy-boundary-violation",
] as const;

export interface CuaQualificationLaunchable {
  version: string;
  digest: string;
}

export interface CuaQualificationGpu {
  count: number;
  model: string;
  driverVersion: string;
  cudaVersion: string;
  containerToolkitVersion: string;
  probeImageDigest: string;
}

export interface CuaQualificationHostTools {
  node: string;
  docker: string;
  nvidiaSmi: string;
  nvidiaCtk: string;
}

export interface CuaQualificationTargetChannelIdentity {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-target-channel-identity";
  protocol: "cua.qualification.target-channel/v1";
  serviceBundleDigest: string;
  targetImageDigest: string;
}

export interface CuaQualificationEnvironment {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-environment";
  launchable: CuaQualificationLaunchable;
  gpu: CuaQualificationGpu;
  hostTools: CuaQualificationHostTools;
  targetChannel: CuaQualificationTargetChannelIdentity;
  nemoclawCommit: string;
  bundleReceiptSha256: string;
}

export interface CuaQualificationScenario {
  id: (typeof CUA_QUALIFICATION_SCENARIOS)[number];
  taskId: string;
  status: "passed";
  fixtureStateDigest: string;
  stateDigest: string;
  evidenceDigests: string[];
}

export interface CuaQualificationCleanup {
  targetDestroyObservationDigest: string;
  nemoclawDestroyObservationDigest: string;
  nemoclawStatusAbsenceObservationDigest: string;
  nemoclawRegistryAbsenceObservationDigest: string;
  openshellInventoryAbsenceObservationDigest: string;
}

export interface CuaQualificationReceipt {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-receipt";
  status: "passed";
  launchable: CuaQualificationLaunchable;
  gpu: CuaQualificationGpu;
  hostTools: CuaQualificationHostTools;
  targetChannel: CuaQualificationTargetChannelIdentity;
  nemoclawCommit: string;
  bundleReceiptSha256: string;
  inference: CuaInferenceIdentity;
  components: {
    openshell: string;
    runtime: string;
    sandboxImage: string;
    targetAdapter: string;
    targetImage: string;
    serviceBundle: string;
    policy: string;
    taskProtocol: string;
    securityVerifier: string;
    fixture: string;
    oracle: string;
  };
  scenarios: CuaQualificationScenario[];
  denials: Array<{
    id: (typeof CUA_QUALIFICATION_DENIALS)[number];
    outcomeDigest: string;
  }>;
  cleanup: CuaQualificationCleanup;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    throw new Error(`${label} must contain exactly: ${wanted.join(", ")}`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new Error(`${label} must be a non-empty bounded string`);
  }
  return value;
}

function safeValue(
  value: unknown,
  label: string,
  pattern = SAFE_TEXT,
  rejectDomain = false,
): string {
  const parsed = string(value, label);
  if (
    !pattern.test(parsed) ||
    CUA_SENSITIVE_VALUE.test(parsed) ||
    CUA_HOST_COORDINATE.test(parsed) ||
    (rejectDomain && CUA_DOMAIN_COORDINATE.test(parsed))
  ) {
    throw new Error(`${label} must be printable and coordinate- and credential-free`);
  }
  return parsed;
}

function digest(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!DIGEST.test(parsed)) throw new Error(`${label} must be a sha256 digest`);
  return parsed;
}

function rawDigest(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!RAW_DIGEST.test(parsed)) throw new Error(`${label} must be a lowercase SHA-256`);
  return parsed;
}

function commit(value: unknown, label: string): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-hex commit`);
  }
  return value;
}

function launchable(value: unknown): CuaQualificationLaunchable {
  const record = object(value, "launchable");
  exactKeys(record, ["version", "digest"], "launchable");
  const version = string(record.version, "launchable.version");
  if (!VERSION.test(version)) throw new Error("launchable.version must be semver");
  return { version, digest: digest(record.digest, "launchable.digest") };
}

function gpu(value: unknown): CuaQualificationGpu {
  const record = object(value, "gpu");
  exactKeys(
    record,
    [
      "count",
      "model",
      "driverVersion",
      "cudaVersion",
      "containerToolkitVersion",
      "probeImageDigest",
    ],
    "gpu",
  );
  if (!Number.isInteger(record.count) || Number(record.count) < 1 || Number(record.count) > 64) {
    throw new Error("gpu.count must be an integer from 1 through 64");
  }
  return {
    count: Number(record.count),
    model: safeValue(record.model, "gpu.model"),
    driverVersion: safeValue(record.driverVersion, "gpu.driverVersion", SAFE_ID),
    cudaVersion: safeValue(record.cudaVersion, "gpu.cudaVersion", SAFE_ID),
    containerToolkitVersion: safeValue(
      record.containerToolkitVersion,
      "gpu.containerToolkitVersion",
      SAFE_ID,
    ),
    probeImageDigest: digest(record.probeImageDigest, "gpu.probeImageDigest"),
  };
}

function hostTools(value: unknown): CuaQualificationHostTools {
  const record = object(value, "hostTools");
  const keys = ["node", "docker", "nvidiaSmi", "nvidiaCtk"] as const;
  exactKeys(record, keys, "hostTools");
  return Object.fromEntries(
    keys.map((key) => [key, digest(record[key], `hostTools.${key}`)]),
  ) as unknown as CuaQualificationHostTools;
}

export function parseCuaQualificationTargetChannel(
  value: unknown,
): CuaQualificationTargetChannelIdentity {
  const record = object(value, "targetChannel");
  exactKeys(
    record,
    ["schemaVersion", "kind", "protocol", "serviceBundleDigest", "targetImageDigest"],
    "targetChannel",
  );
  if (record.schemaVersion !== "1.0.0") {
    throw new Error("unsupported targetChannel schema");
  }
  if (record.kind !== "cua-qualification-target-channel-identity") {
    throw new Error("unexpected targetChannel kind");
  }
  if (record.protocol !== "cua.qualification.target-channel/v1") {
    throw new Error("unsupported targetChannel protocol");
  }
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-target-channel-identity",
    protocol: "cua.qualification.target-channel/v1",
    serviceBundleDigest: digest(record.serviceBundleDigest, "targetChannel.serviceBundleDigest"),
    targetImageDigest: digest(record.targetImageDigest, "targetChannel.targetImageDigest"),
  };
}

export function parseCuaQualificationInference(value: unknown): CuaInferenceIdentity {
  const record = object(value, "inference");
  exactKeys(record, ["provider", "model", "routeDigest"], "inference");
  return {
    provider: safeValue(record.provider, "inference.provider", SAFE_ID, true),
    model: safeValue(record.model, "inference.model", MODEL_SELECTOR),
    routeDigest: digest(record.routeDigest, "inference.routeDigest"),
  };
}

export function parseCuaQualificationEnvironment(value: unknown): CuaQualificationEnvironment {
  const record = object(value, "qualification environment");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "launchable",
      "gpu",
      "hostTools",
      "targetChannel",
      "nemoclawCommit",
      "bundleReceiptSha256",
    ],
    "qualification environment",
  );
  if (record.schemaVersion !== "1.0.0") throw new Error("unsupported environment schema");
  if (record.kind !== "cua-qualification-environment") {
    throw new Error("unexpected qualification environment kind");
  }
  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-environment",
    launchable: launchable(record.launchable),
    gpu: gpu(record.gpu),
    hostTools: hostTools(record.hostTools),
    targetChannel: parseCuaQualificationTargetChannel(record.targetChannel),
    nemoclawCommit: commit(record.nemoclawCommit, "qualification environment nemoclawCommit"),
    bundleReceiptSha256: rawDigest(
      record.bundleReceiptSha256,
      "qualification environment bundleReceiptSha256",
    ),
  };
}

export function parseCuaQualificationReceipt(value: unknown): CuaQualificationReceipt {
  const record = object(value, "qualification receipt");
  exactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "status",
      "launchable",
      "gpu",
      "hostTools",
      "targetChannel",
      "nemoclawCommit",
      "bundleReceiptSha256",
      "inference",
      "components",
      "scenarios",
      "denials",
      "cleanup",
    ],
    "qualification receipt",
  );
  if (record.schemaVersion !== "1.0.0") throw new Error("unsupported receipt schema");
  if (record.kind !== "cua-qualification-receipt" || record.status !== "passed") {
    throw new Error("qualification receipt did not pass");
  }
  const components = object(record.components, "qualification receipt components");
  const componentKeys = [
    "openshell",
    "runtime",
    "sandboxImage",
    "targetAdapter",
    "targetImage",
    "serviceBundle",
    "policy",
    "taskProtocol",
    "securityVerifier",
    "fixture",
    "oracle",
  ] as const;
  exactKeys(components, componentKeys, "qualification receipt components");
  const parsedComponents = Object.fromEntries(
    componentKeys.map((key) => [key, digest(components[key], `components.${key}`)]),
  ) as CuaQualificationReceipt["components"];

  if (
    !Array.isArray(record.scenarios) ||
    record.scenarios.length !== CUA_QUALIFICATION_SCENARIOS.length
  ) {
    throw new Error("qualification receipt scenarios must contain exactly one browser record");
  }
  const seen = new Set<string>();
  const seenTaskIds = new Set<string>();
  const scenarioDigestOwners = new Map<string, string>();
  const parseScenario = (
    value: unknown,
    label: string,
    requireUniqueModality: boolean,
  ): CuaQualificationScenario => {
    const scenario = object(value, label);
    exactKeys(
      scenario,
      ["id", "taskId", "status", "fixtureStateDigest", "stateDigest", "evidenceDigests"],
      label,
    );
    if (
      typeof scenario.id !== "string" ||
      !CUA_QUALIFICATION_SCENARIOS.includes(
        scenario.id as (typeof CUA_QUALIFICATION_SCENARIOS)[number],
      ) ||
      (requireUniqueModality && seen.has(scenario.id))
    ) {
      throw new Error(`${label}.id is unsupported or duplicated`);
    }
    if (requireUniqueModality) seen.add(scenario.id);
    if (scenario.status !== "passed") throw new Error(`scenario ${scenario.id} did not pass`);
    if (
      !Array.isArray(scenario.evidenceDigests) ||
      scenario.evidenceDigests.length === 0 ||
      scenario.evidenceDigests.length > 16
    ) {
      throw new Error(`scenario ${scenario.id} requires 1 through 16 evidence digests`);
    }
    const taskId = safeValue(scenario.taskId, `${label}.taskId`, SAFE_ID);
    if (seenTaskIds.has(taskId)) {
      throw new Error(`duplicate scenario taskId ${taskId}`);
    }
    seenTaskIds.add(taskId);
    const fixtureStateDigest = digest(scenario.fixtureStateDigest, `${label}.fixtureStateDigest`);
    const stateDigest = digest(scenario.stateDigest, `${label}.stateDigest`);
    const evidenceDigests = scenario.evidenceDigests.map((entry, evidenceIndex) =>
      digest(entry, `${label}.evidenceDigests[${String(evidenceIndex)}]`),
    );
    if (fixtureStateDigest === stateDigest || evidenceDigests.includes(fixtureStateDigest)) {
      throw new Error(`scenario ${scenario.id} fixture state must be distinct from final evidence`);
    }
    if (new Set(evidenceDigests).size !== evidenceDigests.length) {
      throw new Error(`scenario ${scenario.id} contains duplicate evidence digests`);
    }
    if (!evidenceDigests.includes(stateDigest)) {
      throw new Error(`scenario ${scenario.id} state digest must be included in evidence digests`);
    }
    for (const claimedDigest of new Set([fixtureStateDigest, ...evidenceDigests])) {
      const priorOwner = scenarioDigestOwners.get(claimedDigest);
      if (priorOwner) {
        throw new Error(
          `scenario ${scenario.id} reuses qualification evidence from scenario ${priorOwner}`,
        );
      }
      scenarioDigestOwners.set(
        claimedDigest,
        requireUniqueModality ? scenario.id : `recreated ${scenario.id}`,
      );
    }
    return {
      id: scenario.id as (typeof CUA_QUALIFICATION_SCENARIOS)[number],
      taskId,
      status: "passed" as const,
      fixtureStateDigest,
      stateDigest,
      evidenceDigests,
    };
  };
  const scenarios = record.scenarios.map((value, index) =>
    parseScenario(value, `scenarios[${String(index)}]`, true),
  );

  if (
    !Array.isArray(record.denials) ||
    record.denials.length !== CUA_QUALIFICATION_DENIALS.length
  ) {
    throw new Error("qualification receipt denials must contain exactly four records");
  }
  const seenDenials = new Set<string>();
  const denials = record.denials.map((value, index) => {
    const denial = object(value, `denials[${String(index)}]`);
    exactKeys(denial, ["id", "outcomeDigest"], `denials[${String(index)}]`);
    if (
      typeof denial.id !== "string" ||
      !CUA_QUALIFICATION_DENIALS.includes(
        denial.id as (typeof CUA_QUALIFICATION_DENIALS)[number],
      ) ||
      seenDenials.has(denial.id)
    ) {
      throw new Error(`denials[${String(index)}].id is unsupported or duplicated`);
    }
    seenDenials.add(denial.id);
    return {
      id: denial.id as (typeof CUA_QUALIFICATION_DENIALS)[number],
      outcomeDigest: digest(denial.outcomeDigest, `denials[${String(index)}].outcomeDigest`),
    };
  });
  if (CUA_QUALIFICATION_DENIALS.some((id) => !seenDenials.has(id))) {
    throw new Error("qualification receipt denials must cover every required denial exercise");
  }

  const cleanupRecord = object(record.cleanup, "qualification receipt cleanup");
  const cleanupKeys = [
    "targetDestroyObservationDigest",
    "nemoclawDestroyObservationDigest",
    "nemoclawStatusAbsenceObservationDigest",
    "nemoclawRegistryAbsenceObservationDigest",
    "openshellInventoryAbsenceObservationDigest",
  ] as const;
  exactKeys(cleanupRecord, cleanupKeys, "qualification receipt cleanup");
  const cleanup = Object.fromEntries(
    cleanupKeys.map((key) => [key, digest(cleanupRecord[key], `cleanup.${key}`)]),
  ) as unknown as CuaQualificationCleanup;
  const lifecycleObservationDigests = cleanupKeys.map((key) => cleanup[key]);
  if (new Set(lifecycleObservationDigests).size !== lifecycleObservationDigests.length) {
    throw new Error("qualification lifecycle observations must be domain-distinct");
  }
  for (const observationDigest of lifecycleObservationDigests) {
    if (scenarioDigestOwners.has(observationDigest)) {
      throw new Error("qualification lifecycle observations must not replay scenario evidence");
    }
  }

  return {
    schemaVersion: "1.0.0",
    kind: "cua-qualification-receipt",
    status: "passed",
    launchable: launchable(record.launchable),
    gpu: gpu(record.gpu),
    hostTools: hostTools(record.hostTools),
    targetChannel: parseCuaQualificationTargetChannel(record.targetChannel),
    nemoclawCommit: commit(record.nemoclawCommit, "qualification receipt nemoclawCommit"),
    bundleReceiptSha256: rawDigest(
      record.bundleReceiptSha256,
      "qualification receipt bundleReceiptSha256",
    ),
    inference: parseCuaQualificationInference(record.inference),
    components: parsedComponents,
    scenarios,
    denials,
    cleanup,
  };
}

/** Require environment and receipt to attest the same observed candidate host. */
export function assertCuaQualificationBinding(
  environment: CuaQualificationEnvironment,
  receipt: CuaQualificationReceipt,
): void {
  if (
    environment.nemoclawCommit !== receipt.nemoclawCommit ||
    environment.bundleReceiptSha256 !== receipt.bundleReceiptSha256 ||
    environment.launchable.version !== receipt.launchable.version ||
    environment.launchable.digest !== receipt.launchable.digest ||
    JSON.stringify(environment.gpu) !== JSON.stringify(receipt.gpu) ||
    JSON.stringify(environment.hostTools) !== JSON.stringify(receipt.hostTools) ||
    JSON.stringify(environment.targetChannel) !== JSON.stringify(receipt.targetChannel)
  ) {
    throw new Error("qualification environment and receipt identities do not match");
  }
  if (receipt.gpu.probeImageDigest !== receipt.components.targetImage) {
    throw new Error("qualification GPU probe image does not match the targetImage component");
  }
  if (receipt.targetChannel.serviceBundleDigest !== receipt.components.serviceBundle) {
    throw new Error(
      "qualification target channel serviceBundleDigest does not match the serviceBundle component",
    );
  }
  if (receipt.targetChannel.targetImageDigest !== receipt.components.targetImage) {
    throw new Error(
      "qualification target channel targetImageDigest does not match the targetImage component",
    );
  }
}
