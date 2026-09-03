// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { cliName } from "../branding";

export interface HostServiceUnreachableResult {
  readonly ok: boolean;
  readonly reason: string;
  readonly port?: number;
  readonly networkName: string;
  readonly subnet?: string;
  readonly gatewayIp?: string;
}

const HOST_INTERNAL_NAME = "host.openshell.internal";

export function formatHostServiceUnreachableMessage(
  result: HostServiceUnreachableResult,
  options: { serviceLabel: string; port?: number },
): string {
  if (result.ok || result.reason !== "tcp_failed") return "";

  const port = options.port ?? result.port;
  const allowCmd =
    result.subnet && result.gatewayIp
      ? `      sudo ufw allow from ${result.subnet} to ${result.gatewayIp} port ${port} proto tcp`
      : result.subnet
        ? `      sudo ufw allow from ${result.subnet} to any port ${port} proto tcp`
        : [
            `      SUBNET=$(docker network inspect ${result.networkName} --format '{{(index .IPAM.Config 0).Subnet}}')`,
            `      sudo ufw allow from "$SUBNET" to any port ${port} proto tcp`,
          ].join("\n");

  return [
    `  ✗ Sandbox containers cannot reach the ${options.serviceLabel} at ${HOST_INTERNAL_NAME}:${port}.`,
    "    A host firewall may be blocking traffic from the OpenShell Docker bridge.",
    "    To allow it:",
    allowCmd,
    `    Then rerun \`${cliName()} onboard\`.`,
  ].join("\n");
}
