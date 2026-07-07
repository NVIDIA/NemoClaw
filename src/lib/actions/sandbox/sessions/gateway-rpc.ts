// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";
import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { CLI_NAME } from "../../../cli/branding";
import { redactFull } from "../../../security/redact";
import { runSandboxAutoPairApprovalPass } from "../auto-pair-approval";
import { buildTrustedProxyEnvSourceShell } from "../trusted-proxy-env";
import { type GatewayCallPayload, parseGatewayCallPayload } from "./gateway-rpc-envelope";

export { type GatewayCallPayload, parseGatewayCallPayload } from "./gateway-rpc-envelope";

export type GatewayAdminMethod = "sessions.reset" | "sessions.delete";

export interface GatewayCallOptions {
  sandboxName: string;
  method: GatewayAdminMethod;
  params: unknown;
}

export interface GatewayCallResult<T extends GatewayCallPayload = GatewayCallPayload> {
  payload: T;
  rawOutput: string;
  diagnosticOutput: string;
}

const SUPPORTED_GATEWAY_ADMIN_METHODS = new Set<string>(["sessions.reset", "sessions.delete"]);

const RETRYABLE_PAIRING_FAILURE = /scope upgrade pending|pairing required|device is not approved/i;

// Source-boundary note for this SDK-backed admin RPC wrapper:
// - Invalid state: `openclaw gateway call` currently acts like a sandbox-origin
//   CLI client and can create/pending a new device pairing request while
//   `nemoclaw <sandbox> sessions reset/delete` needs a host-admin operation.
// - Source owner: OpenClaw owns the gateway SDK/runtime, pairing model,
//   `sessions.reset/delete` handlers, package layout, and proxy-env contract.
// - Source-fix constraint: this hotfix must stabilize NemoClaw main without
//   merging all OpenShell/OpenClaw dependency-upgrade work, so NemoClaw uses the shipped
//   SDK backend client over loopback instead of mutating sandbox session files
//   or broadening pairing approval behavior.
// - Runtime validation anchor: `sessions-agents-cli-e2e` exercises reset/delete
//   in a real sandbox; `gateway-rpc-call.test.ts` pins the host-side allowlist,
//   backend scope, proxy-env validation/sourcing, retry, parser, and redaction
//   contracts.
// - Removal condition: replace this wrapper when OpenClaw exposes a stable
//   documented host-admin sessions RPC/CLI that does not register a new CLI
//   device and preserves separate stdout/stderr diagnostics.
export const GATEWAY_ADMIN_RPC_SCRIPT = `
import { Buffer } from "node:buffer";
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

function requireCanonicalGatewayPort(value, label) {
  if (!/^[1-9][0-9]{0,4}$/.test(value || "")) {
    throw new Error(\`\${label} must be a canonical TCP port in 1..65535\`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== value) {
    throw new Error(\`\${label} must be a canonical TCP port in 1..65535\`);
  }
  return String(parsed);
}

const method = process.env.NEMOCLAW_GATEWAY_RPC_METHOD;
const SUPPORTED_METHODS = new Set(["sessions.reset", "sessions.delete"]);
if (!method) throw new Error("gateway RPC method argument is required");
if (!SUPPORTED_METHODS.has(method)) {
  throw new Error("unsupported gateway RPC method: " + method);
}

const paramsJson = process.env.NEMOCLAW_GATEWAY_RPC_PARAMS_B64
  ? Buffer.from(process.env.NEMOCLAW_GATEWAY_RPC_PARAMS_B64, "base64").toString("utf8")
  : "{}";
const rawPort = process.env.OPENCLAW_GATEWAY_PORT || process.env.NEMOCLAW_DASHBOARD_PORT || "18789";
const portLabel = process.env.OPENCLAW_GATEWAY_PORT
  ? "OPENCLAW_GATEWAY_PORT"
  : process.env.NEMOCLAW_DASHBOARD_PORT
    ? "NEMOCLAW_DASHBOARD_PORT"
    : "default gateway port";
const port = requireCanonicalGatewayPort(rawPort, portLabel);
const token = process.env.OPENCLAW_GATEWAY_TOKEN;

if (!token) throw new Error("OPENCLAW_GATEWAY_TOKEN is required for NemoClaw sessions admin RPCs");

const openclawBin = realpathSync(process.env.OPENCLAW_BIN || findOnPath("openclaw"));
const requireFromOpenclaw = createRequire(openclawBin);
const gatewayRuntimePath = requireFromOpenclaw.resolve("openclaw/plugin-sdk/gateway-runtime");
const { callGatewayFromCli } = await import(pathToFileURL(gatewayRuntimePath).href);

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

const GATEWAY_ADMIN_RPC_LOADER = `await import("data:text/javascript;base64," + process.argv[1]);`;
const GATEWAY_ADMIN_RPC_SCRIPT_B64 = Buffer.from(GATEWAY_ADMIN_RPC_SCRIPT, "utf8").toString(
  "base64",
);

export function buildGatewayAdminRpcShell(proxyEnvPath = "/tmp/nemoclaw-proxy-env.sh"): string {
  return `
