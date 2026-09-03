// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_DISPLAY_NAME, CLI_NAME } from "./cli/branding";
import type { GatewayManagementDeclaration } from "./onboard/gateway-management";
import type { OpenShellGatewayLauncher } from "./onboard/compute/plan";

export type { OpenShellGatewayLauncher };

export interface ResolveGatewayLauncherOptions {
  gatewayName?: string;
  plan?: { gatewayLauncher: OpenShellGatewayLauncher };
  /** Validated declaration supplied by tests or an in-process caller. */
  declaration?: GatewayManagementDeclaration | null;
}

/**
 * Resolve the component that owns startup for one gateway. A validated
 * lifecycle declaration is authoritative over the runtime provider: an
 * externally supervised gateway stays owned by its deployment even on a
 * platform whose default provider lets NemoClaw launch gateways. Modules are
 * loaded on demand so credential and inventory commands do not pull in the
 * onboarding graph merely to render a healthy result.
 */
export function resolveGatewayLauncher(
  options: ResolveGatewayLauncherOptions = {},
): OpenShellGatewayLauncher {
  const gatewayManagement =
    require("./onboard/gateway-management") as typeof import("./onboard/gateway-management");
  const declaration = Object.hasOwn(options, "declaration")
    ? (options.declaration ?? null)
    : (() => {
        const loaded = gatewayManagement.loadGatewayManagementDeclaration();
        if (!loaded.ok) {
          throw gatewayManagement.invalidGatewayManagementDeclarationError(loaded.reason);
        }
        return loaded.declaration;
      })();
  if (declaration) {
    const { isExternallySupervised, resolveGatewayOwner } =
      require("./onboard/gateway-ownership") as typeof import("./onboard/gateway-ownership");
    const endpoint = declaration.endpoint ? new URL(declaration.endpoint) : null;
    const gatewayPort = endpoint
      ? Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80))
      : 0;
    const owner = resolveGatewayOwner({
      gatewayName: options.gatewayName ?? "<gateway>",
      gatewayPort,
      declaration,
      hasPackagedService: false,
    });
    if (isExternallySupervised(owner)) return "openshell";
  }

  if (options.plan) return options.plan.gatewayLauncher;
  const { resolveCurrentOpenShellComputePlan } =
    require("./onboard/compute/plan") as typeof import("./onboard/compute/plan");
  return resolveCurrentOpenShellComputePlan().gatewayLauncher;
}

/**
 * Name the component that starts the gateway again. The OpenShell CLI has no
 * command that starts a gateway, so naming one sends the operator to a
 * remediation that cannot run. The resolved launcher and lifecycle authority
 * select the branch. `nemoclaw` means NemoClaw starts the gateway process.
 * `openshell` means the deployment that created the gateway process still owns
 * starting it. Callers that know which gateway failed pass its name so the
 * printed selection command is copyable. Other callers print a template that
 * marks the required gateway argument.
 */
export function gatewayStartGuidance(
  gatewayName?: string,
  launcher: OpenShellGatewayLauncher = resolveGatewayLauncher({ gatewayName }),
): string {
  if (launcher === "nemoclaw") {
    return `Start the gateway again with \`${CLI_NAME} onboard\`.`;
  }
  const subject = gatewayName ? `the '${gatewayName}' gateway` : "the OpenShell gateway";
  const select = gatewayName
    ? `openshell gateway select ${gatewayName}`
    : "openshell gateway select <gateway>";
  return (
    `${CLI_DISPLAY_NAME} does not start ${subject} on this host. ` +
    `Start it with the deployment that owns the gateway process, then run \`${select}\`.`
  );
}
