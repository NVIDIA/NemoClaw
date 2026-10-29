// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Per-gateway-port binding resolver.
 *
 * Historically NemoClaw treated the OpenShell gateway as a process-global
 * singleton named `nemoclaw`, with a single Docker-driver state directory and
 * a single compatibility container. A second onboard that requested a
 * different `NEMOCLAW_GATEWAY_PORT` therefore reused the same named gateway,
 * the same runtime-marker state dir, and the same compat container — so
 * creating the second sandbox recreated/killed the first sandbox's gateway and
 * overwrote its runtime marker.
 *
 * These pure resolvers derive a stable per-port binding. The default port
 * keeps the original `nemoclaw` names verbatim so existing single-sandbox
 * deployments and on-disk state are untouched; any non-default port gets a
 * `-<port>` suffixed name/dir/container so two sandboxes on distinct gateway
 * ports never collide.
 */

import os from "node:os";
import type { GatewayReuseState } from "../state/gateway";
import {
  BASE_GATEWAY_COMPAT_CONTAINER_NAME,
  BASE_GATEWAY_NAME,
  isDefaultGatewayPort,
  resolveGatewayCompatContainerName,
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
  registryEntryGatewayPort,
  type SandboxGatewayBinding,
} from "./gateway-binding/identity";
import { DEFAULT_GATEWAY_PORT, resolveDockerDriverGatewayBinding } from "./gateway/state-dir";

export { resolveDockerDriverGatewayBinding };

export {
  BASE_GATEWAY_COMPAT_CONTAINER_NAME,
  BASE_GATEWAY_NAME,
  isDefaultGatewayPort,
  resolveGatewayCompatContainerName,
  resolveGatewayName,
  resolveGatewayPortFromName,
  resolveSandboxGatewayName,
  registryEntryGatewayPort,
};
export type { SandboxGatewayBinding };

export {
  assertManagedGatewayStateDirectoryParentTrusted,
  BASE_GATEWAY_STATE_DIR_NAME,
  ensureManagedGatewayStateRoot,
  isManagedGatewayStateRootReservation,
  managedGatewayStateRootOwnershipFailure,
  MANAGED_GATEWAY_STATE_ROOT_MARKER,
  removeDockerDriverGatewayBinding,
  resolveGatewayStateDirForPort,
  resolveGatewayStateDirName,
  UnsafeGatewayStateDirectoryError,
} from "./gateway/state-dir";

/**
 * Providers the gateway reports as attached to one sandbox. A failed or
 * unreadable observation returns null, so the caller adds no credential
 * binding rather than submitting one the gateway would reject.
 */
export async function readSandboxProviderAttachments(
  sandboxName: string,
  sandbox: SandboxGatewayBinding | null,
): Promise<readonly string[] | null> {
  if (!sandbox) return null;
  try {
    const { createSandboxes } =
      require("../adapters/openshell/sandboxes") as typeof import("../adapters/openshell/sandboxes");
    const row = await createSandboxes().get({
      target: { kind: "named", gatewayName: resolveSandboxGatewayName(sandbox) },
      workspace: "default",
      name: sandboxName,
      signal: AbortSignal.timeout(5_000),
    });
    return row ? row.providers : null;
  } catch {
    return null;
  }
}

/**
 * Profile type the gateway reports for one provider, or null when the provider
 * cannot be inspected. Used at the live policy-binding boundary so an
 * endpoint-bearing Tavily profile is never added to credential_binding.
 */
