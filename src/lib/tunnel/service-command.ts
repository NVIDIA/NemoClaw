// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface SandboxSummary {
  defaultSandbox?: string | null;
}

export interface SandboxServiceTarget {
  dashboardPort?: number | null;
}

export interface ServiceTargetDeps {
  listSandboxes: () => SandboxSummary;
  getSandbox: (name: string) => SandboxServiceTarget | null;
}

export interface StartCommandDeps {
  listSandboxes: () => SandboxSummary;
  getSandbox: (name: string) => SandboxServiceTarget | null;
  startAll: (options: { sandboxName?: string; dashboardPort?: number }) => Promise<void>;
}

export interface StopCommandDeps {
  listSandboxes: () => SandboxSummary;
  stopAll: (options: { sandboxName?: string; releaseGatewayPort?: boolean }) => void;
  /** Legacy `nemoclaw stop` tears down the managed host gateway too. */
  releaseGatewayPort?: boolean;
}

const SAFE_SANDBOX_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function resolveDefaultSandboxName(listSandboxes: () => SandboxSummary): string | undefined {
  // Explicit env var overrides take highest priority so that
  // `NEMOCLAW_SANDBOX_NAME=foo nemoclaw stop` targets the right sandbox.
  const envName =
    process.env.NEMOCLAW_SANDBOX_NAME ?? process.env.NEMOCLAW_SANDBOX ?? process.env.SANDBOX_NAME;
  if (envName && SAFE_SANDBOX_RE.test(envName)) return envName;

  const { defaultSandbox } = listSandboxes();
  return defaultSandbox && SAFE_SANDBOX_RE.test(defaultSandbox) ? defaultSandbox : undefined;
}

export function resolveDefaultSandboxServiceOptions(deps: ServiceTargetDeps): {
  sandboxName?: string;
  dashboardPort?: number;
} {
  const sandboxName = resolveDefaultSandboxName(deps.listSandboxes);
  const dashboardPort = sandboxName ? deps.getSandbox(sandboxName)?.dashboardPort : undefined;
  const validDashboardPort =
    typeof dashboardPort === "number" &&
    Number.isSafeInteger(dashboardPort) &&
    dashboardPort >= 1 &&
    dashboardPort <= 65535
      ? dashboardPort
      : undefined;
  return {
    sandboxName,
    ...(validDashboardPort === undefined ? {} : { dashboardPort: validDashboardPort }),
  };
}

export async function runStartCommand(deps: StartCommandDeps): Promise<void> {
  await deps.startAll(resolveDefaultSandboxServiceOptions(deps));
}

export function runStopCommand(deps: StopCommandDeps): void {
  const options: { sandboxName?: string; releaseGatewayPort?: boolean } = {
    sandboxName: resolveDefaultSandboxName(deps.listSandboxes),
  };
  if (deps.releaseGatewayPort) options.releaseGatewayPort = true;
  deps.stopAll(options);
}
