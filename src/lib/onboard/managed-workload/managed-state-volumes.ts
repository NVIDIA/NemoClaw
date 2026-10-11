// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ManagedStartupStateRoot } from "../managed-startup/state-roots";
import { OPENSHELL_DEFAULT_WORKSPACE } from "../../adapters/openshell/sandbox-ssh-host";
import type { RuntimeProviderBundle } from "../runtime-provider/contract";
import {
  commitManagedStateVolumeReplacement,
  managedStateVolumeMigrationPhase,
  migrateManagedStateVolume,
  preflightLegacyManagedStateVolume,
  reconcileManagedStateVolumeMigration,
  resolveMigratedManagedStateRoot,
  retireManagedStateVolumeMigration,
  verifyMigratedManagedStateRoot,
  withManagedStateVolumeLock,
  type ManagedVolumeMigrationContext,
  type MigrationEngine,
} from "./managed-state-volume-migration";

const MISSING_VOLUME_PATTERN = /\bno such volume\b/iu;
const COMMAND_TIMEOUT_MS = 30_000;

export type ManagedStateVolumeMount = {
  readonly type: "volume";
  readonly source: string;
  readonly target: string;
  readonly read_only: boolean;
};

export type ManagedStateVolumeCleanupResult =
  | {
      readonly status: "not-applicable" | "absent" | "removed";
      readonly retainedVolumeName?: string;
    }
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
  readonly migrationStateDir?: string;
  readonly runMigrationEngine?: MigrationEngine;
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

function migrationContext(deps: ManagedStateVolumeDeps): ManagedVolumeMigrationContext {
  return {
    providerId: deps.runtimeProvider?.identity.id ?? "docker",
    workspace: process.env.OPENSHELL_WORKSPACE ?? OPENSHELL_DEFAULT_WORKSPACE,
    ...(deps.migrationStateDir ? { stateDir: deps.migrationStateDir } : {}),
  };
}

function migrationEngine(deps: ManagedStateVolumeDeps): MigrationEngine | undefined {
  if (deps.runMigrationEngine) return deps.runMigrationEngine;
  const engine = deps.runtimeProvider?.containerEngine;
  return engine?.supported
    ? (args, timeout) => engine.capture("workload-cleanup", args, timeout)
    : undefined;
}

