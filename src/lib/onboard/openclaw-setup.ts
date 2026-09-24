// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  configSet,
  extractDotpath,
  readSandboxConfig,
  resolveAgentConfig,
} from "../sandbox/config";
import type { OpenShellSandboxBufferedCommandExecutor } from "../adapters/openshell/sandbox-command";

type WebSearchSelection = { fetchEnabled?: boolean } | null;
const OPENCLAW_ALIVE_HTTP_CODES = new Set([200, 401]);

export async function isOpenclawGatewayReady(
  sandboxName: string,
  port: number,
  sandboxCommandExecutor: OpenShellSandboxBufferedCommandExecutor,
  timeoutMs = 3_000,
): Promise<boolean> {
  const boundedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(3_000, Math.floor(timeoutMs)) : 3_000;
  const curlTimeoutSeconds = String(Math.max(1, boundedTimeoutMs) / 1_000);
  try {
    const result = await sandboxCommandExecutor.runBuffered({
      sandboxName,
      target: { kind: "selected" },
      command: [
        "curl",
        "-so",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--max-time",
        curlTimeoutSeconds,
        `http://127.0.0.1:${String(port)}/health`,
      ],
      tty: false,
    });
    return (
      result.outcome.kind === "completed" &&
      OPENCLAW_ALIVE_HTTP_CODES.has(Number.parseInt(result.stdout.trim(), 10))
    );
  } catch {
    return false;
  }
}

export function createOpenclawGatewayReadinessProbe(
  readSandbox: (sandboxName: string) => { dashboardPort?: number | null } | null,
  defaultPort: number,
  sandboxCommandExecutor: OpenShellSandboxBufferedCommandExecutor,
): (sandboxName: string, timeoutMs?: number) => Promise<boolean> {
  return (sandboxName, timeoutMs) =>
    isOpenclawGatewayReady(
      sandboxName,
      readSandbox(sandboxName)?.dashboardPort ?? defaultPort,
      sandboxCommandExecutor,
      timeoutMs,
    );
}

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
  revalidateSandboxIdentity?: (operation: string) => void,
  deps: OpenClawWebSearchReuseDeps = defaultWebSearchReuseDeps,
): Promise<void> {
  if (webSearchConfig?.fetchEnabled === true) return;
  if (deps.readEnabled(sandboxName) !== true) return;
  revalidateSandboxIdentity?.(`disable OpenClaw web search in sandbox '${sandboxName}'`);
  await deps.disable(sandboxName);
}

export interface ConfigureOpenclawSandboxDeps {
  syncNemoClawConfigInSandbox(
    sandboxName: string,
    provider: string,
    model: string,
    revalidateSandboxIdentity?: (operation: string) => void,
    managedProfileApplied?: boolean,
  ): Promise<void>;
  reconcileWebSearch(
    sandboxName: string,
    webSearchConfig: WebSearchSelection,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<void>;
}

export function createConfigureOpenclawSandbox(deps: ConfigureOpenclawSandboxDeps) {
  return async function configureOpenclawSandbox(
    sandboxName: string,
    model: string,
    provider: string,
    webSearchConfig: WebSearchSelection,
    revalidateSandboxIdentity?: (operation: string) => void,
    managedProfileApplied = false,
  ): Promise<void> {
    await deps.syncNemoClawConfigInSandbox(
      sandboxName,
      provider,
      model,
      revalidateSandboxIdentity,
      managedProfileApplied,
    );
    await deps.reconcileWebSearch(sandboxName, webSearchConfig, revalidateSandboxIdentity);
  };
}

export interface OpenclawSetupDeps {
  step(n: number, total: number, msg: string): void;
  agentProductName(): string;
  shouldRestartNativeGateway(provider: string): boolean;
  restartNativeGateway(sandboxName: string): Promise<
    | { ok: true }
    | {
        ok: false;
        failureLayer: string;
        detail: string;
      }
  >;
  configureOpenclawSandbox(
    sandboxName: string,
    model: string,
    provider: string,
    webSearchConfig: WebSearchSelection,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<void>;
}

export function createOpenclawSetup(deps: OpenclawSetupDeps) {
  return async function setupOpenclaw(
    sandboxName: string,
    model: string,
    provider: string,
    webSearchConfig: WebSearchSelection,
    revalidateSandboxIdentity?: (operation: string) => void,
  ): Promise<void> {
    deps.step(7, 8, `Setting up ${deps.agentProductName()} inside sandbox`);

    await deps.configureOpenclawSandbox(
      sandboxName,
      model,
      provider,
      webSearchConfig,
      revalidateSandboxIdentity,
    );
    if (deps.shouldRestartNativeGateway(provider)) {
      revalidateSandboxIdentity?.(`restart native OpenClaw gateway in sandbox '${sandboxName}'`);
      const restart = await deps.restartNativeGateway(sandboxName);
      if (!restart.ok) {
        throw new Error(
          `OpenClaw native gateway restart failed during setup (${restart.failureLayer}): ${restart.detail}`,
        );
      }
    }
    revalidateSandboxIdentity?.(`publish OpenClaw setup for sandbox '${sandboxName}'`);
    console.log(`  ✓ ${deps.agentProductName()} gateway launched inside sandbox`);
  };
}
