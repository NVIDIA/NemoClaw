// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createCliOpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle-cli";
import type { OpenShellGatewayLifecycle } from "../../adapters/openshell/gateway-lifecycle";
import { captureResolvedOpenshell, getOpenshellBinary } from "../../adapters/openshell/runtime";
import { getKnownSandboxTargetGatewayName } from "./gateway-target";

export type GatewaySelectResult =
  | { outcome: "selected"; gatewayName: string }
  | { outcome: "failed"; gatewayName: string }
  | { outcome: "unregistered"; gatewayName: null };

export async function selectNamedGateway(
  gatewayName: string,
  lifecycle?: Pick<OpenShellGatewayLifecycle, "selectGateway">,
) {
  if (!lifecycle) getOpenshellBinary();
  const selectedLifecycle =
    lifecycle ?? createCliOpenShellGatewayLifecycle(captureResolvedOpenshell);
  return selectedLifecycle.selectGateway({ target: { kind: "named", gatewayName } });
}

export async function selectSandboxOwningGateway(
  sandboxName: string,
  lifecycle?: Pick<OpenShellGatewayLifecycle, "selectGateway">,
): Promise<GatewaySelectResult> {
  const gatewayName = getKnownSandboxTargetGatewayName(sandboxName);
  if (!gatewayName) return { outcome: "unregistered", gatewayName: null };
  const result = await selectNamedGateway(gatewayName, lifecycle);
  return { outcome: result.ok ? "selected" : "failed", gatewayName };
}
