// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import os from "node:os";

import { GATEWAY_PORT } from "../core/ports";
import { cliDisplayName, cliName } from "./branding";
import { DOCKER_DESKTOP_WSL_INTEGRATION_HINT } from "./preflight";
import type { SandboxBridgeReachabilityResult } from "./gateway-sandbox-reachability";

const DEFAULT_NETWORK_NAME = "openshell-docker";
const HOST_INTERNAL_NAME = "host.openshell.internal";

export interface FormatSandboxBridgeUnreachableMessageOptions {
  isWsl?: boolean;
}

export function isRunningInWsl(
  env: NodeJS.ProcessEnv = process.env,
  release = os.release(),
): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(release));
}

export function formatSandboxBridgeUnreachableMessage(
  result: SandboxBridgeReachabilityResult,
  port: number = GATEWAY_PORT,
  opts: FormatSandboxBridgeUnreachableMessageOptions = {},
): string {
  if (result.ok) return "";
  const includeWslIntegrationHint = opts.isWsl ?? isRunningInWsl();
  if (result.reason === "probe_unavailable") {
    return [
      "  ⚠ Could not verify sandbox bridge reachability.",
      "    This does not prove the gateway is unreachable; continuing.",
      result.detail ? `    ${result.detail}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  if (result.reason === "veth_unsupported") {
    return [
      "  ✗ Docker could not create the sandbox bridge veth pair.",
      result.detail ? `    ${result.detail}` : undefined,
      "    This matches Jetson kernel/Docker bridge environments where veth creation returns `operation not supported`.",
      `    Update the host kernel/Docker bridge networking support, or run ${cliDisplayName()} on a host whose Docker bridge networking can create veth interfaces.`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  if (result.reason === "probe_timeout") {
    return [
      "  ✗ Docker-driver sandbox bridge reachability probe timed out.",
      result.detail ? `    ${result.detail}` : undefined,
      `    Restart Docker and check for stuck container/network operations before retrying \`${cliName()} onboard\`.`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  if (result.reason === "docker_daemon_unreachable") {
    return [
      "  ✗ Docker daemon is not reachable for the sandbox bridge probe.",
      result.detail ? `    ${result.detail}` : undefined,
      includeWslIntegrationHint ? `    ${DOCKER_DESKTOP_WSL_INTEGRATION_HINT}` : undefined,
      "    Restart the Docker daemon (e.g. `sudo systemctl restart docker`, or restart Docker Desktop/Colima)",
      `    and re-run \`${cliName()} onboard\`.`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  if (result.routeKind === "host_gateway") {
    return [
      `  ✗ Sandbox containers cannot reach the gateway at ${HOST_INTERNAL_NAME}:${port}.`,
      "    The probe used Docker's host-gateway route, matching Docker Desktop/VM-backed Docker.",
      `    Restart Docker and the OpenShell gateway, then re-run \`${cliName()} onboard\`.`,
    ].join("\n");
  }

  const allowCmd =
    result.subnet && result.gatewayIp
      ? `      sudo ufw allow from ${result.subnet} to ${result.gatewayIp} port ${port} proto tcp`
      : result.subnet
        ? `      sudo ufw allow from ${result.subnet} to any port ${port} proto tcp`
        : [
            `      SUBNET=$(docker network inspect ${result.networkName ?? DEFAULT_NETWORK_NAME} --format '{{(index .IPAM.Config 0).Subnet}}')`,
            `      sudo ufw allow from "$SUBNET" to any port ${port} proto tcp`,
          ].join("\n");
  const target = result.gatewayIp
    ? `${HOST_INTERNAL_NAME}:${port} (${result.gatewayIp}:${port})`
    : `${HOST_INTERNAL_NAME}:${port}`;
  return [
    `  ✗ Sandbox containers cannot reach the gateway at ${target}.`,
    "    A host firewall may be blocking traffic from the OpenShell Docker bridge.",
    "    To allow it:",
    allowCmd,
    `    Then re-run \`${cliName()} onboard\`.`,
  ].join("\n");
}
