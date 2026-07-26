// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const OPENSHELL_GATEWAY_ENDPOINT_ENV = "OPENSHELL_GATEWAY_ENDPOINT";

export type OpenShellGatewayEndpointEnvironment = {
  OPENSHELL_GATEWAY_ENDPOINT?: string;
};

export class OpenShellGatewayEndpointOverrideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenShellGatewayEndpointOverrideError";
  }
}

export function assertNoOpenShellGatewayEndpointOverride(
  env: OpenShellGatewayEndpointEnvironment = process.env,
): void {
  const endpoint = env.OPENSHELL_GATEWAY_ENDPOINT;
  if (typeof endpoint !== "string" || !endpoint.trim()) return;

  throw new OpenShellGatewayEndpointOverrideError(
    `${OPENSHELL_GATEWAY_ENDPOINT_ENV} is set, so OpenShell may bypass the gateway recorded for this sandbox. ` +
      `Unset ${OPENSHELL_GATEWAY_ENDPOINT_ENV} and retry.`,
  );
}

export function assertNoExplicitOpenShellGatewayEndpoint(args: readonly string[]): void {
  const separatorIndex = args.indexOf("--");
  const optionEnd = separatorIndex === -1 ? args.length : separatorIndex;
  for (let index = 0; index < optionEnd; index += 1) {
    const arg = args[index];
    if (arg === "--gateway-endpoint" || arg.startsWith("--gateway-endpoint=")) {
      throw new OpenShellGatewayEndpointOverrideError(
        "OpenShell --gateway-endpoint may bypass the gateway recorded for this sandbox. " +
          "Remove --gateway-endpoint and retry.",
      );
    }
  }
}
