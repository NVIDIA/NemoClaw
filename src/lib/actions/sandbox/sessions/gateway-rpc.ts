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

const GATEWAY_ADMIN_RPC_SCRIPT = `
import { accessSync, constants, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function findOnPath(command) {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(\`Could not find \${command} on PATH\`);
}

const openclawBin = realpathSync(process.env.OPENCLAW_BIN || findOnPath("openclaw"));
const requireFromOpenclaw = createRequire(openclawBin);
const gatewayRuntimePath = requireFromOpenclaw.resolve("openclaw/plugin-sdk/gateway-runtime");
const { callGatewayFromCli } = await import(pathToFileURL(gatewayRuntimePath).href);

const [method, paramsJson = "{}"] = process.argv.slice(1);
const port = process.env.OPENCLAW_GATEWAY_PORT || process.env.NEMOCLAW_DASHBOARD_PORT || "18789";
const token = process.env.OPENCLAW_GATEWAY_TOKEN;

if (!method) throw new Error("gateway RPC method argument is required");
if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required for NemoClaw sessions admin RPCs");

const result = await callGatewayFromCli(
  method,
  {
    url: \`ws://127.0.0.1:\${port}\`,
    token,
    timeout: process.env.NEMOCLAW_GATEWAY_RPC_TIMEOUT_MS || "30000",
    json: true,
  },
  JSON.parse(paramsJson),
  {
    clientName: "gateway-client",
    mode: "backend",
    scopes: ["operator.admin"],
    progress: false,
  },
);

process.stdout.write(JSON.stringify(result));
process.stdout.write("\\n");
`.trim();

function captureGatewayCall(opts: GatewayCallOptions) {
  const params = JSON.stringify(opts.params);
  return captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      opts.sandboxName,
      "--",
      "node",
      "--input-type=module",
      "--eval",
      GATEWAY_ADMIN_RPC_SCRIPT,
      opts.method,
      params,
    ],
    { ignoreError: true },
  );
}

export function callOpenclawGateway<T extends GatewayCallPayload = GatewayCallPayload>(
  opts: GatewayCallOptions,
): GatewayCallResult<T> {
  // Drain allowlisted CLI/webchat pairing or scope-upgrade requests before
  // host-side gateway RPCs. The RPC itself uses OpenClaw's SDK in backend mode
  // with loopback + the shared gateway token, so sessions reset/delete do not
  // register this admin call as another sandbox-origin CLI device.
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
