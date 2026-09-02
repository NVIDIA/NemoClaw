// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CURRENT_RUNTIME_PROVIDER_BUNDLES,
  type RuntimeProviderBundle,
  type RuntimeProviderBundleRegistry,
  type RuntimeProviderGatewayLauncher,
  resolveRuntimeProviderBundle,
  resolveCurrentRuntimeProviderBundle,
  runtimeProviderContainerEngineIdentity,
} from "../runtime-provider/access";

export type OpenShellGatewayLauncher = RuntimeProviderGatewayLauncher;

/**
 * Keeps OpenShell driver identity separate from the component that launches
 * its gateway. A future driver does not inherit Docker lifecycle behavior
 * because NemoClaw launches its gateway.
 */
export interface OpenShellComputePlan {
  readonly driverName: string;
  readonly gatewayLauncher: OpenShellGatewayLauncher;
}

export interface CurrentOpenShellRuntimeSelection {
  readonly plan: OpenShellComputePlan;
  readonly provider: RuntimeProviderBundle;
}

export function projectRuntimeProviderComputePlan(
  bundle: RuntimeProviderBundle,
): OpenShellComputePlan {
  return {
    driverName: bundle.identity.id,
    gatewayLauncher: bundle.plan.gatewayLauncher,
  };
}

/**
 * Describes the behavior NemoClaw uses today. Driver selection will move behind
 * this seam without changing the existing Docker and Kubernetes paths first.
 */
export function resolveCurrentOpenShellComputePlan(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): OpenShellComputePlan {
  return resolveCurrentOpenShellRuntimeSelection(platform, arch, env).plan;
}

/** Resolve the configured provider once and project every central selection from that bundle. */
export function resolveCurrentOpenShellRuntimeSelection(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
  env: NodeJS.ProcessEnv = process.env,
): CurrentOpenShellRuntimeSelection {
  const provider = resolveCurrentRuntimeProviderBundle(
    platform,
    arch,
    CURRENT_RUNTIME_PROVIDER_BUNDLES,
    env,
  );
  return { plan: projectRuntimeProviderComputePlan(provider), provider };
}

export function usesManagedLocalGateway(
  plan: Pick<OpenShellComputePlan, "driverName" | "gatewayLauncher">,
  providers: RuntimeProviderBundleRegistry = CURRENT_RUNTIME_PROVIDER_BUNDLES,
): boolean {
  const bundle = resolveRuntimeProviderBundle(plan.driverName, providers);
  const engine = bundle
    ? runtimeProviderContainerEngineIdentity(bundle, "gateway-inspection")
    : null;
  return (
    bundle?.gateway.launcher === plan.gatewayLauncher &&
    plan.gatewayLauncher === "nemoclaw" &&
    engine !== null
  );
}
