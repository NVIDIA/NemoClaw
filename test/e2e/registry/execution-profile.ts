// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const EXECUTION_FOUNDATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
export const MAX_HOST_SHARDS = 32;

declare const executionProviderIdBrand: unique symbol;

/**
 * Open provider identity. A provider becomes executable only when its adapter
 * is present in a RuntimeAdapterCatalog; naming one here is not registration or
 * a support claim.
 */
export type ExecutionProviderId = string & {
  readonly [executionProviderIdBrand]: true;
};
export type ExecutionPlatform = "linux" | "macos" | "windows";
export type ExecutionArchitecture = "amd64" | "arm64";
export type ExecutionRootMode = "rootful" | "rootless";
export type ExecutionAcceleration = "cpu" | "nvidia-gpu";

export type ExecutionCapability =
  | "agent.configure"
  | "agent.turn"
  | "evidence.collect"
  | "sandbox.lifecycle"
  | "state.observe"
  | "transport.docker-socket"
  | "transport.socket-free";

export interface ExecutionRunner {
  /** Stable physical or virtual host identity used to bound shard lanes. */
  hostId: string;
  /** Runner label for future consumers. This foundation does not select it. */
  label: string;
  /** Maximum serial shard lanes that may be assigned on this host. */
  maxShards: number;
}

export interface ExecutionProfile {
  id: string;
  provider: ExecutionProviderId;
  platform: ExecutionPlatform;
  architecture: ExecutionArchitecture;
  rootMode: ExecutionRootMode;
  acceleration: ExecutionAcceleration;
  capabilities: readonly ExecutionCapability[];
  runner: Readonly<ExecutionRunner>;
}

const PLATFORMS = new Set<ExecutionPlatform>(["linux", "macos", "windows"]);
const ARCHITECTURES = new Set<ExecutionArchitecture>(["amd64", "arm64"]);
const ROOT_MODES = new Set<ExecutionRootMode>(["rootful", "rootless"]);
const ACCELERATIONS = new Set<ExecutionAcceleration>(["cpu", "nvidia-gpu"]);
const CAPABILITIES = new Set<ExecutionCapability>([
  "agent.configure",
  "agent.turn",
  "evidence.collect",
  "sandbox.lifecycle",
  "state.observe",
  "transport.docker-socket",
  "transport.socket-free",
]);

export function assertExecutionFoundationId(value: string, label: string): void {
  if (!EXECUTION_FOUNDATION_ID_PATTERN.test(value)) {
    throw new Error(
      `${label} '${value}' must start with a lowercase letter and contain only lowercase letters, digits, dots, or hyphens`,
    );
  }
}

export function executionProviderId(value: string): ExecutionProviderId {
  assertExecutionFoundationId(value, "Execution provider id");
  return value as ExecutionProviderId;
}

function assertEnumValue<T extends string>(values: ReadonlySet<T>, value: T, label: string): void {
  if (!values.has(value)) {
    throw new Error(`${label} '${value}' is not recognized`);
  }
}

export function defineExecutionProfile(input: ExecutionProfile): ExecutionProfile {
  assertExecutionFoundationId(input.id, "Execution profile id");
  const provider = executionProviderId(input.provider);
  assertEnumValue(PLATFORMS, input.platform, "Execution platform");
  assertEnumValue(ARCHITECTURES, input.architecture, "Execution architecture");
  assertEnumValue(ROOT_MODES, input.rootMode, "Execution root mode");
  assertEnumValue(ACCELERATIONS, input.acceleration, "Execution acceleration");

  if (input.capabilities.length === 0) {
    throw new Error(`Execution profile '${input.id}' must declare capabilities`);
  }
  const capabilities = [...input.capabilities];
  for (const capability of capabilities) {
    assertEnumValue(CAPABILITIES, capability, "Execution capability");
  }
  if (new Set(capabilities).size !== capabilities.length) {
    throw new Error(`Execution profile '${input.id}' declares duplicate capabilities`);
  }

  assertExecutionFoundationId(input.runner.hostId, "Execution runner host id");
  const runnerLabel = input.runner.label.trim();
  if (!runnerLabel || /[\r\n]/u.test(runnerLabel)) {
    throw new Error(`Execution profile '${input.id}' must declare a single-line runner label`);
  }
  if (
    !Number.isSafeInteger(input.runner.maxShards) ||
    input.runner.maxShards < 1 ||
    input.runner.maxShards > MAX_HOST_SHARDS
  ) {
    throw new Error(
      `Execution profile '${input.id}' runner maxShards must be between 1 and ${MAX_HOST_SHARDS}`,
    );
  }

  return Object.freeze({
    ...input,
    provider,
    capabilities: Object.freeze([...capabilities].sort()),
    runner: Object.freeze({ ...input.runner, label: runnerLabel }),
  });
}
