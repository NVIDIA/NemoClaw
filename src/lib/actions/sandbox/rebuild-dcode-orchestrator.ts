// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { Session } from "../../state/onboard-session";
import {
  createDcodeRebuildPreflightScope,
  type DcodeRebuildPreflightBail,
  ensureDcodeRebuildTargetGatewaySelected,
  type PreparedDcodeReplacement,
  prepareDcodeReplacementBeforeMutation,
  revalidateDcodeReplacementAtMutationEdge,
} from "./rebuild-dcode-preflight";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";
import type { RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

type DcodeRebuildOrchestratorDeps = {
  checkGatewaySchema(sandboxName: string, bail: DcodeRebuildPreflightBail): boolean;
  preflightCredentials(
    sandboxName: string,
    entry: RebuildSandboxEntry,
    log: (message: string) => void,
    bail: DcodeRebuildPreflightBail,
  ): boolean;
  ensureAgentBaseImage(agentName: string | null, bail: DcodeRebuildPreflightBail): boolean;
};

type CreateDcodeRebuildOrchestratorOptions = {
  sandboxName: string;
  entry: RebuildSandboxEntry;
  rebuildAgent: string | null;
  log(message: string): void;
  bail: DcodeRebuildPreflightBail;
  deps: DcodeRebuildOrchestratorDeps;
};

export type DcodeRebuildOrchestrator = {
  readonly bail: DcodeRebuildPreflightBail;
  readonly preparedReplacement: PreparedDcodeReplacement | null;
  run<T>(action: () => Promise<T>): Promise<T>;
  runSync<T>(action: () => T): T;
  preflightCredentials(): Promise<boolean>;
  prepareImage(
    resumeConfig: RebuildResumeConfig,
    skipLiveRoute: boolean,
    gatewayPort: number,
  ): Promise<boolean>;
  revalidateBeforeDelete(
    resumeConfig: RebuildResumeConfig,
    skipLiveRoute: boolean,
    gatewayPort: number,
  ): Promise<boolean>;
  clearManagedCustomDockerfile(session: Session): void;
  storedDockerfile(sessionMatchesSandbox: boolean, session: Session | null): string | null;
  applyDockerGpuPatchNetwork(): () => void;
  cleanup(): void;
};

export function isDcodeRebuildAgent(agentName: string | null): boolean {
  return agentName === DCODE_AGENT_NAME;
}

/**
 * Bind the process-local DCode rebuild preflight to one generic rebuild invocation.
 * Reconstructable lifecycle state remains owned by the normal rebuild/session flow.
 */
export function createDcodeRebuildOrchestrator(
  options: CreateDcodeRebuildOrchestratorOptions,
): DcodeRebuildOrchestrator {
  const { sandboxName, entry, rebuildAgent, log, bail, deps } = options;
  const scope = createDcodeRebuildPreflightScope(isDcodeRebuildAgent(rebuildAgent), bail);

  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      scope.cleanup();
      throw error;
    }
  };

  const runSync = <T>(action: () => T): T => {
    try {
      return action();
    } catch (error) {
      scope.cleanup();
      throw error;
    }
  };

  return {
    bail: scope.bail,
    get preparedReplacement() {
      return scope.preparedReplacement;
    },
    run,
    runSync,
    preflightCredentials: () =>
      run(async () => {
        if (scope.enabled) {
          if (
            !(await ensureDcodeRebuildTargetGatewaySelected(sandboxName, entry, log, scope.bail))
          ) {
            return false;
          }
          if (!deps.checkGatewaySchema(sandboxName, scope.bail)) return false;
        }
        return deps.preflightCredentials(sandboxName, entry, log, scope.bail);
      }),
    prepareImage: (resumeConfig, skipLiveRoute, gatewayPort) =>
      run(async () => {
        if (!scope.enabled) return deps.ensureAgentBaseImage(rebuildAgent, scope.bail);
        const replacement = await prepareDcodeReplacementBeforeMutation({
          sandboxName,
          entry,
          resumeConfig,
          skipLiveRoute,
          gatewayPort,
          log,
          bail: scope.bail,
          checkGatewaySchema: () => deps.checkGatewaySchema(sandboxName, scope.bail),
        });
        if (!replacement) {
          scope.cleanup();
          return false;
        }
        scope.adopt(replacement);
        return true;
      }),
    revalidateBeforeDelete: (resumeConfig, skipLiveRoute, gatewayPort) =>
      run(async () => {
        if (!scope.enabled) return true;
        const replacement = scope.preparedReplacement;
        if (!replacement) return scope.bail("DCode replacement preflight was not retained.");
        return revalidateDcodeReplacementAtMutationEdge({
          sandboxName,
          entry,
          resumeConfig,
          skipLiveRoute,
          gatewayPort,
          log,
          bail: scope.bail,
          checkGatewaySchema: () => deps.checkGatewaySchema(sandboxName, scope.bail),
          replacement,
        });
      }),
    clearManagedCustomDockerfile(session) {
      if (scope.enabled) session.metadata = { ...session.metadata, fromDockerfile: null };
    },
    storedDockerfile(sessionMatchesSandbox, session) {
      if (scope.enabled || !sessionMatchesSandbox) return null;
      return session?.metadata?.fromDockerfile || null;
    },
    applyDockerGpuPatchNetwork: scope.applyDockerGpuPatchNetwork,
    cleanup: scope.cleanup,
  };
}
