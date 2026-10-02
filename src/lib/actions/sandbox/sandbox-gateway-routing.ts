// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox-scoped gateway routing helpers shared across sandbox lifecycle
 * commands (snapshot, restore, ...) so the snapshot monolith does not have to
 * carry them. Each helper resolves the OpenShell gateway from the sandbox's
 * persisted registry entry — never the process-level `NEMOCLAW_GATEWAY_PORT`
 * — so a sandbox registered on a non-default per-port gateway is addressed
 * correctly.
 */

import { dockerInspect } from "../../adapters/docker";
import { captureResolvedOpenshell } from "../../adapters/openshell/runtime";
import { createCliOpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle-cli";
import { createCliOpenShellGatewayReuseObserver } from "../../adapters/openshell/gateway-reuse-cli";
import { GATEWAY_PORT } from "../../core/ports";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { resolveRegisteredRuntimeProvider } from "../../onboard/runtime-provider/selection";
import * as registry from "../../state/registry";

/**
 * Docker/VM-driver sandboxes do not expose the legacy cluster container, so
 * verify gateway health through OpenShell metadata instead.
 */
export async function probeGatewayMetadataHealth(
  gatewayName: string,
  gatewayPort: number,
): Promise<boolean> {
  const observation = await createCliOpenShellGatewayReuseObserver(
    captureResolvedOpenshell,
  ).observeGatewayReuse({
    target: { kind: "named", gatewayName },
    expectedGatewayPort: gatewayPort,
  });
  return (
    !observation.error &&
    observation.healthy &&
    observation.namedMetadata &&
    observation.endpointBinding === "match"
  );
}

export function usesGatewayMetadataProbe(driver: string | null | undefined): boolean {
  if (driver === "vm") return true;
  if (!driver) return false;
  const provider = resolveRegisteredRuntimeProvider(driver);
  return provider?.gateway.launcher === "nemoclaw";
}

/**
 * Probe whether the OpenShell gateway the named sandbox lives on is running.
 * Resolves the gateway from the sandbox's persisted registry entry — never
 * the process-level `GATEWAY_PORT` — so the probe targets the gateway the
 * sandbox was actually onboarded against.
 */
export async function probeGatewayRunning(sandboxName?: string): Promise<boolean> {
  const entry = sandboxName ? registry.getSandbox(sandboxName) : null;
  const gatewayName = entry ? resolveSandboxGatewayName(entry) : resolveGatewayName(GATEWAY_PORT);
  if (usesGatewayMetadataProbe(entry?.openshellDriver)) {
    return probeGatewayMetadataHealth(gatewayName, entry?.gatewayPort ?? GATEWAY_PORT);
  }
  const container = `openshell-cluster-${gatewayName}`;
  const result = dockerInspect(
    ["--type", "container", "--format", "{{.State.Running}}", container],
    { ignoreError: true, suppressOutput: true },
  );
  return result.status === 0 && String(result.stdout || "").trim() === "true";
}

/**
 * Switch the active OpenShell gateway to the one this sandbox is registered on
 * so downstream unscoped `sandbox list` / `sandbox get` queries target the
 * right gateway.
 */
export async function selectSandboxGatewayIfRegistered(sandboxName: string): Promise<boolean> {
  const entry = registry.getSandbox(sandboxName);
  if (!entry) return true;
  const gatewayName = resolveSandboxGatewayName(entry);
  const selected = await createCliOpenShellGatewayLifecycle(captureResolvedOpenshell).selectGateway(
    { target: { kind: "named", gatewayName } },
  );
  return selected.ok;
}