/** Inspect before source deletion; copying is deferred until create-plan materialization. */
export function preflightManagedStateVolumes(
  input: { readonly roots: readonly ManagedStartupStateRoot[] },
  deps: ManagedStateVolumeDeps = {},
): void {
  if (input.roots.length === 0 || !supportsManagedStateVolumes(deps.runtimeProvider)) return;
  const run =
    deps.runContainerEngine ??
    (deps.runtimeProvider ? defaultRuntimeVolumeRun(deps.runtimeProvider) : undefined);
  if (!run) throw new Error("Managed state volumes require runtime provider authority.");
  const context = migrationContext(deps);
  const engine = migrationEngine(deps);
  if (
    !context.workspace ||
    context.workspace.trim() !== context.workspace ||
    /[\0\r\n]/u.test(context.workspace)
  ) {
    throw new Error("Managed state volume requires an exact OpenShell workspace.");
  }
  for (const original of input.roots) {
    const phase = engine ? managedStateVolumeMigrationPhase(original, context) : null;
    if (engine && (phase === "copying" || phase === "retryable")) {
      reconcileManagedStateVolumeMigration(original, context, engine, true);
      continue;
    }
    const root = engine ? resolveMigratedManagedStateRoot(original, context, true) : original;
    if (engine && phase === "verified") verifyMigratedManagedStateRoot(original, context, engine);
    const observed = inspectVolume(root, run);
    if (observed.status === "failed")
      throw new Error(`Cannot inspect managed state volume: ${observed.detail}`);
    if (observed.status === "absent") continue;
    if (!labelsMatch(observed.labels, root.ownershipLabels))
      throw new Error("Managed state volume ownership changed.");
    const approval = {
      "openshell.ai/sandbox-attachable": "true",
      "openshell.ai/sandbox-attachable-workspace": context.workspace,
    };
    if (
      !labelsMatch(observed.labels, approval) &&
      (!engine ||
        observed.labels["openshell.ai/sandbox-attachable"] !== undefined ||
        observed.labels["openshell.ai/sandbox-attachable-workspace"] !== undefined)
    ) {
      throw new Error(
        "Managed state volume lacks OpenShell attachment approval. Retained data was not changed.",
      );
    }
    if (engine && !labelsMatch(observed.labels, approval))
      preflightLegacyManagedStateVolume(original, engine);
    if (phase === "retired")
      throw new Error("Uncommitted migrated volume replacement requires reconciliation.");
  }
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
  // Match the OpenShell create CLI selector, not the unrelated /sandbox directory.
  const workspace = process.env.OPENSHELL_WORKSPACE ?? OPENSHELL_DEFAULT_WORKSPACE;
  if (!workspace || workspace.trim() !== workspace || /[\0\r\n]/u.test(workspace)) {
    throw new Error("Managed state volume requires an exact OpenShell workspace.");
  }
  const approvalLabels = {
    "openshell.ai/sandbox-attachable": "true",
    "openshell.ai/sandbox-attachable-workspace": workspace,
  };
  const created: ManagedStartupStateRoot[] = [];
  const reused: boolean[] = [];
  const selectedRoots: ManagedStartupStateRoot[] = [];
  const replacementRoots: ManagedStartupStateRoot[] = [];
  const engine = migrationEngine(deps);
  const context = migrationContext(deps);
  try {
    for (const original of input.roots) {
      const prepare = () => {
        if (engine) reconcileManagedStateVolumeMigration(original, context, engine);
        let root = engine ? resolveMigratedManagedStateRoot(original, context, true) : original;
        const migrationPhase = engine ? managedStateVolumeMigrationPhase(original, context) : null;
        if (engine && migrationPhase === "verified")
          verifyMigratedManagedStateRoot(original, context, engine);
        const before = inspectVolume(root, run);
        if (before.status === "failed") {
          throw new Error(
            `Cannot inspect managed state volume '${root.resourceIdentity}': ${before.detail}`,
          );
        }
        if (migrationPhase === "retired" && before.status !== "absent") {
          throw new Error("Uncommitted migrated volume replacement requires reconciliation.");
        }
        if (before.status === "absent") {
          const createArgs = ["create"];
          for (const [name, value] of Object.entries({
            ...root.ownershipLabels,
            ...approvalLabels,
          }).sort(([left], [right]) => left.localeCompare(right))) {
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
        if (!labelsMatch(verified.labels, approvalLabels)) {
          if (
            engine &&
            before.status === "observed" &&
            (migrationPhase === null || migrationPhase === "retryable") &&
            verified.labels["openshell.ai/sandbox-attachable"] === undefined &&
            verified.labels["openshell.ai/sandbox-attachable-workspace"] === undefined
          ) {
            root = { ...root, ...migrateManagedStateVolume(original, context, engine) };
          } else {
            throw new Error(
              "Managed state volume lacks OpenShell attachment approval for the selected workspace. " +
                "Retained data was not changed; operator reconciliation is required.",
            );
          }
        }
        selectedRoots.push(root);
        if (migrationPhase === "retired") replacementRoots.push(original);
        reused.push(before.status === "observed");
      };
      if (engine) withManagedStateVolumeLock(original, context, prepare);
      else prepare();
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
      selectedRoots.map((root) =>
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
      if (engine)
        for (const root of replacementRoots)
          commitManagedStateVolumeReplacement(root, context, engine);
      committed = true;
      unregisterExitCleanup();
    },
  });
}

export function removeManagedStateVolumes(
  input: {
    readonly roots: readonly ManagedStartupStateRoot[];
  },
  deps: ManagedStateVolumeDeps = {},
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
  const engine = migrationEngine(deps);
  const context = migrationContext(deps);
  return Object.freeze(
    input.roots.map((original) => {
      const remove = (): ManagedStateVolumeCleanupResult => {
        const phase = engine ? managedStateVolumeMigrationPhase(original, context) : null;
        if (engine && (phase === "copying" || phase === "retryable")) {
          reconcileManagedStateVolumeMigration(original, context, engine);
          retireManagedStateVolumeMigration(original, context);
          return { status: "absent", retainedVolumeName: original.resourceIdentity };
        }
        const root = engine ? resolveMigratedManagedStateRoot(original, context, true) : original;
        if (engine && managedStateVolumeMigrationPhase(original, context) === "retired") {
          if (inspectVolume(root, run).status === "absent")
            return { status: "absent", retainedVolumeName: original.resourceIdentity };
          return {
            status: "failed",
            volumeName: root.resourceIdentity,
            detail:
              "Retired migration destination is present or unobservable; no volume was removed.",
          };
        }
        if (engine && root.resourceIdentity !== original.resourceIdentity)
          verifyMigratedManagedStateRoot(original, context, engine);
        const result = removeOwnedVolume(root, run);
        if (
          root.resourceIdentity !== original.resourceIdentity &&
          (result.status === "removed" || result.status === "absent")
        ) {
          if (inspectVolume(root, run).status !== "absent")
            return {
              status: "failed",
              volumeName: root.resourceIdentity,
              detail: "Migrated volume absence was not established; original retained.",
            };
          retireManagedStateVolumeMigration(original, context);
          return { ...result, retainedVolumeName: original.resourceIdentity };
        }
        return result;
      };
      return engine ? withManagedStateVolumeLock(original, context, remove) : remove();
    }),
  );
}
