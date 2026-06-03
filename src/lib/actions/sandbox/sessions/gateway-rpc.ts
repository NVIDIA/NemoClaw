// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell } from "../../../adapters/openshell/runtime";
import {
  type GatewayCallPayload,
  parseGatewayCallPayload,
} from "./gateway-rpc-envelope";

export { type GatewayCallPayload, parseGatewayCallPayload } from "./gateway-rpc-envelope";

export interface GatewayCallOptions {
  sandboxName: string;
  method: string;
  params: unknown;
}

export interface GatewayCallResult<T extends GatewayCallPayload = GatewayCallPayload> {
  payload: T;
  rawOutput: string;
}

export function callOpenclawGateway<T extends GatewayCallPayload = GatewayCallPayload>(
  opts: GatewayCallOptions,
): GatewayCallResult<T> {
  const params = JSON.stringify(opts.params);
  const result = captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      opts.sandboxName,
      "--",
      "openclaw",
      "gateway",
      "call",
      opts.method,
      "--params",
      params,
      "--json",
    ],
    { ignoreError: true },
  );

  if (result.status !== 0) {
    console.error(
      `  Failed to reach the OpenClaw gateway in sandbox '${opts.sandboxName}': exit ${result.status}`,
    );
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    console.error(
      `  Verify the gateway is reachable: \`${CLI_NAME} ${opts.sandboxName} status\`.`,
    );
    process.exit(1);
  }

  const payload = parseGatewayCallPayload<T>(result.output);
  if (!payload) {
    console.error(`  Could not parse gateway call response for '${opts.method}'.`);
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    process.exit(1);
  }
  return { payload, rawOutput: result.output };
}
