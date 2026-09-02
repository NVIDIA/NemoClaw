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

const MCP_CURL_HTTP_CODE_MARKER = "NEMOCLAW_MCP_CURL_HTTP_CODE=";

export type McpDnsRebindingAdapter = "mcporter" | "hermes-config" | "deepagents-config";

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
  if (!policy) {
    throw new Error(`${options.label}: managed MCP policy '${options.policyKey}' is absent`);
  }
  const endpoint = policy.endpoints?.[0];
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

/**
 * Accept the two fail-closed shapes OpenShell can expose for a denied HTTPS
 * request: an L7 HTTP 403, or curl's exit 56 for a CONNECT-level proxy 403.
 */
export function isExpectedMcpCurlPolicyDenial(
  result: Pick<ShellProbeResult, "exitCode" | "stderr" | "stdout" | "timedOut">,
): boolean {
  if (result.timedOut) return false;

  const httpCode = result.stdout.match(
    new RegExp(`^${MCP_CURL_HTTP_CODE_MARKER}([0-9]{3})$`, "m"),
  )?.[1];
  if (result.exitCode === 0) return httpCode === "403";

  return (
    result.exitCode === 56 &&
    /curl:\s*\(56\)\s*CONNECT tunnel failed,\s*response 403/i.test(result.stderr)
  );
}

/**
 * Build an MCP request whose curl child retains the selected adapter runtime
 * as an ancestor. OpenShell v0.0.106 attributes policy to /proc/<pid>/exe and
 * ancestors, so this exercises the same unavoidable Node/Python identity used
 * by the corresponding adapter instead of an unrelated curl-only identity.
 *
 * Pinned upstream source contract:
 * NVIDIA/OpenShell@c4b500a7de64d0b66e3ee8098f58d14299092162,
 * crates/openshell-supervisor-network/src/proxy.rs:3070-3096 resolves once,
 * proxy.rs:3121-3160 validates and retains that same address list, and
 * proxy.rs:3193-3251 dials those addresses on the direct path used here.
 */
export function buildMcpDnsRebindingProbeScript(
  adapter: McpDnsRebindingAdapter,
  targetUrl: string,
  credentialKey: string,
): string {
  const fileStem = `/tmp/nemoclaw-mcp-rebinding-${adapter}`;
  const responsePath = `${fileStem}.body`;
  const stdoutPath = `${fileStem}.stdout`;
  const stderrPath = `${fileStem}.stderr`;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const curlArgs = [
    "curl",
    "-sS",
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
    `authorization: Bearer openshell:resolve:env:${credentialKey}`,
    "--data-binary",
    body,
  ];
  const quotedCurl = curlArgs.map(shellQuote).join(" ");
  const runtimeCommand = (() => {
    switch (adapter) {
      case "mcporter": {
        const runner =
          'const { spawnSync } = require("node:child_process"); const result = spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" }); process.exit(result.status ?? 1);';
        return `nemoclaw-start node -e ${shellQuote(runner)} ${quotedCurl}`;
      }
      case "hermes-config": {
        const runner =
          "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
        return `/opt/hermes/.venv/bin/python -c ${shellQuote(runner)} ${quotedCurl}`;
      }
      case "deepagents-config": {
        const runner =
          "import subprocess, sys; raise SystemExit(subprocess.run(sys.argv[1:], check=False).returncode)";
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
    `cat ${shellQuote(stderrPath)} >&2 2>/dev/null || true`,
    'exit "$probe_rc"',
  ].join("\n");
}
