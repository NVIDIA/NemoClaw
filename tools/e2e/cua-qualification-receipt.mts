// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const CUA_QUALIFICATION_SCENARIOS = [
  "browser",
  "terminal",
  "computer",
  "integrated",
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

export interface CuaQualificationEnvironment {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-environment";
  launchable: CuaQualificationLaunchable;
  gpu: CuaQualificationGpu;
  nemoclawCommit: string;
}

export interface CuaQualificationReceipt {
  schemaVersion: "1.0.0";
  kind: "cua-qualification-receipt";
  status: "passed";
  launchable: CuaQualificationLaunchable;
  gpu: CuaQualificationGpu;
  nemoclawCommit: string;
  inference: {
    provider: string;
    model: string;
  };
  components: {
    openshell: string;
    runtime: string;
    sandboxImage: string;
    targetImage: string;
    serviceBundle: string;
    policy: string;
    taskProtocol: string;
    fixture: string;
    oracle: string;
    verifier: string;
  };
  scenarios: Array<{
    id: (typeof CUA_QUALIFICATION_SCENARIOS)[number];
    taskId: string;
    status: "passed";
    stateDigest: string;
    evidenceDigests: string[];
  }>;
  recreated: true;
  negativeTests: "passed";
  cleanup: "passed";
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

function digest(value: unknown, label: string): string {
  const parsed = string(value, label);
  if (!SHA256.test(parsed)) throw new Error(`${label} must be a sha256 digest`);
  return parsed;
}

function candidateCommit(value: unknown): string {
  if (typeof value !== "string" || !COMMIT.test(value)) {
    throw new Error("nemoclawCommit must be an exact lowercase 40-hex commit");
  }
  return value;
}

function launchableIdentity(value: unknown): CuaQualificationLaunchable {
  const launchable = object(value, "launchable");
  exactKeys(launchable, ["version", "digest"], "launchable");
  const version = string(launchable.version, "launchable.version");
  if (!VERSION.test(version)) throw new Error("launchable.version must be semver");
  return {
    version,
    digest: digest(launchable.digest, "launchable.digest"),
  };
}

function gpuIdentity(value: unknown): CuaQualificationGpu {
  const gpu = object(value, "gpu");
  exactKeys(
    gpu,
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
  if (!Number.isInteger(gpu.count) || (gpu.count as number) < 1) {
    throw new Error("gpu.count must be a positive integer");
  }
  return {
    count: gpu.count as number,
    model: string(gpu.model, "gpu.model"),
    driverVersion: string(gpu.driverVersion, "gpu.driverVersion"),
    cudaVersion: string(gpu.cudaVersion, "gpu.cudaVersion"),
    containerToolkitVersion: string(gpu.containerToolkitVersion, "gpu.containerToolkitVersion"),
    probeImageDigest: digest(gpu.probeImageDigest, "gpu.probeImageDigest"),
  };
}

export function parseCuaQualificationEnvironment(value: unknown): CuaQualificationEnvironment {
  const environment = object(value, "environment");
  exactKeys(
    environment,
    ["schemaVersion", "kind", "launchable", "gpu", "nemoclawCommit"],
    "environment",
  );
  if (environment.schemaVersion !== "1.0.0") {
    throw new Error("unsupported environment schema");
  }
  if (environment.kind !== "cua-qualification-environment") {
    throw new Error("unexpected environment kind");
  }
  launchableIdentity(environment.launchable);
  gpuIdentity(environment.gpu);
  candidateCommit(environment.nemoclawCommit);
  return structuredClone(value) as CuaQualificationEnvironment;
}

export function assertCuaQualificationBinding(
  environment: CuaQualificationEnvironment,
  receipt: CuaQualificationReceipt,
): void {
  if (environment.nemoclawCommit !== receipt.nemoclawCommit) {
    throw new Error("qualification receipt candidate does not match the environment");
  }
  if (
    environment.launchable.version !== receipt.launchable.version ||
    environment.launchable.digest !== receipt.launchable.digest
  ) {
    throw new Error("qualification receipt Launchable does not match the environment");
  }
  for (const field of [
    "count",
    "model",
    "driverVersion",
    "cudaVersion",
    "containerToolkitVersion",
    "probeImageDigest",
  ] as const) {
    if (environment.gpu[field] !== receipt.gpu[field]) {
      throw new Error(`qualification receipt gpu.${field} does not match the environment`);
    }
  }
}

export function parseCuaQualificationReceipt(value: unknown): CuaQualificationReceipt {
  const receipt = object(value, "receipt");
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "kind",
      "status",
      "launchable",
      "gpu",
      "nemoclawCommit",
      "inference",
      "components",
      "scenarios",
      "recreated",
      "negativeTests",
      "cleanup",
    ],
    "receipt",
  );
  if (receipt.schemaVersion !== "1.0.0") throw new Error("unsupported receipt schema");
  if (receipt.kind !== "cua-qualification-receipt") throw new Error("unexpected receipt kind");
  if (receipt.status !== "passed") throw new Error("qualification did not pass");
  if (receipt.recreated !== true) throw new Error("recreated qualification did not pass");
  if (receipt.negativeTests !== "passed") throw new Error("negative tests did not pass");
  if (receipt.cleanup !== "passed") throw new Error("cleanup did not pass");
  candidateCommit(receipt.nemoclawCommit);
  launchableIdentity(receipt.launchable);
  gpuIdentity(receipt.gpu);

  const inference = object(receipt.inference, "inference");
  exactKeys(inference, ["provider", "model"], "inference");
  string(inference.provider, "inference.provider");
  string(inference.model, "inference.model");

  const components = object(receipt.components, "components");
  exactKeys(
    components,
    [
      "openshell",
      "runtime",
      "sandboxImage",
      "targetImage",
      "serviceBundle",
      "policy",
      "taskProtocol",
      "fixture",
      "oracle",
      "verifier",
    ],
    "components",
  );
  for (const [key, identity] of Object.entries(components)) digest(identity, `components.${key}`);

  if (!Array.isArray(receipt.scenarios) || receipt.scenarios.length !== 4) {
    throw new Error("scenarios must contain exactly four records");
  }
  const seen = new Set<string>();
  for (const [index, rawScenario] of receipt.scenarios.entries()) {
    const scenario = object(rawScenario, `scenarios[${index}]`);
    exactKeys(
      scenario,
      ["id", "taskId", "status", "stateDigest", "evidenceDigests"],
      `scenarios[${index}]`,
    );
    if (
      typeof scenario.id !== "string" ||
      !CUA_QUALIFICATION_SCENARIOS.includes(
        scenario.id as (typeof CUA_QUALIFICATION_SCENARIOS)[number],
      )
    ) {
      throw new Error(`scenarios[${index}].id is unsupported`);
    }
    if (seen.has(scenario.id)) throw new Error(`duplicate scenario ${scenario.id}`);
    seen.add(scenario.id);
    string(scenario.taskId, `scenarios[${index}].taskId`);
    if (scenario.status !== "passed") throw new Error(`scenario ${scenario.id} did not pass`);
    digest(scenario.stateDigest, `scenarios[${index}].stateDigest`);
    if (!Array.isArray(scenario.evidenceDigests) || scenario.evidenceDigests.length === 0) {
      throw new Error(`scenario ${scenario.id} requires private evidence references`);
    }
    for (const [evidenceIndex, evidenceDigest] of scenario.evidenceDigests.entries()) {
      digest(evidenceDigest, `scenarios[${index}].evidenceDigests[${evidenceIndex}]`);
    }
  }

  return structuredClone(value) as CuaQualificationReceipt;
}
