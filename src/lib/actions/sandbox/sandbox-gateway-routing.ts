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
import { captureOpenshell, runOpenshell } from "../../adapters/openshell/runtime";
import {
  OPENSHELL_OPERATION_TIMEOUT_MS,
  OPENSHELL_PROBE_TIMEOUT_MS,
} from "../../adapters/openshell/timeouts";
import { GATEWAY_PORT } from "../../core/ports";
import { resolveGatewayName, resolveSandboxGatewayName } from "../../onboard/gateway-binding";
import { isGatewayHealthy } from "../../state/gateway";
import * as registry from "../../state/registry";

/**
 * Docker/VM-driver sandboxes do not expose the legacy cluster container, so
 * verify gateway health through OpenShell metadata instead.
 */
export function probeGatewayMetadataHealth(gatewayName: string): boolean {
  const status = captureOpenshell(["status"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const namedGatewayInfo = captureOpenshell(["gateway", "info", "-g", gatewayName], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  const activeGatewayInfo = captureOpenshell(["gateway", "info"], {
    ignoreError: true,
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  return isGatewayHealthy(
    status.output || "",
    namedGatewayInfo.output || "",
    activeGatewayInfo.output || "",
    gatewayName,
  );
}

export function usesGatewayMetadataProbe(driver: string | null | undefined): boolean {
  return driver === "docker" || driver === "vm";
}

/**
 * Probe whether the OpenShell gateway the named sandbox lives on is running.
 * Resolves the gateway from the sandbox's persisted registry entry — never
 * the process-level `GATEWAY_PORT` — so the probe targets the gateway the
 * sandbox was actually onboarded against.
 */
export function probeGatewayRunning(sandboxName?: string): boolean {
  const entry = sandboxName ? registry.getSandbox(sandboxName) : null;
  const gatewayName = entry ? resolveSandboxGatewayName(entry) : resolveGatewayName(GATEWAY_PORT);
  if (usesGatewayMetadataProbe(entry?.openshellDriver)) {
    return probeGatewayMetadataHealth(gatewayName);
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
export function selectSandboxGatewayIfRegistered(sandboxName: string): boolean {
  const entry = registry.getSandbox(sandboxName);
  if (!entry) return true;
  const target = resolveSandboxGatewayName(entry);
  const result = runOpenshell(["gateway", "select", target], {
    ignoreError: true,
    timeout: OPENSHELL_OPERATION_TIMEOUT_MS,
  });
  return result.status === 0;
}
