// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import YAML from "yaml";
import { isPrivateIp } from "../../../nemoclaw/src/blueprint/private-networks.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { parseOpenShellPolicy } from "../../../src/lib/policy/merge";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { discoverHostAddress } from "../fixtures/host-address.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  type DnsRebindingHostsFixture,
  remapDnsRebindingHostname,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
} from "./dns-rebinding-hosts-fixture.ts";

export const RAW_OPENSHELL_REBIND_HOSTNAME = "openshell-rebind.example.test";
export const RAW_OPENSHELL_REBIND_PINNED_IP = "1.1.1.1";
export const RAW_OPENSHELL_REBIND_POLICY_KEY = "raw_openshell_allowed_ips_rebinding";
export const RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER = "NEMOCLAW_RAW_OPENSHELL_REBIND_HTTP_CODE=";

type RawOpenShellPolicy = Record<string, unknown> & {
  network_policies?: Record<string, unknown>;
};

type RawOpenShellEndpoint = Record<string, unknown> & {
  allowed_ips?: unknown;
  host?: unknown;
  port?: unknown;
  protocol?: unknown;
};

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRawPolicy(yaml: string): RawOpenShellPolicy {
  const parsed: unknown = YAML.parse(yaml);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OpenShell base policy must be a YAML mapping");
  }
  return parsed as RawOpenShellPolicy;
}

export function parseRawOpenShellAllowedIpsRebindingEndpoint(
  effectivePolicyOutput: string,
): RawOpenShellEndpoint {
  const policy = parseOpenShellPolicy(effectivePolicyOutput).policy;
  const networkPolicies = policy.network_policies;
  if (!isMapping(networkPolicies)) {
    throw new Error("effective OpenShell policy must contain network_policies");
  }
  const rawPolicy = networkPolicies[RAW_OPENSHELL_REBIND_POLICY_KEY];
  if (!isMapping(rawPolicy) || !Array.isArray(rawPolicy.endpoints)) {
    throw new Error(
      `effective OpenShell policy must contain ${RAW_OPENSHELL_REBIND_POLICY_KEY} endpoints`,
    );
  }
  const endpoint = rawPolicy.endpoints.find(
    (candidate): candidate is RawOpenShellEndpoint =>
      isMapping(candidate) && candidate.host === RAW_OPENSHELL_REBIND_HOSTNAME,
  );
  if (!endpoint) {
    throw new Error(
      `effective OpenShell policy must contain the ${RAW_OPENSHELL_REBIND_HOSTNAME} endpoint`,
    );
  }
  return endpoint;
}

export function buildRawOpenShellAllowedIpsRebindingPolicy(
  basePolicyYaml: string,
  port: number,
): string {
  const policy = parseRawPolicy(basePolicyYaml);
  policy.network_policies = {
    ...(policy.network_policies ?? {}),
    [RAW_OPENSHELL_REBIND_POLICY_KEY]: {
      name: RAW_OPENSHELL_REBIND_POLICY_KEY,
      endpoints: [
        {
          host: RAW_OPENSHELL_REBIND_HOSTNAME,
          port,
          path: "/mcp",
          protocol: "mcp",
          enforcement: "enforce",
          allowed_ips: [RAW_OPENSHELL_REBIND_PINNED_IP],
          mcp: {
            max_body_bytes: 4096,
            strict_tool_names: true,
            allow_all_known_mcp_methods: false,
          },
          rules: [{ allow: { method: "tools/list" } }],
        },
      ],
      // Deliberately remove adapter attribution from this contract. The only
      // reason the raw request may be denied is OpenShell's destination policy.
      binaries: [{ path: "/**" }],
    },
  };
  return YAML.stringify(policy);
}

/**
 * Exercise OpenShell directly with a raw MCP request and require an exact 403.
 * This intentionally bypasses every NemoClaw MCP command and agent adapter.
 *
 * Pinned resolve-validate-connect implementation:
 * https://github.com/NVIDIA/OpenShell/blob/3dee5570a46076a57a3b056f35f35ebc0861ac85/crates/openshell-supervisor-network/src/proxy.rs#L2648-L2674
 * resolves once, #L2699-L2739 plus #L2794-L2803 validate and return that
 * address list, and #L4093-L4100 plus #L4340-L4342 carry that same list through
 * the explicit HTTP-forward connection path used by this probe.
 */
export function buildRawOpenShellAllowedIpsRebindingProbeScript(targetUrl: string): string {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const responsePath = "/tmp/nemoclaw-raw-openshell-rebinding.body";
  const stderrPath = "/tmp/nemoclaw-raw-openshell-rebinding.stderr";
  return [
    "set -u",
    `rm -f ${shellQuote(responsePath)} ${shellQuote(stderrPath)}`,
    `body=${shellQuote(body)}`,
    "set +e",
    `status="$(curl -sS --max-time 30 -o ${shellQuote(responsePath)} -w '%{http_code}' -X POST ${shellQuote(targetUrl)} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data-binary "$body" 2>${shellQuote(stderrPath)})"`,
    "curl_rc=$?",
    "set -e",
    `cat ${shellQuote(responsePath)} 2>/dev/null || true`,
    `cat ${shellQuote(stderrPath)} >&2 2>/dev/null || true`,
    `printf '${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}%s\\n' "$status"`,
    'if [ "$curl_rc" -eq 0 ] && [ "$status" = "403" ]; then exit 0; fi',
    'if [ "$curl_rc" -ne 0 ]; then exit "$curl_rc"; fi',
    "exit 1",
  ].join("\n");
}