export async function readSandboxProviderProfileType(
  providerName: string,
  sandbox: SandboxGatewayBinding | null,
  gatewayName?: string,
): Promise<string | null> {
  const resolvedGatewayName = gatewayName ?? (sandbox ? resolveSandboxGatewayName(sandbox) : null);
  if (!resolvedGatewayName) return null;
  try {
    const { createSandboxes } =
      require("../adapters/openshell/sandboxes") as typeof import("../adapters/openshell/sandboxes");
    return await createSandboxes().getProviderType({
      target: { kind: "named", gatewayName: resolvedGatewayName },
      workspace: "default",
      name: providerName,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
}

/** Resolve one attempt-wide onboarding target without overriding an authoritative rebuild. */
export function resolveCoreOnboardGatewayBinding(options: {
  authoritativeGateway?: { name: string; port: number } | null;
  currentGateway: { name: string; port: number };
  resume: boolean;
  sandbox: SandboxGatewayBinding | null | undefined;
}): { name: string; port: number } {
  if (options.authoritativeGateway) return { ...options.authoritativeGateway };
  if (!options.resume || !options.sandbox) return { ...options.currentGateway };
  const name = resolveSandboxGatewayName(options.sandbox);
  const port = resolveGatewayPortFromName(name);
  if (port === null) throw new Error(`Invalid resolved onboarding gateway name: ${name}`);
  return { name, port };
}

/**
 * Resolve the Docker-driver gateway compatibility container name for a gateway
 * port. A per-port container name prevents the second onboard's
 * `docker run --name ...` (and the pre-launch `docker rm`) from tearing down
 * the first sandbox's compat gateway container.
 */
/** Gateway state classifiers from `state/gateway`, each bound to a gateway name. */
export interface GatewayNameBoundClassifiers {
  hasStaleGateway(gwInfoOutput?: string): boolean;
  isSelectedGateway(statusOutput?: string): boolean;
  isGatewayHealthy(
    statusOutput?: string,
    gwInfoOutput?: string,
    activeGatewayInfoOutput?: string,
  ): boolean;
  getGatewayReuseState(
    statusOutput?: string,
    gwInfoOutput?: string,
    activeGatewayInfoOutput?: string,
  ): GatewayReuseState;
}

/**
 * Bind the gateway-name-aware health/reuse classifiers to a resolved gateway
 * name so a non-default NEMOCLAW_GATEWAY_PORT (gateway `nemoclaw-<port>`) is
 * recognized as its own gateway rather than matched against the `nemoclaw`
 * singleton. Kept out of onboard.ts to avoid growing that file.
 */
export function createGatewayNameBoundClassifiers(
  state: typeof import("../state/gateway"),
  gatewayName: string | (() => string),
): GatewayNameBoundClassifiers {
  const currentGatewayName = () =>
    typeof gatewayName === "function" ? gatewayName() : gatewayName;
  return {
    hasStaleGateway: (gwInfoOutput = "") =>
      state.hasStaleGateway(gwInfoOutput, currentGatewayName()),
    isSelectedGateway: (statusOutput = "") =>
      state.isSelectedGateway(statusOutput, currentGatewayName()),
    isGatewayHealthy: (statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") =>
      state.isGatewayHealthy(
        statusOutput,
        gwInfoOutput,
        activeGatewayInfoOutput,
        currentGatewayName(),
      ),
    getGatewayReuseState: (statusOutput = "", gwInfoOutput = "", activeGatewayInfoOutput = "") =>
      state.getGatewayReuseState(
        statusOutput,
        gwInfoOutput,
        activeGatewayInfoOutput,
        currentGatewayName(),
      ),
  };
}

export interface DynamicGatewayRuntimeDeps {
  getGatewayName(): string;
  getGatewayPort(): number;
  getDockerDriverGatewayEndpoint: typeof import("./docker-driver-gateway-env").getDockerDriverGatewayEndpoint;
  getGatewayClusterImageDrift: (
    options?: import("../adapters/openshell/gateway-drift").GatewayDriftOptions,
  ) =>
    | import("../adapters/openshell/gateway-drift").GatewayClusterImageDrift
    | null
    | Promise<import("../adapters/openshell/gateway-drift").GatewayClusterImageDrift | null>;
  probeGatewayHttpReady: typeof import("./gateway-http-readiness").isGatewayHttpReady;
  probeDockerDriverGatewayHttpReady: typeof import("./gateway-http-readiness").isDockerDriverGatewayHttpReady;
  waitForGatewayHttpReadyBase: typeof import("./gateway-http-readiness").waitForGatewayHttpReady;
  probeGatewayTcpReady: typeof import("./gateway-tcp-readiness").isGatewayTcpReady;
}

/** Bind gateway probes and drift checks to the process-local dynamic gateway target. */
export function createDynamicGatewayRuntimeHelpers(deps: DynamicGatewayRuntimeDeps) {
  const getDockerDriverGatewayEndpoint = () =>
    deps.getDockerDriverGatewayEndpoint(deps.getGatewayPort());
  const getGatewayClusterImageDrift = () =>
    deps.getGatewayClusterImageDrift({ gatewayName: deps.getGatewayName() });
  const isGatewayHttpReady = (
    timeoutMs?: number,
    url?: string,
    method?: "GET" | "POST",
    signal?: AbortSignal,
  ) => {
    const targetUrl = url ?? `${deps.getDockerDriverGatewayEndpoint(deps.getGatewayPort())}/`;
    return deps.probeGatewayHttpReady(timeoutMs, targetUrl, method, signal);
  };
  const isDockerDriverGatewayHttpReady = (
    timeoutMs?: number,
    url?: string,
    env?: NodeJS.ProcessEnv,
  ) =>
    deps.probeDockerDriverGatewayHttpReady(
      timeoutMs,
      url ??
        `${deps.getDockerDriverGatewayEndpoint(deps.getGatewayPort())}/openshell.v1.OpenShell/Health`,
      env,
    );
  const waitForGatewayHttpReady = (
    opts: import("./gateway-http-readiness").WaitForGatewayHttpReadyOpts = {},
  ) =>
    deps.waitForGatewayHttpReadyBase({
      ...opts,
      probe: opts.probe ?? (() => isGatewayHttpReady()),
    });
  const isGatewayTcpReady = (timeoutMs?: number) =>
    deps.probeGatewayTcpReady(deps.getGatewayPort(), timeoutMs);
  return {
    getDockerDriverGatewayEndpoint,
    getGatewayClusterImageDrift,
    isGatewayHttpReady,
    isDockerDriverGatewayHttpReady,
    waitForGatewayHttpReady,
    isGatewayTcpReady,
  };
}

/** Supply recovered network inputs through the runtime's existing dependency hook. */
export function createGatewayEnvLoader(
  module: typeof import("./docker-driver-gateway-env"),
): () => typeof import("./docker-driver-gateway-env") {
  return () => ({
    ...module,
    buildDockerDriverGatewayEnv: (options) =>
      module.buildDockerDriverGatewayEnv({
        ...options,
        dockerNetworkName:
          resolveDockerDriverGatewayBinding(
            process.env,
            os.homedir(),
            options.gatewayPort ?? DEFAULT_GATEWAY_PORT,
          ).dockerNetworkName ?? options.dockerNetworkName,
      }),
  });
}
