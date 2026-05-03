// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/* v8 ignore start -- runtime dependency adapter covered through CLI integration tests. */

import * as onboardSession from "./onboard-session";
import type { ListSandboxesCommandDeps } from "./inventory-commands";
import { parseGatewayInference } from "./inference-config";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./openshell-timeouts";
import { parseSshProcesses, createSystemDeps } from "./sandbox-session-state";
import { resolveOpenshell } from "./resolve-openshell";
import { captureOpenshell } from "./openshell-runtime";
import { recoverRegistryEntries } from "./registry-recovery-action";

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
    recoverRegistryEntries: () => recoverRegistryEntries(),
    getLiveInference: () =>
      parseGatewayInference(
        captureOpenshell(["inference", "get"], {
          ignoreError: true,
          timeout: OPENSHELL_PROBE_TIMEOUT_MS,
        }).output,
      ),
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
