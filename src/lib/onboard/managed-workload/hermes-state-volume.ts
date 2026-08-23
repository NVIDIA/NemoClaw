// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  RuntimeProviderBundle,
  RuntimeProviderBundleRegistry,
} from "../runtime-provider/contract";
import {
  requireRuntimeProviderBundle,
  runtimeProviderContainerEngineIdentity,
  runtimeProviderSupportsContainerEngineOperation,
} from "../runtime-provider/registry";

/**
 * SOURCE_OF_TRUTH_REVIEW
 * invalidState: a managed-image Hermes sandbox starts without durable writable state, or a
 *   same-named foreign runtime volume is mistaken for NemoClaw-owned state during cleanup.
 * sourceBoundary: the managed image does not declare a provider volume and OpenShell keeps
 *   state-mutation validation strict; this module is the sole owner of the runtime volume name,
 *   exact four-label ownership contract, create/reuse verification, and removal decision.
 * whyNotSourceFix: the provider-neutral image cannot name a sandbox-scoped runtime volume, while
 *   weakening provider validation would accept absent, ambiguous, or read-only state mounts.
 * regressionTest: hermes-state-volume.test.ts covers create, reuse, ownership refusal, and
 *   removal; sandbox-create-plan.test.ts and destroy-flow.test.ts cover lifecycle integration.
 * removalCondition: remove when the managed-image or runtime-provider contract creates,
 *   reconciles, and ownership-gates an equivalent durable Hermes state volume end to end.
 */
export const MANAGED_HERMES_STATE_ROOT = "/sandbox/.hermes" as const;

const VOLUME_NAME_PREFIX = "nemoclaw-hermes-state-v1";
const MANAGED_LABEL = "io.nvidia.nemoclaw.hermes-state.managed";
const SCHEMA_LABEL = "io.nvidia.nemoclaw.hermes-state.schema";
const SANDBOX_LABEL = "io.nvidia.nemoclaw.hermes-state.sandbox";
const TARGET_LABEL = "io.nvidia.nemoclaw.hermes-state.target";
const MISSING_VOLUME_PATTERN = /\bno such volume\b/iu;
const COMMAND_TIMEOUT_MS = 30_000;

export type ManagedHermesStateVolumeContext = {
  readonly agentName: string | null | undefined;
  readonly runtimeProviderId: string | null | undefined;
  readonly sandboxName: string;
  readonly workloadKind: string;
};

export type ManagedHermesStateVolumeMount = {
  readonly type: "volume";
  readonly source: string;
  readonly target: typeof MANAGED_HERMES_STATE_ROOT;
  readonly read_only: false;
};

export type ManagedHermesStateVolumeCleanupResult =
  | { readonly status: "not-applicable" | "absent" | "removed" }
  | {
      readonly status: "not-owned" | "failed";
      readonly detail: string;
      readonly volumeName: string;
    };

type ContainerEngineRunOptions = {
  readonly ignoreError?: boolean;
  readonly maxBuffer?: number;
  readonly suppressOutput?: boolean;
  readonly timeout?: number;
};

type ContainerEngineRunResult = {
  readonly status: number | null;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
  readonly error?: Error;
};

type ContainerEngineRun = (
  args: readonly string[],
  options?: ContainerEngineRunOptions,
) => ContainerEngineRunResult;

export type ManagedHermesStateVolumeDeps = {
  readonly runDocker?: ContainerEngineRun;
  readonly runtimeProvider?: RuntimeProviderBundle;
  readonly runtimeProviders?: RuntimeProviderBundleRegistry;
  readonly registerExitCleanup?: (cleanup: () => void) => () => void;
};

export type ManagedHermesStateVolumeScope = {
  readonly mount: ManagedHermesStateVolumeMount;
  readonly reused: boolean;
  readonly volumeName: string;
  cleanupIncompleteCreate(): ManagedHermesStateVolumeCleanupResult;
  commit(): void;
};

type VolumeObservation =
  | { readonly status: "absent" }
  | { readonly status: "observed"; readonly labels: Readonly<Record<string, string>> }
  | { readonly status: "failed"; readonly detail: string };

