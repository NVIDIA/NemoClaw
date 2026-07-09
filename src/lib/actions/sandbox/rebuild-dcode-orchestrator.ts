// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { WebSearchConfig } from "../../inference/web-search";
import type { DcodeAutoApprovalMode } from "../../onboard/dcode-auto-approval";
import type { Session } from "../../state/onboard-session";
import type { ToolDisclosure } from "../../tool-disclosure";
import {
  createDcodeRebuildPreflightScope,
  type DcodeRebuildPreflightBail,
  ensureDcodeRebuildTargetGatewaySelected,
  type PreparedDcodeReplacement,
  prepareDcodeReplacementBeforeMutation,
  revalidateDcodeReplacementAtMutationEdge,
} from "./rebuild-dcode-preflight";
import { DCODE_AGENT_NAME } from "./rebuild-dcode-target";
import type { RebuildAgentBaseImageOptions, RebuildSandboxEntry } from "./rebuild-flow-helpers";
import type { RebuildResumeConfig } from "./rebuild-resume-config";

type DcodeRebuildOrchestratorDeps = {
  checkGatewaySchema(sandboxName: string, bail: DcodeRebuildPreflightBail): boolean;
  preflightCredentials(
    sandboxName: string,
    entry: RebuildSandboxEntry,
    log: (message: string) => void,
    bail: DcodeRebuildPreflightBail,
  ): boolean;
  ensureAgentBaseImage(
    agentName: string | null,
    bail: DcodeRebuildPreflightBail,
    options?: RebuildAgentBaseImageOptions,
  ): boolean;
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
    webSearchConfig: WebSearchConfig | null,
    toolDisclosure: ToolDisclosure,
    dcodeAutoApprovalMode: DcodeAutoApprovalMode,
    skipLiveRoute: boolean,
    gatewayPort: number,
    baseImageOptions?: RebuildAgentBaseImageOptions,
  ): Promise<boolean>;
  revalidateBeforeDelete(
    resumeConfig: RebuildResumeConfig,
    toolDisclosure: ToolDisclosure,
    dcodeAutoApprovalMode: DcodeAutoApprovalMode,
    skipLiveRoute: boolean,
    gatewayPort: number,
  ): Promise<boolean>;
  checkAtDeleteEdge(
    resumeConfig: RebuildResumeConfig,
    toolDisclosure: ToolDisclosure,
    dcodeAutoApprovalMode: DcodeAutoApprovalMode,
    skipLiveRoute: boolean,
    gatewayPort: number,
  ): Promise<{ ok: true } | { ok: false; message: string; code?: number }>;
  clearManagedCustomDockerfile(session: Session): void;
  storedDockerfile(sessionMatchesSandbox: boolean, session: Session | null): string | null;
  applyDockerGpuPatchNetwork(): () => void;
  cleanup(): void;
};

class CapturedDcodeRebuildBail extends Error {
  readonly code: number | undefined;

  constructor(message: string, code?: number) {
    super(message);
    this.name = "CapturedDcodeRebuildBail";
    this.code = code;
  }
}

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
    prepareImage: (
      resumeConfig,
      webSearchConfig,
      toolDisclosure,
      dcodeAutoApprovalMode,
      skipLiveRoute,
      gatewayPort,
      baseImageOptions,
    ) =>
      run(async () => {
        if (!scope.enabled) {
          return deps.ensureAgentBaseImage(rebuildAgent, scope.bail, baseImageOptions);
        }
        const replacement = await prepareDcodeReplacementBeforeMutation({
          sandboxName,
          entry,
          resumeConfig,
          webSearchConfig,
          toolDisclosure,
          dcodeAutoApprovalMode,
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
    revalidateBeforeDelete: (
      resumeConfig,
      toolDisclosure,
      dcodeAutoApprovalMode,
      skipLiveRoute,
      gatewayPort,
    ) =>
      run(async () => {
        if (!scope.enabled) return true;
        const replacement = scope.preparedReplacement;
        if (!replacement) return scope.bail("DCode replacement preflight was not retained.");
        return revalidateDcodeReplacementAtMutationEdge({
          sandboxName,
          entry,
          resumeConfig,
          toolDisclosure,
          dcodeAutoApprovalMode,
          skipLiveRoute,
          gatewayPort,
          log,
          bail: scope.bail,
          checkGatewaySchema: () => deps.checkGatewaySchema(sandboxName, scope.bail),
          replacement,
        });
      }),
    checkAtDeleteEdge: async (
      resumeConfig,
      toolDisclosure,
      dcodeAutoApprovalMode,
      skipLiveRoute,
      gatewayPort,
    ) => {
      if (!scope.enabled) return { ok: true };
      const replacement = scope.preparedReplacement;
      if (!replacement) {
        return { ok: false, message: "DCode replacement preflight was not retained." };
      }
      const capturedBail = (message: string, code?: number): never => {
        throw new CapturedDcodeRebuildBail(message, code);
      };
      try {
        const valid = await revalidateDcodeReplacementAtMutationEdge({
          sandboxName,
          entry,
          resumeConfig,
          toolDisclosure,
          dcodeAutoApprovalMode,
          skipLiveRoute,
          gatewayPort,
          log,
          bail: capturedBail,
          checkGatewaySchema: () => deps.checkGatewaySchema(sandboxName, capturedBail),
          replacement,
        });
        if (!valid) {
          scope.cleanup();
          return {
            ok: false,
            message: "DCode replacement validation failed before sandbox deletion.",
          };
        }
        return { ok: true };
      } catch (error) {
        scope.cleanup();
        if (error instanceof CapturedDcodeRebuildBail) {
          return { ok: false, message: error.message, code: error.code };
        }
        throw error;
      }
    },
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
