// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedStartupStateRoot } from "../managed-startup/state-roots";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";

const MISSING_VOLUME_PATTERN = /\bno such volume\b/iu;
const COMMAND_TIMEOUT_MS = 30_000;

export type ManagedStateVolumeMount = {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
};

export type ManagedStateVolumeCleanupResult =
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

export type ManagedStateVolumeDeps = {
  readonly runContainerEngine?: ContainerEngineRun;
  readonly runtimeProvider?: RuntimeProviderBundle;
  readonly registerExitCleanup?: (cleanup: () => void) => () => void;
};

export type ManagedStateVolumeScope = {
  readonly mounts: readonly ManagedStateVolumeMount[];
  readonly reused: readonly boolean[];
  cleanupIncompleteCreate(): readonly ManagedStateVolumeCleanupResult[];
  commit(): void;
};

type VolumeObservation =
  | { readonly status: "absent" }
  | {
      readonly status: "observed";
      readonly labels: Readonly<Record<string, string>>;
    }
  | { readonly status: "failed"; readonly detail: string };

function defaultRuntimeVolumeRun(provider: RuntimeProviderBundle): ContainerEngineRun {
  const containerEngine = provider.containerEngine;
  if (containerEngine.supported !== true) {
    throw new Error("The selected runtime provider does not expose container-engine authority.");
  }
  return (args, options) =>
    containerEngine.capture("workload-cleanup", ["volume", ...args], options?.timeout);
}

function defaultRegisterExitCleanup(cleanup: () => void): () => void {
  process.on("exit", cleanup);
  return () => process.removeListener("exit", cleanup);
}

