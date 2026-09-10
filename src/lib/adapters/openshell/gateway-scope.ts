// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assertNoExplicitOpenShellGatewayEndpoint,
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
  type OpenShellGatewayEndpointEnvironment,
} from "../../openshell-gateway-endpoint-guard";

export {
  assertNoOpenShellGatewayEndpointOverride,
  OpenShellGatewayEndpointOverrideError,
  type OpenShellGatewayEndpointEnvironment,
};

function inferredGatewayFlagIndex(args: readonly string[]): number | null {
  if (args[0] === "inference" || args[0] === "provider") return 2;
  if (args[0] !== "sandbox" || typeof args[1] !== "string") return null;
  return args[1] === "provider" ? 3 : 2;
}

/** Bind one OpenShell command to one named gateway without accepting a competing target. */
export function scopeGatewayOpenshellArgs(
  args: readonly string[],
  gatewayName: string,
  explicitGatewayFlagIndex?: number,
): string[] {
  if (!gatewayName) throw new Error("OpenShell gateway name is required.");
  assertNoExplicitOpenShellGatewayEndpoint(args);
  if (args[0] === "gateway" && args[1] === "select") {
    throw new Error("Gateway-scoped OpenShell operations must not change the selected gateway.");
  }

  const gatewayFlagIndex = explicitGatewayFlagIndex ?? inferredGatewayFlagIndex(args);
  if (gatewayFlagIndex === null) return [...args];

  const separatorIndex = args.indexOf("--");
  const optionEnd = separatorIndex === -1 ? args.length : separatorIndex;
  const gatewayTargets = args.slice(0, optionEnd).flatMap((value, index) => {
    if (index < gatewayFlagIndex) return [];
    if (value === "-g" || value === "--gateway") return [args[index + 1] ?? ""];
    return value.startsWith("--gateway=") ? [value.slice("--gateway=".length)] : [];
  });
  if (gatewayTargets.length > 1) {
    throw new Error("OpenShell command contains multiple gateway targets.");
  }
  const existingGatewayName = gatewayTargets[0];
  if (existingGatewayName !== undefined) {
    if (existingGatewayName !== gatewayName) {
      throw new Error(
        `OpenShell command targets gateway '${existingGatewayName}' instead of '${gatewayName}'.`,
      );
    }
    return [...args];
  }
  return [...args.slice(0, gatewayFlagIndex), "-g", gatewayName, ...args.slice(gatewayFlagIndex)];
}
