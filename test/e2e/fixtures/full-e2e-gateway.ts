// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_GATEWAY_PORT, parsePort } from "../../../src/lib/core/ports.ts";
import { resolveGatewayName } from "../../../src/lib/onboard/gateway-binding/identity.ts";
import { loadGatewayManagementDeclaration } from "../../../src/lib/onboard/gateway-management.ts";

/** Both eager cleanup and registered teardown must respect the same gateway owner. */
export async function withOwnedFullE2eGateway(
  gateway: { owned: boolean },
  cleanup: () => unknown,
): Promise<void> {
  if (gateway.owned) await cleanup();
}

/** Resolve the platform declaration before the test can register destructive cleanup. */
export function fullE2eGateway(preinstalled: boolean, env: NodeJS.ProcessEnv = process.env) {
  if (!preinstalled) {
    const port = parsePort("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT, env);
    return { owned: true, env: { OPENSHELL_GATEWAY: resolveGatewayName(port) } };
  }
  const declarationPath =
    env.NEMOCLAW_GATEWAY_MANAGEMENT ?? "/etc/nemoclaw/gateway-management.json";
  const loaded = loadGatewayManagementDeclaration({
    env: { ...env, NEMOCLAW_GATEWAY_MANAGEMENT: declarationPath },
  });
  if (!loaded.ok) throw new Error(`Launchable gateway declaration: ${loaded.reason}`);
  if (loaded.declaration?.mode !== "externally-supervised" || !loaded.declaration.endpoint) {
    throw new Error("The preinstalled Launchable requires an externally supervised gateway");
  }
  const endpoint = new URL(loaded.declaration.endpoint);
  const port = parsePort("NEMOCLAW_GATEWAY_PORT", DEFAULT_GATEWAY_PORT, {
    NEMOCLAW_GATEWAY_PORT: endpoint.port || (endpoint.protocol === "https:" ? "443" : "80"),
  });
  if (parsePort("NEMOCLAW_GATEWAY_PORT", port, env) !== port) {
    throw new Error("Launchable gateway port conflicts with its declaration");
  }
  return {
    owned: false,
    env: {
      OPENSHELL_GATEWAY: resolveGatewayName(port),
      NEMOCLAW_GATEWAY_MANAGEMENT: declarationPath,
      NEMOCLAW_GATEWAY_PORT: String(port),
    },
  };
}