function commandOutput(result: ContainerEngineRunResult): string {
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`.trim();
}

function boundedDetail(result: ContainerEngineRunResult): string {
  return commandOutput(result).replace(/\s+/gu, " ").slice(0, 500) || "runtime command failed";
}

function labelsMatch(
  observed: Readonly<Record<string, string>>,
  expected: Readonly<Record<string, string>>,
): boolean {
  return Object.entries(expected).every(([name, value]) => observed[name] === value);
}

function inspectVolume(root: ManagedStartupStateRoot, run: ContainerEngineRun): VolumeObservation {
  const result = run(["inspect", "--format", "{{json .}}", root.resourceIdentity], {
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
    if (record.Name !== root.resourceIdentity) {
      return {
        status: "failed",
        detail: "Container engine returned the wrong volume identity.",
      };
    }
    const labelsValue = record.Labels;
    if (!labelsValue || typeof labelsValue !== "object" || Array.isArray(labelsValue)) {
      return { status: "observed", labels: Object.freeze({}) };
    }
    const labels: Record<string, string> = {};
    for (const [name, labelValue] of Object.entries(labelsValue)) {
      if (typeof labelValue !== "string") {
        return {
          status: "failed",
          detail: "Container engine returned malformed volume labels.",
        };
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

function removeOwnedVolume(
  root: ManagedStartupStateRoot,
  run: ContainerEngineRun,
): ManagedStateVolumeCleanupResult {
  const observation = inspectVolume(root, run);
  if (observation.status === "absent") return { status: "absent" };
  if (observation.status === "failed") {
    return {
      status: "failed",
      detail: observation.detail,
      volumeName: root.resourceIdentity,
    };
  }
  if (!labelsMatch(observation.labels, root.ownershipLabels)) {
    return {
      status: "not-owned",
      detail: "the exact NemoClaw ownership labels are absent or changed",
      volumeName: root.resourceIdentity,
    };
  }
  const result = run(["rm", root.resourceIdentity], {
    ignoreError: true,
    suppressOutput: true,
    timeout: COMMAND_TIMEOUT_MS,
  });
  return result.status === 0
    ? { status: "removed" }
    : {
        status: "failed",
        detail: boundedDetail(result),
        volumeName: root.resourceIdentity,
      };
}

function supportsManagedStateVolumes(provider?: RuntimeProviderBundle): boolean {
  return provider?.containerEngine.supported !== false;
}

export function prepareManagedStateVolumes(
  input: {
    readonly roots: readonly ManagedStartupStateRoot[];
  },
  deps: ManagedStateVolumeDeps = {},
): ManagedStateVolumeScope | null {
  if (input.roots.length === 0 || !supportsManagedStateVolumes(deps.runtimeProvider)) {
    return null;
  }
  const provider = deps.runtimeProvider ?? null;
  const run =
    deps.runContainerEngine ??
    (provider
      ? defaultRuntimeVolumeRun(provider)
      : (() => {
          throw new Error("Managed state volumes require runtime provider authority.");
        })());
  const created: ManagedStartupStateRoot[] = [];
  const reused: boolean[] = [];
  try {
    for (const root of input.roots) {
      const before = inspectVolume(root, run);
      if (before.status === "failed") {
        throw new Error(
          `Cannot inspect managed state volume '${root.resourceIdentity}': ${before.detail}`,
        );
      }
      if (before.status === "absent") {
        const createArgs = ["create"];
        for (const [name, value] of Object.entries(root.ownershipLabels).sort(([left], [right]) =>
          left.localeCompare(right),
        )) {
          createArgs.push("--label", `${name}=${value}`);
        }
        createArgs.push(root.resourceIdentity);
        const result = run(createArgs, {
          ignoreError: true,
          suppressOutput: true,
          timeout: COMMAND_TIMEOUT_MS,
        });
        if (result.status !== 0) {
          throw new Error(
            `Cannot create managed state volume '${root.resourceIdentity}': ${boundedDetail(result)}`,
          );
        }
        created.push(root);
      }
      const verified = inspectVolume(root, run);
      if (verified.status !== "observed" || !labelsMatch(verified.labels, root.ownershipLabels)) {
        const detail =
          verified.status === "failed"
            ? verified.detail
            : verified.status === "absent"
              ? "the volume disappeared after creation"
              : "the exact NemoClaw ownership labels do not match";
        throw new Error(`Cannot use managed state volume '${root.resourceIdentity}': ${detail}.`);
      }
      reused.push(before.status === "observed");
    }
  } catch (error) {
    for (const root of [...created].reverse()) removeOwnedVolume(root, run);
    throw error;
  }
  let committed = false;
  const cleanup = (): readonly ManagedStateVolumeCleanupResult[] =>
    committed ? [] : [...created].reverse().map((root) => removeOwnedVolume(root, run));
  const unregisterExitCleanup =
    created.length > 0
      ? (deps.registerExitCleanup ?? defaultRegisterExitCleanup)(() => {
          cleanup();
        })
      : () => undefined;
  return Object.freeze({
    mounts: Object.freeze(
      input.roots.map((root) =>
        Object.freeze({
          type: "volume" as const,
          source: root.resourceIdentity,
          target: root.mountTarget,
          read_only: !root.readWrite,
        }),
      ),
    ),
    reused: Object.freeze(reused),
    cleanupIncompleteCreate: cleanup,
    commit() {
      committed = true;
      unregisterExitCleanup();
    },
  });
}

export function removeManagedStateVolumes(
  input: {
    readonly roots: readonly ManagedStartupStateRoot[];
  },
  deps: Pick<ManagedStateVolumeDeps, "runContainerEngine" | "runtimeProvider"> = {},
): readonly ManagedStateVolumeCleanupResult[] {
  if (input.roots.length === 0 || !supportsManagedStateVolumes(deps.runtimeProvider)) {
    return Object.freeze([]);
  }
  const provider = deps.runtimeProvider ?? null;
  const run =
    deps.runContainerEngine ??
    (provider
      ? defaultRuntimeVolumeRun(provider)
      : (() => {
          throw new Error("Managed state volumes require runtime provider authority.");
        })());
  return Object.freeze(input.roots.map((root) => removeOwnedVolume(root, run)));
}
