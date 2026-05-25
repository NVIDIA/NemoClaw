// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as onboardSession from "./state/onboard-session";
import type { ListSandboxesCommandDeps, SandboxEntry } from "./inventory";
import { getLiveGatewayInference } from "./inference/live";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./adapters/openshell/timeouts";
import { parseSshProcesses, createSystemDeps } from "./state/sandbox-session";
import { resolveOpenshell } from "./adapters/openshell/resolve";
import { captureOpenshell } from "./adapters/openshell/runtime";
import { recoverRegistryEntries } from "./registry-recovery-action";
import * as registry from "./state/registry";

interface RecoveredRegistry {
  sandboxes: SandboxEntry[];
  defaultSandbox?: string | null;
  recoveredFromSession?: boolean;
  recoveredFromGateway?: number;
}

interface RegistryFallback {
  sandboxes: SandboxEntry[];
  defaultSandbox?: string | null;
}

/**
 * #2666 fallback wrapper: if the primary recovery throws (e.g. openshell
 * hangs talking to a foreign port-holder), surface the registry-only
 * listing instead of letting the throw propagate and silence output.
 *
 * Exported for direct unit testing — `buildListCommandDeps()` wires the
 * real `recoverRegistryEntries` and `registry.listSandboxes` here.
 */
export async function recoverRegistryEntriesWithFallback(
  primary: () => Promise<RecoveredRegistry>,
  fallback: () => RegistryFallback,
): Promise<RecoveredRegistry> {
  try {
    return await primary();
  } catch {
    const list = fallback();
    return { ...list, recoveredFromSession: false, recoveredFromGateway: 0 };
  }
}

export function buildListCommandDeps(): ListSandboxesCommandDeps {
  const opsBinList = resolveOpenshell();
  const sessionDeps = opsBinList ? createSystemDeps(opsBinList) : null;

  // Cache the SSH process probe once for all sandboxes — avoids spawning ps
  // per sandbox row. The getSshProcesses() call is the expensive part (5s timeout).
  let cachedSshOutput: string | null | undefined;
  const getCachedSshOutput = () => {
    if (cachedSshOutput === undefined && sessionDeps) {
      try {
        cachedSshOutput = sessionDeps.getSshProcesses();
      } catch {
        cachedSshOutput = null;
      }
    }
    return cachedSshOutput ?? null;
  };

  return {
    // #2666: never let an unexpected throw from gateway-side recovery (e.g.
    // openshell hanging on a foreign port-holder while its container is
    // stopped) suppress the registry-only listing. The registry lives on
    // disk and is independent of runtime state.
    recoverRegistryEntries: () =>
      recoverRegistryEntriesWithFallback(
        () => recoverRegistryEntries(),
        () => registry.listSandboxes(),
      ),
    getLiveInference: () => {
      try {
        return getLiveGatewayInference(captureOpenshell, {
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        }).inference;
      } catch {
        return null;
      }
    },
    loadLastSession: () => onboardSession.loadSession(),
    getActiveSessionCount: sessionDeps
      ? (name) => {
          try {
            const sshOutput = getCachedSshOutput();
            if (sshOutput === null) return null;
            return parseSshProcesses(sshOutput, name).length;
          } catch {
            return null;
          }
        }
      : undefined,
  };
}