function defaultRuntimeVolumeRun(provider: RuntimeProviderBundle): ContainerEngineRun {
  const containerEngine = provider.containerEngine;
  if (containerEngine.supported !== true) {
    throw new Error("The selected runtime provider does not expose container-engine authority.");
  }
  return (args, options) =>
    containerEngine.capture("sandbox-lifecycle", ["volume", ...args], options?.timeout);
}

function defaultRegisterExitCleanup(cleanup: () => void): () => void {
  process.on("exit", cleanup);
  return () => process.removeListener("exit", cleanup);
}

function commandOutput(result: ContainerEngineRunResult): string {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim();
}

function boundedDetail(result: ContainerEngineRunResult): string {
  return commandOutput(result).replace(/\s+/gu, " ").slice(0, 500) || "Docker command failed";
}

export function managedHermesStateVolumeLabels(
  sandboxName: string,
): Readonly<Record<string, string>> {
  return Object.freeze({
    [MANAGED_LABEL]: "true",
    [SCHEMA_LABEL]: "1",
    [SANDBOX_LABEL]: sandboxName,
    [TARGET_LABEL]: MANAGED_HERMES_STATE_ROOT,
  });
}

function labelsMatch(
  observed: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([name, value]) => observed[name] === value);
}

function inspectVolume(volumeName: string, runDocker: ContainerEngineRun): VolumeObservation {
  const result = runDocker(["inspect", "--format", "{{json .}}", volumeName], {
    ignoreError: true,
    maxBuffer: 256 * 1024,
    suppressOutput: true,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    return MISSING_VOLUME_PATTERN.test(commandOutput(result))
      ? { status: "absent" }
      : { status: "failed", detail: boundedDetail(result) };
  }
  const lines = String(result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) {
    return {
      status: "failed",
      detail: "Container engine returned an ambiguous volume inspection.",
    };
  }
  try {
    const value = JSON.parse(lines[0]!) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        status: "failed",
        detail: "Container engine returned a malformed volume inspection.",
      };
    }
    const record = value as Record<string, unknown>;
    if (record.Name !== volumeName) {
      return { status: "failed", detail: "Container engine returned the wrong volume identity." };
    }
    const labelsValue = record.Labels;
    if (!labelsValue || typeof labelsValue !== "object" || Array.isArray(labelsValue)) {
      return { status: "observed", labels: Object.freeze({}) };
    }
    const labels: Record<string, string> = {};
    for (const [name, labelValue] of Object.entries(labelsValue)) {
      if (typeof labelValue !== "string") {
        return { status: "failed", detail: "Container engine returned malformed volume labels." };
      }
      labels[name] = labelValue;
    }
    return { status: "observed", labels: Object.freeze(labels) };
  } catch {
    return {
      status: "failed",
      detail: "Container engine returned invalid JSON for the volume inspection.",
    };
  }
}

export function managedHermesStateVolumeName(sandboxName: string): string {
  return `${VOLUME_NAME_PREFIX}-${sandboxName}`;
}

export function requiresManagedHermesStateVolume(
  context: ManagedHermesStateVolumeContext,
  providers?: RuntimeProviderBundleRegistry,
  runtimeProvider?: RuntimeProviderBundle,
): boolean {
  const hasLifecycleAuthority = runtimeProvider
    ? runtimeProviderContainerEngineIdentity(runtimeProvider, "sandbox-lifecycle") !== null
    : providers
      ? runtimeProviderSupportsContainerEngineOperation(
          context.runtimeProviderId,
          providers,
          "sandbox-lifecycle",
        )
      : true;
  return (
    context.agentName === "hermes" &&
    hasLifecycleAuthority &&
    context.workloadKind === "managed-image"
  );
}

function removeOwnedVolume(
  sandboxName: string,
  runDocker: ContainerEngineRun,
): ManagedHermesStateVolumeCleanupResult {
  const volumeName = managedHermesStateVolumeName(sandboxName);
  const observation = inspectVolume(volumeName, runDocker);
  if (observation.status === "absent") return { status: "absent" };
  if (observation.status === "failed") {
    return { status: "failed", detail: observation.detail, volumeName };
  }
  if (!labelsMatch(observation.labels, managedHermesStateVolumeLabels(sandboxName))) {
    return {
      status: "not-owned",
      detail: "the exact NemoClaw ownership labels are absent or changed",
      volumeName,
    };
  }
  const result = runDocker(["rm", volumeName], {
    ignoreError: true,
    suppressOutput: true,
    timeout: COMMAND_TIMEOUT_MS,
  });
  return result.status === 0
    ? { status: "removed" }
    : { status: "failed", detail: boundedDetail(result), volumeName };
}

