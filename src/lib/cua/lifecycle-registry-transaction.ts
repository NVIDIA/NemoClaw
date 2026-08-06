// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isDeepStrictEqual } from "node:util";
import type { SandboxEntry, SandboxRegistry } from "../state/registry/types";
import { requireCuaReconciliation } from "./reconciliation";

export interface CuaLifecycleRegistryDeps {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  withLock: <T>(fn: () => T) => T;
}

interface WorkingRegistry {
  load: () => SandboxRegistry;
  save: (registry: SandboxRegistry) => void;
  /** Publish staged pre-adapter state with the same whole-row CAS. */
  checkpoint: () => boolean;
}

function cloneEntry(entry: SandboxEntry | undefined): SandboxEntry | undefined {
  return entry === undefined ? undefined : structuredClone(entry);
}

function requireMatchingLiveAttempt(
  latest: SandboxEntry | undefined,
  expected: SandboxEntry | undefined,
): boolean {
  if (!latest) return false;
  const expectedReconciliation = expected?.cuaReconciliation;
  const latestReconciliation = latest?.cuaReconciliation;
  if (
    expectedReconciliation?.operation === null ||
    latestReconciliation?.phase !== "pending" ||
    latestReconciliation.attemptId !== expectedReconciliation?.attemptId
  ) {
    return false;
  }
  latest.cuaReconciliation = requireCuaReconciliation(latestReconciliation);
  return true;
}

/**
 * Run one CUA lifecycle transition without holding the short-lived registry lock
 * across live observations or an external adapter call.
 *
 * The first lock snapshots the complete sandbox row, including its lifecycle
 * generation, inference route, policy intent, runtime readiness, target,
 * security, task, and reconciliation state. The transition runs against an
 * isolated copy. A pre-adapter checkpoint uses the same whole-row CAS to make
 * the uncertain-effect journal durable. The final lock compares the exact
 * durable projection before publishing only this sandbox's update into the
 * latest registry, so unrelated sandbox writes are retained and any
 * same-sandbox drift rejects the adapter output.
 */
export function executeCuaLifecycleRegistryTransaction<T>(options: {
  sandboxName: string;
  deps: CuaLifecycleRegistryDeps;
  execute: (registry: WorkingRegistry) => T;
  conflict: () => T;
}): T {
  const { sandboxName, deps } = options;
  let expected = deps.withLock(() => cloneEntry(deps.load().sandboxes[sandboxName]));
  let workingRegistry: SandboxRegistry = {
    defaultSandbox: expected ? sandboxName : null,
    sandboxes: expected ? { [sandboxName]: structuredClone(expected) } : {},
  };
  let saveRequested = false;
  const commitWorking = (): boolean =>
    deps.withLock(() => {
      const latest = deps.load();
      if (!isDeepStrictEqual(latest.sandboxes[sandboxName], expected)) return false;
      if (saveRequested) {
        const next = workingRegistry.sandboxes[sandboxName];
        if (next === undefined) {
          delete latest.sandboxes[sandboxName];
        } else {
          latest.sandboxes[sandboxName] = structuredClone(next);
        }
        deps.save(latest);
        // Persistence intentionally normalizes a crash-visible `pending`
        // adapter journal to `required` on load. Use that exact durable/runtime
        // projection as the next CAS token while the isolated working copy
        // retains the in-flight attempt for post-adapter validation.
        expected = cloneEntry(deps.load().sandboxes[sandboxName]);
      } else {
        expected = cloneEntry(latest.sandboxes[sandboxName]);
      }
      saveRequested = false;
      return true;
    });
  let outcome: T;
  try {
    outcome = options.execute({
      load: () => workingRegistry,
      save: (next) => {
        workingRegistry = next;
        saveRequested = true;
      },
      checkpoint: commitWorking,
    });
  } catch (error) {
    deps.withLock(() => {
      const latest = deps.load();
      if (requireMatchingLiveAttempt(latest.sandboxes[sandboxName], expected)) {
        deps.save(latest);
      }
    });
    throw error;
  }
  const stagedReconciliation = workingRegistry.sandboxes[sandboxName]?.cuaReconciliation;
  if (stagedReconciliation?.phase === "pending") {
    workingRegistry.sandboxes[sandboxName]!.cuaReconciliation =
      requireCuaReconciliation(stagedReconciliation);
    saveRequested = true;
  }

  return deps.withLock(() => {
    const latest = deps.load();
    if (!isDeepStrictEqual(latest.sandboxes[sandboxName], expected)) {
      if (requireMatchingLiveAttempt(latest.sandboxes[sandboxName], expected)) {
        deps.save(latest);
      }
      return options.conflict();
    }
    if (saveRequested) {
      const next = workingRegistry.sandboxes[sandboxName];
      if (next === undefined) {
        delete latest.sandboxes[sandboxName];
      } else {
        latest.sandboxes[sandboxName] = structuredClone(next);
      }
      deps.save(latest);
    }
    return outcome;
  });
}
