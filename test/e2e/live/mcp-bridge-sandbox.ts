// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import YAML from "yaml";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { parseOpenShellPolicy } from "../../../src/lib/adapters/openshell/policy-boundary";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { discoverHostAddress } from "../fixtures/host-address.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";

import {
  buildMcpProviderRewriteAuthorization,
  buildMcpCredentialHandleAuthorizationPattern,
} from "./mcp-provider-rewrite-probe.ts";

const MCP_CURL_HTTP_CODE_MARKER = "NEMOCLAW_MCP_CURL_HTTP_CODE=";

export type McpDnsRebindingAdapter = "openclaw-config" | "hermes-config" | "deepagents-config";

export type CapturedManagedMcpPolicy = {
  networkPolicies: Record<string, McpNetworkPolicy>;
  policy: McpNetworkPolicy;
};

export async function applyMcpHostPolicyEdit(
  sandbox: SandboxClient,
  options: { artifactPrefix: string; sandboxName: string },
): Promise<void> {
  const result = await sandbox.openshell(
    [
      "policy",
      "update",
      options.sandboxName,
      "--add-endpoint",
      "host-edit-mcp.example.com:443:read-only:rest:enforce",
      "--rule-name",
      "mcp_host_edit_e2e",
      "--binary",
      "/usr/bin/curl",
      "--wait",
    ],
    {
      artifactName: `${options.artifactPrefix}-host-policy-edit-before-mcp-add`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  assertExitZero(result, `${options.artifactPrefix} host policy edit before MCP add`);
}

type McpNetworkPolicy = {
  endpoints?: Array<{
    host?: string;
    allowed_ips?: string[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export async function captureManagedMcpPolicy(
  sandbox: SandboxClient,
  options: {
    artifactName: string;
    label: string;
    policyKey: string;
    sandboxName: string;
    url: string;
  },
): Promise<CapturedManagedMcpPolicy> {
  const result = await sandbox.openshell(["policy", "get", "--full", options.sandboxName], {
    artifactName: options.artifactName,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  assertExitZero(result, options.label);
  const document = YAML.parse(parseOpenShellPolicy(resultText(result)).yamlBody) as {
    network_policies?: Record<string, McpNetworkPolicy>;
  };
  const networkPolicies = document.network_policies ?? {};
  const policy = networkPolicies[options.policyKey];
  const endpoint = policy?.endpoints?.[0];
  const expectedHost = new URL(options.url).hostname;
  if (endpoint?.host !== expectedHost) {
    throw new Error(`${options.label}: expected managed MCP host '${expectedHost}'`);
  }
  if (
    !Array.isArray(endpoint.allowed_ips) ||
    endpoint.allowed_ips.length === 0 ||
    endpoint.allowed_ips.some((address) => typeof address !== "string")
  ) {
    throw new Error(`${options.label}: expected at least one managed MCP address pin`);
  }
  return { networkPolicies, policy };
}

export function assertManagedMcpPolicySurvivedRemoval(
  before: McpNetworkPolicy,
  after: CapturedManagedMcpPolicy,
  removedPolicyKey: string,
): void {
  assert.deepStrictEqual(after.policy, before);
  assert.equal(after.networkPolicies[removedPolicyKey], undefined);
}

export function expectExitNonZero(result: ShellProbeResult, label: string, pattern: RegExp): void {
  assert.ok(
    !result.timedOut && result.exitCode !== null && result.exitCode !== 0,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(resultText(result), pattern);
}

export async function hostAddressForSandbox(_host: HostCliClient): Promise<string> {
  return "host.openshell.internal";
}

/** Concrete runner address used only to simulate a post-validation DNS rebind. */
export async function hostPrivateAddressForSandbox(host: HostCliClient): Promise<string> {
  return (await discoverHostAddress(host, "host-private-ip-for-mcp-rebinding")).address;
}

export {
  type DnsRebindingHostsFixture,
  remapDnsRebindingHostname,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
} from "./dns-rebinding-hosts-fixture.ts";

export { isExpectedMcpCurlPolicyDenial } from "../fixtures/curl-policy-denial.ts";

/** After removal, absent credentials cannot hide network denial: only policy denial evidence counts.
 * A null adapter keeps curl alone; otherwise preserve the adapter's runtime ancestry. */
export function buildMcpDnsRebindingProbeScript(
  adapter: McpDnsRebindingAdapter | null,
  targetUrl: string,
  credentialKey: string,
  afterRemoval = false,
): string {
  const fileStem = `/tmp/nemoclaw-mcp-rebinding-${adapter ?? "curl-only"}`;
  const responsePath = `${fileStem}.body`;
  const stdoutPath = `${fileStem}.stdout`;
  const stderrPath = `${fileStem}.stderr`;
  // One initialize proves authenticated reachability without inventing a session.
  // The caller separately verifies full tool discovery before this control.
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "rebinding-probe", version: "1" },
    },
  });
  const curlArgs = [
    "curl",
    "-sS",
    "--verbose",
    "--max-time",
    "30",
    "-o",
    responsePath,
    "-w",
    `${MCP_CURL_HTTP_CODE_MARKER}%{http_code}\n`,
    "-X",
    "POST",
    targetUrl,
    "-H",
    "content-type: application/json",
    "-H",
    adapter === null
      ? `authorization: Bearer openshell:resolve:env:${credentialKey}`
      : "NEMOCLAW_MCP_AUTHORIZATION",
    "--data-binary",
    body,
  ];
  const quotedCurl = curlArgs.map(shellQuote).join(" ");
  const runtimeCommand = (() => {
    switch (adapter) {
      case null:
        return `LC_ALL=C ${quotedCurl}`;
      case "openclaw-config": {
        const runner = `const { spawnSync } = require("node:child_process"); const authorize = ${buildMcpProviderRewriteAuthorization.toString()}; const value = process.env[${JSON.stringify(credentialKey)}]; const header = value === undefined && ${afterRemoval} ? ${JSON.stringify(`Bearer openshell:resolve:env:${credentialKey}`)} : authorize(${JSON.stringify(credentialKey)}, value); if (!header) process.exit(2); const args = process.argv.slice(2).map(value => value === "NEMOCLAW_MCP_AUTHORIZATION" ? "authorization: " + header : value); const result = spawnSync(process.argv[1], args, { stdio: "inherit", env: { ...process.env, LC_ALL: "C" } }); process.exit(result.status ?? 1);`;
        return `nemoclaw-start node -e ${shellQuote(runner)} ${quotedCurl}`;
      }
      case "hermes-config": {
        const runner = `import os, re, subprocess, sys; key = ${JSON.stringify(credentialKey)}; value = os.environ.get(key); header = "Bearer " + (value or ""); (re.fullmatch(${JSON.stringify(buildMcpCredentialHandleAuthorizationPattern(credentialKey))}, header) or (value is None and ${afterRemoval ? "True" : "False"})) or sys.exit(2); header = "Bearer openshell:resolve:env:" + key if value is None else header; args = ["authorization: " + header if value == "NEMOCLAW_MCP_AUTHORIZATION" else value for value in sys.argv[1:]]; raise SystemExit(subprocess.run(args, check=False, env={**os.environ, "LC_ALL": "C"}).returncode)`;
        return `/opt/hermes/.venv/bin/python -c ${shellQuote(runner)} ${quotedCurl}`;
      }
      case "deepagents-config": {
        const runner = `import os, re, subprocess, sys; key = ${JSON.stringify(credentialKey)}; value = os.environ.get(key); header = "Bearer " + (value or ""); (re.fullmatch(${JSON.stringify(buildMcpCredentialHandleAuthorizationPattern(credentialKey))}, header) or (value is None and ${afterRemoval ? "True" : "False"})) or sys.exit(2); header = "Bearer openshell:resolve:env:" + key if value is None else header; args = ["authorization: " + header if value == "NEMOCLAW_MCP_AUTHORIZATION" else value for value in sys.argv[1:]]; raise SystemExit(subprocess.run(args, check=False, env={**os.environ, "LC_ALL": "C"}).returncode)`;
        return `/opt/venv/bin/python3 -c ${shellQuote(runner)} ${quotedCurl}`;
      }
    }
  })();

  return [
    "set -u",
    `rm -f ${shellQuote(responsePath)} ${shellQuote(stdoutPath)} ${shellQuote(stderrPath)}`,
    "set +e",
    `${runtimeCommand} >${shellQuote(stdoutPath)} 2>${shellQuote(stderrPath)}`,
    "probe_rc=$?",
    "set -e",
    `cat ${shellQuote(responsePath)} 2>/dev/null || true`,
    `cat ${shellQuote(stdoutPath)} 2>/dev/null || true`,
    `sed '/^> /d' ${shellQuote(stderrPath)} >&2 2>/dev/null || true`,
    'exit "$probe_rc"',
  ].join("\n");
}