export function prepareManagedHermesStateVolume(
  context: ManagedHermesStateVolumeContext,
  deps: ManagedHermesStateVolumeDeps = {},
): ManagedHermesStateVolumeScope | null {
  const providers = deps.runtimeProviders;
  if (!requiresManagedHermesStateVolume(context, providers, deps.runtimeProvider)) return null;
  const provider =
    deps.runtimeProvider ??
    (providers ? requireRuntimeProviderBundle(context.runtimeProviderId, providers) : null);
  const runDocker =
    deps.runDocker ??
    (provider
      ? defaultRuntimeVolumeRun(provider)
      : (() => {
          throw new Error("Managed Hermes state volume requires runtime provider authority.");
        })());
  const volumeName = managedHermesStateVolumeName(context.sandboxName);
  const labels = managedHermesStateVolumeLabels(context.sandboxName);
  const before = inspectVolume(volumeName, runDocker);
  if (before.status === "failed") {
    throw new Error(`Cannot inspect managed Hermes state volume '${volumeName}': ${before.detail}`);
  }
  let created = false;
  if (before.status === "absent") {
    const createArgs = ["create"];
    for (const [name, value] of Object.entries(labels).sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      createArgs.push("--label", `${name}=${value}`);
    }
    createArgs.push(volumeName);
    const createdResult = runDocker(createArgs, {
      ignoreError: true,
      suppressOutput: true,
      timeout: COMMAND_TIMEOUT_MS,
    });
    if (createdResult.status !== 0) {
      throw new Error(
        `Cannot create managed Hermes state volume '${volumeName}': ${boundedDetail(createdResult)}`,
      );
    }
    created = true;
  }
  const verified = inspectVolume(volumeName, runDocker);
  if (verified.status !== "observed" || !labelsMatch(verified.labels, labels)) {
    if (created) removeOwnedVolume(context.sandboxName, runDocker);
    const detail =
      verified.status === "failed"
        ? verified.detail
        : verified.status === "absent"
          ? "the volume disappeared after creation"
          : "the exact NemoClaw ownership labels do not match";
    throw new Error(`Cannot use managed Hermes state volume '${volumeName}': ${detail}.`);
  }

  let committed = false;
  const cleanup = (): ManagedHermesStateVolumeCleanupResult => {
    if (committed || !created) return { status: "not-applicable" };
    return removeOwnedVolume(context.sandboxName, runDocker);
  };
  const unregisterExitCleanup = created
    ? (deps.registerExitCleanup ?? defaultRegisterExitCleanup)(() => {
        cleanup();
      })
    : () => undefined;

  return {
    mount: Object.freeze({
      type: "volume",
      source: volumeName,
      target: MANAGED_HERMES_STATE_ROOT,
      read_only: false,
    }),
    reused: !created,
    volumeName,
    cleanupIncompleteCreate: cleanup,
    commit() {
      committed = true;
      unregisterExitCleanup();
    },
  };
}

export function removeManagedHermesStateVolume(
  context: ManagedHermesStateVolumeContext,
  deps: Pick<
    ManagedHermesStateVolumeDeps,
    "runDocker" | "runtimeProvider" | "runtimeProviders"
  > = {},
): ManagedHermesStateVolumeCleanupResult {
  const providers = deps.runtimeProviders;
  if (!requiresManagedHermesStateVolume(context, providers, deps.runtimeProvider)) {
    return { status: "not-applicable" };
  }
  const provider =
    deps.runtimeProvider ??
    (providers ? requireRuntimeProviderBundle(context.runtimeProviderId, providers) : null);
  return removeOwnedVolume(
    context.sandboxName,
    deps.runDocker ??
      (provider
        ? defaultRuntimeVolumeRun(provider)
        : (() => {
            throw new Error("Managed Hermes state volume requires runtime provider authority.");
          })()),
  );
}