async function hostAddressForSandbox(host: HostCliClient): Promise<string> {
  return (await discoverHostAddress(host)).address;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startCountingMcpServer(): Promise<{
  close: () => Promise<void>;
  port: number;
  requestCount: () => number;
}> {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("raw OpenShell rebinding server did not expose a TCP port");
  }
  return {
    close: () => closeServer(server),
    port: address.port,
    requestCount: () => requestCount,
  };
}

export async function assertRawOpenShellAllowedIpsRebindingDenied(options: {
  artifacts: ArtifactSink;
  env?: NodeJS.ProcessEnv;
  host: HostCliClient;
  policySettleMs: number;
  sandbox: SandboxClient;
  sandboxName: string;
  timeoutMs: number;
}): Promise<void> {
  const env = options.env ?? buildAvailabilityProbeEnv();
  const server = await startCountingMcpServer();
  let basePolicyPath: string | undefined;
  let hostsFixture: DnsRebindingHostsFixture | undefined;
  let policyMutationAttempted = false;
  try {
    const reboundAddress = await hostAddressForSandbox(options.host);
    expect(reboundAddress).not.toBe(RAW_OPENSHELL_REBIND_PINNED_IP);
    expect(
      isPrivateIp(reboundAddress),
      `${reboundAddress} must be a private rebinding target`,
    ).toBe(true);

    hostsFixture = await setupDnsRebindingHostsFixture(
      options.host,
      options.sandboxName,
      RAW_OPENSHELL_REBIND_HOSTNAME,
    );
    await remapDnsRebindingHostname(
      options.host,
      options.sandboxName,
      hostsFixture,
      RAW_OPENSHELL_REBIND_PINNED_IP,
      "raw-openshell-rebinding-map-public-pin",
    );

    const basePolicy = await options.sandbox.openshell(
      ["policy", "get", "--base", options.sandboxName],
      {
        artifactName: "raw-openshell-rebinding-policy-get-base",
        env,
        timeoutMs: options.timeoutMs,
      },
    );
    expect(basePolicy.exitCode, resultText(basePolicy)).toBe(0);
    const basePolicyYaml = parseOpenShellPolicy(basePolicy.stdout).yamlBody;
    basePolicyPath = options.artifacts.pathFor(
      "policies/raw-openshell-allowed-ips-rebinding.base.yaml",
    );
    const policyPath = options.artifacts.pathFor(
      "policies/raw-openshell-allowed-ips-rebinding.yaml",
    );
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(basePolicyPath, basePolicyYaml, "utf8");
    fs.writeFileSync(
      policyPath,
      buildRawOpenShellAllowedIpsRebindingPolicy(basePolicyYaml, server.port),
      "utf8",
    );

    policyMutationAttempted = true;
    const applyPolicy = await options.sandbox.openshell(
      ["policy", "set", "--policy", policyPath, "--wait", options.sandboxName],
      {
        artifactName: "raw-openshell-rebinding-policy-set",
        env,
        timeoutMs: options.timeoutMs,
      },
    );
    expect(applyPolicy.exitCode, resultText(applyPolicy)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, options.policySettleMs));

    const effectivePolicy = await options.sandbox.openshell(
      ["policy", "get", "--full", options.sandboxName],
      {
        artifactName: "raw-openshell-rebinding-policy-get-full",
        env,
        timeoutMs: options.timeoutMs,
      },
    );
    expect(effectivePolicy.exitCode, resultText(effectivePolicy)).toBe(0);
    const effectiveEndpoint = parseRawOpenShellAllowedIpsRebindingEndpoint(effectivePolicy.stdout);
    expect(effectiveEndpoint).toMatchObject({
      allowed_ips: [RAW_OPENSHELL_REBIND_PINNED_IP],
      host: RAW_OPENSHELL_REBIND_HOSTNAME,
      port: server.port,
      protocol: "mcp",
    });

    await remapDnsRebindingHostname(
      options.host,
      options.sandboxName,
      hostsFixture,
      reboundAddress,
      "raw-openshell-rebinding-map-private-unpinned",
    );

    const targetUrl = `http://${RAW_OPENSHELL_REBIND_HOSTNAME}:${server.port}/mcp`;
    const denial = await options.sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(buildRawOpenShellAllowedIpsRebindingProbeScript(targetUrl)),
      {
        artifactName: "raw-openshell-rebinding-exact-403",
        env,
        timeoutMs: 60_000,
      },
    );
    expect(denial.exitCode, resultText(denial)).toBe(0);
    expect(denial.stdout).toContain(`${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}403`);
    expect(
      server.requestCount(),
      "raw OpenShell allowed_ips denial must record zero upstream requests",
    ).toBe(0);
  } finally {
    try {
      if (policyMutationAttempted && basePolicyPath) {
        const restorePolicy = await options.sandbox.openshell(
          ["policy", "set", "--policy", basePolicyPath, "--wait", options.sandboxName],
          {
            artifactName: "raw-openshell-rebinding-policy-restore",
            env,
            timeoutMs: options.timeoutMs,
          },
        );
        expect(restorePolicy.exitCode, resultText(restorePolicy)).toBe(0);
        await new Promise((resolve) => setTimeout(resolve, options.policySettleMs));
        const restoredPolicy = await options.sandbox.openshell(
          ["policy", "get", "--base", options.sandboxName],
          {
            artifactName: "raw-openshell-rebinding-policy-verify-restored",
            env,
            timeoutMs: options.timeoutMs,
          },
        );
        expect(restoredPolicy.exitCode, resultText(restoredPolicy)).toBe(0);
        expect(restoredPolicy.stdout).not.toContain(RAW_OPENSHELL_REBIND_POLICY_KEY);
      }
    } finally {
      try {
        if (hostsFixture) {
          await restoreDnsRebindingHostsFixture(options.host, options.sandboxName, hostsFixture);
        }
      } finally {
        await server.close();
      }
    }
  }
}
