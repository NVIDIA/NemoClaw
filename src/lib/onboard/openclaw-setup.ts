// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  configSet,
  extractDotpath,
  readSandboxConfig,
  resolveAgentConfig,
} from "../sandbox/config";

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
 * Onboarding can reuse an already-ready sandbox without rerunning the image
 * generator. Apply a newly disabled web-search choice to the live OpenClaw
 * config through its guarded config writer on both fresh and resumed reuse.
 */
export async function reconcileOpenClawWebSearchForReuse(
  sandboxName: string,
  webSearchConfig: WebSearchSelection,
  revalidatePolicyRequirements?: (operation: string) => void,
  deps: OpenClawWebSearchReuseDeps = defaultWebSearchReuseDeps,
): Promise<void> {
  if (webSearchConfig?.fetchEnabled === true) return;
  if (deps.readEnabled(sandboxName) !== true) return;
  revalidatePolicyRequirements?.(`disable OpenClaw web search in sandbox '${sandboxName}'`);
  await deps.disable(sandboxName);
}

export interface ConfigureOpenclawSandboxDeps {
  syncNemoClawConfigInSandbox(
    sandboxName: string,
    provider: string,
    model: string,
    revalidatePolicyRequirements?: (operation: string) => void,
  ): void;
  reconcileWebSearch(
    sandboxName: string,
    webSearchConfig: WebSearchSelection,
    revalidatePolicyRequirements?: (operation: string) => void,
  ): Promise<void>;
}

export function createConfigureOpenclawSandbox(deps: ConfigureOpenclawSandboxDeps) {
  return async function configureOpenclawSandbox(
    sandboxName: string,
    model: string,
    provider: string,
    webSearchConfig: WebSearchSelection,
    revalidatePolicyRequirements?: (operation: string) => void,
  ): Promise<void> {
    deps.syncNemoClawConfigInSandbox(sandboxName, provider, model, revalidatePolicyRequirements);
    await deps.reconcileWebSearch(sandboxName, webSearchConfig, revalidatePolicyRequirements);
  };
}

export interface OpenclawSetupDeps {
  step(n: number, total: number, msg: string): void;
  agentProductName(): string;
  configureOpenclawSandbox(
    sandboxName: string,
    model: string,
    provider: string,
    webSearchConfig: WebSearchSelection,
    revalidatePolicyRequirements?: (operation: string) => void,
  ): Promise<void>;
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

    await deps.configureOpenclawSandbox(
      sandboxName,
      model,
      provider,
      webSearchConfig,
      revalidatePolicyRequirements,
    );
    revalidatePolicyRequirements?.(`publish OpenClaw setup for sandbox '${sandboxName}'`);
    console.log(`  ✓ ${deps.agentProductName()} gateway launched inside sandbox`);
  };
}
