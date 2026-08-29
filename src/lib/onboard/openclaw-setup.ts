// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import {
  configSet,
  extractDotpath,
  readSandboxConfig,
  resolveAgentConfig,
} from "../sandbox/config";
import { sandboxConfigSyncArgs } from "./config-sync";

type WebSearchSelection = { fetchEnabled?: boolean } | null;

interface OpenClawWebSearchReuseDeps {
  readEnabled(sandboxName: string): unknown;
  disable(sandboxName: string): Promise<void>;
}

const defaultWebSearchReuseDeps: OpenClawWebSearchReuseDeps = {
  readEnabled: (sandboxName) => {
    const target = resolveAgentConfig(sandboxName);
    if (target.agentName !== "openclaw") {
      throw new Error(
        `Cannot reconcile OpenClaw web search for '${sandboxName}': the sandbox runs '${target.agentName}'.`,
      );
    }
    return extractDotpath(readSandboxConfig(sandboxName, target), "tools.web.search.enabled");
  },
  disable: (sandboxName) =>
    configSet(sandboxName, {
      key: "tools.web.search.enabled",
      value: "false",
      restart: true,
    }),
};

/**
 * A fresh onboarding can reuse an already-ready sandbox. The image generator
 * does not run again on that path, so explicitly apply a newly disabled web
 * search choice to the live OpenClaw config through its guarded config writer.
 */
export async function disableOpenClawWebSearchForFreshReuse(
  sandboxName: string,
  webSearchConfig: WebSearchSelection,
  deps: OpenClawWebSearchReuseDeps = defaultWebSearchReuseDeps,
): Promise<void> {
  if (webSearchConfig?.fetchEnabled === true) return;
  if (deps.readEnabled(sandboxName) !== true) return;
  await deps.disable(sandboxName);
}

export interface OpenclawSetupDeps {
  step(n: number, total: number, msg: string): void;
  agentProductName(): string;
  getProviderSelectionConfig(provider: string, model: string): unknown | null;
  buildSandboxConfigSyncScript(config: any): string;
  writeSandboxConfigSyncFile(script: string): string;
  run(argv: string[], options: Record<string, unknown>): unknown;
  openshellArgv(args: string[]): string[];
  cleanupTempDir(file: string, prefix: string): void;
  reconcileWebSearch(sandboxName: string, webSearchConfig: WebSearchSelection): Promise<void>;
}

export function createOpenclawSetup(deps: OpenclawSetupDeps) {
  return async function setupOpenclaw(
    sandboxName: string,
    model: string,
    provider: string,
    webSearchConfig: WebSearchSelection,
    revalidatePolicyRequirements?: (operation: string) => void,
  ): Promise<void> {
    deps.step(7, 8, `Setting up ${deps.agentProductName()} inside sandbox`);

    const selectionConfig = deps.getProviderSelectionConfig(provider, model);
    if (selectionConfig) {
      const sandboxConfig = {
        ...(selectionConfig as Record<string, unknown>),
        onboardedAt: new Date().toISOString(),
      };
      const script = deps.buildSandboxConfigSyncScript(sandboxConfig);
      const scriptFile = deps.writeSandboxConfigSyncFile(script);
      try {
        const scriptContent = fs.readFileSync(scriptFile, "utf-8");
        deps.run(deps.openshellArgv(sandboxConfigSyncArgs(sandboxName)), {
          stdio: ["pipe", "ignore", "inherit"],
          input: scriptContent,
        });
      } finally {
        deps.cleanupTempDir(scriptFile, "nemoclaw-sync");
      }
    }

    await deps.reconcileWebSearch(sandboxName, webSearchConfig);
    revalidatePolicyRequirements?.(`publish OpenClaw setup for sandbox '${sandboxName}'`);
    console.log(`  ✓ ${deps.agentProductName()} gateway launched inside sandbox`);
  };
}
