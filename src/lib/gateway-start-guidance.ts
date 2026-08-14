// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_DISPLAY_NAME, CLI_NAME } from "./cli/branding";
import type { OpenShellGatewayLauncher } from "./onboard/compute/plan";

export type { OpenShellGatewayLauncher };

/**
 * Read the launcher the current runtime provider records. The provider registry
 * is loaded on demand so guidance stays importable from the credential and
 * inventory command paths without pulling the onboarding graph into them.
 */
export function resolveGatewayLauncher(plan?: {
  gatewayLauncher: OpenShellGatewayLauncher;
}): OpenShellGatewayLauncher {
  if (plan) return plan.gatewayLauncher;
  const { resolveCurrentOpenShellComputePlan } =
    require("./onboard/compute/plan") as typeof import("./onboard/compute/plan");
  return resolveCurrentOpenShellComputePlan().gatewayLauncher;
}

/**
 * Name the component that starts the gateway again. The OpenShell CLI has no
 * command that starts a gateway, so naming one sends the operator to a
 * remediation that cannot run. The launcher the runtime provider records
 * selects the branch. `nemoclaw` means NemoClaw starts the gateway process.
 * `openshell` means the deployment that created the gateway process still owns
 * starting it. Callers that know which gateway failed pass its name so the
 * printed selection command is copyable.
 */
export function gatewayStartGuidance(
  gatewayName?: string,
  launcher: OpenShellGatewayLauncher = resolveGatewayLauncher(),
): string {
  if (launcher === "nemoclaw") {
    return `Start the gateway again with \`${CLI_NAME} onboard\`.`;
  }
  const subject = gatewayName ? `the '${gatewayName}' gateway` : "the OpenShell gateway";
  const select = gatewayName
    ? `openshell gateway select ${gatewayName}`
    : "openshell gateway select";
  return (
    `${CLI_DISPLAY_NAME} does not start ${subject} on this host. ` +
    `Start it with the deployment that owns the gateway process, then run \`${select}\`.`
  );
}