set -e
${buildTrustedProxyEnvSourceShell(proxyEnvPath)}
export NEMOCLAW_GATEWAY_RPC_METHOD="$3"
export NEMOCLAW_GATEWAY_RPC_PARAMS_B64="$4"
exec node --input-type=module --eval "$1" "$2"
`.trim();
}

const GATEWAY_ADMIN_RPC_SHELL = buildGatewayAdminRpcShell();
const GATEWAY_ADMIN_RPC_SHELL_B64 = Buffer.from(GATEWAY_ADMIN_RPC_SHELL, "utf8").toString("base64");
const GATEWAY_ADMIN_RPC_SHELL_WRAPPER = `printf '%s' '${GATEWAY_ADMIN_RPC_SHELL_B64}' | base64 -d | bash -s -- "$1" "$2" "$3" "$4"`;

function isSupportedGatewayAdminMethod(method: string): method is GatewayAdminMethod {
  return SUPPORTED_GATEWAY_ADMIN_METHODS.has(method);
}

function redactedGatewayOutput(output: string): string {
  return redactFull(output);
}

function gatewayDiagnosticOutput(result: {
  output: string;
  stdout?: string;
  stderr?: string;
}): string {
  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  }
  return result.output;
}

function captureGatewayCall(opts: GatewayCallOptions) {
  const params = Buffer.from(JSON.stringify(opts.params), "utf8").toString("base64");
  return captureOpenshell(
    [
      "sandbox",
      "exec",
      "--name",
      opts.sandboxName,
      "--",
      "bash",
      "-lc",
      GATEWAY_ADMIN_RPC_SHELL_WRAPPER,
      "nemoclaw-sessions-admin-rpc",
      GATEWAY_ADMIN_RPC_LOADER,
      GATEWAY_ADMIN_RPC_SCRIPT_B64,
      opts.method,
      params,
    ],
    { ignoreError: true, includeStderr: true, includeStreams: true },
  );
}

export function callOpenclawGateway<T extends GatewayCallPayload = GatewayCallPayload>(
  opts: GatewayCallOptions,
): GatewayCallResult<T> {
  if (!isSupportedGatewayAdminMethod(opts.method)) {
    console.error(
      `  Refusing unsupported OpenClaw gateway admin RPC method '${opts.method}' for sandbox '${opts.sandboxName}'.`,
    );
    process.exit(1);
  }

  // Drain allowlisted CLI/webchat pairing or scope-upgrade requests before
  // host-side gateway RPCs. The RPC itself uses OpenClaw's SDK in backend mode
  // with loopback + the shared gateway token, so sessions reset/delete do not
  // register this admin call as another sandbox-origin CLI device.
  runSandboxAutoPairApprovalPass(opts.sandboxName);

  let result = captureGatewayCall(opts);
  let diagnosticOutput = gatewayDiagnosticOutput(result);
  if (result.status !== 0 && RETRYABLE_PAIRING_FAILURE.test(diagnosticOutput)) {
    runSandboxAutoPairApprovalPass(opts.sandboxName);
    result = captureGatewayCall(opts);
    diagnosticOutput = gatewayDiagnosticOutput(result);
  }

  if (result.status !== 0) {
    console.error(
      `  Failed to reach the OpenClaw gateway in sandbox '${opts.sandboxName}': exit ${result.status}`,
    );
    if (diagnosticOutput.trim())
      console.error(`  ${redactedGatewayOutput(diagnosticOutput.trim())}`);
    console.error(`  Verify the gateway is reachable: \`${CLI_NAME} ${opts.sandboxName} status\`.`);
    process.exit(1);
  }

  const stdout = result.stdout ?? result.output;
  const payload = parseGatewayCallPayload<T>(stdout);
  if (!payload) {
    console.error(`  Could not parse gateway call response for '${opts.method}'.`);
    if (diagnosticOutput.trim())
      console.error(`  ${redactedGatewayOutput(diagnosticOutput.trim())}`);
    process.exit(1);
  }
  return { payload, rawOutput: stdout, diagnosticOutput: redactedGatewayOutput(diagnosticOutput) };
}
