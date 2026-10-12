// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { assertNoOpenShellGatewayEndpointOverride } from "../../openshell-gateway-endpoint-guard";
import { isValidName } from "../../sandbox-name-contract";
import type { OpenShellGatewayTarget } from "./gateway-scope";

export function assertCliOpenShellTarget(
  target: OpenShellGatewayTarget,
  environment = process.env,
): void {
  assertCliOpenShellTargetName(target);
  assertNoOpenShellGatewayEndpointOverride(environment);
}

export function assertCliOpenShellTargetName(target: OpenShellGatewayTarget): void {
  if (target.kind === "named" && !isValidName(target.gatewayName)) {
    throw new Error("Invalid OpenShell gateway name");
  }
}

export function assertCliOpenShellSandboxName(sandboxName: string): void {
  if (!isValidName(sandboxName)) throw new Error("Invalid OpenShell sandbox name");
}

export function assertCliOpenShellSessionTarget(
  sandboxName: string,
  target: OpenShellGatewayTarget,
  environment: NodeJS.ProcessEnv,
): void {
  assertNoOpenShellGatewayEndpointOverride(environment);
  if (!isValidName(sandboxName) || (target.kind === "named" && !isValidName(target.gatewayName))) {
    throw new Error("Invalid OpenShell session target");
  }
}
