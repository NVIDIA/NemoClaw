// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_NAME } from "../../../cli/branding";
import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { runSandboxAutoPairApprovalPass } from "../auto-pair-approval";
import { type GatewayCallPayload, parseGatewayCallPayload } from "./gateway-rpc-envelope";

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

const RETRYABLE_PAIRING_FAILURE =
  /scope upgrade pending|pairing required|device is not approved|GatewayClientRequestError/i;

const LOCAL_GATEWAY_ENV_UNSET_ARGS = [
  "env",
  "-u",
  "OPENCLAW_GATEWAY_URL",
  "-u",
  "OPENCLAW_GATEWAY_PORT",
  "-u",
  "OPENCLAW_GATEWAY_TOKEN",
] as const;

function captureGatewayCall(opts: GatewayCallOptions) {
  const params = JSON.stringify(opts.params);
  return captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      opts.sandboxName,
      "--",
      ...LOCAL_GATEWAY_ENV_UNSET_ARGS,
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
}

export function callOpenclawGateway<T extends GatewayCallPayload = GatewayCallPayload>(
  opts: GatewayCallOptions,
): GatewayCallResult<T> {
  // Drain allowlisted CLI/webchat pairing or scope-upgrade requests before
  // host-side gateway RPCs. The RPC itself strips the sandbox-private gateway
  // env so sessions reset/delete use OpenClaw's local gateway discovery instead
  // of registering this admin call as another sandbox-origin device.
  runSandboxAutoPairApprovalPass(opts.sandboxName);

  let result = captureGatewayCall(opts);
  if (result.status !== 0 && RETRYABLE_PAIRING_FAILURE.test(result.output)) {
    runSandboxAutoPairApprovalPass(opts.sandboxName);
    result = captureGatewayCall(opts);
  }

  if (result.status !== 0) {
    console.error(
      `  Failed to reach the OpenClaw gateway in sandbox '${opts.sandboxName}': exit ${result.status}`,
    );
    if (result.output.trim()) console.error(`  ${result.output.trim()}`);
    console.error(`  Verify the gateway is reachable: \`${CLI_NAME} ${opts.sandboxName} status\`.`);
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
