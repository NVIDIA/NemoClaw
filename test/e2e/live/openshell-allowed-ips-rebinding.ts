// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import YAML from "yaml";
import { isPrivateIp } from "../../../nemoclaw/src/blueprint/private-networks.ts";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { parseOpenShellPolicy } from "../../../src/lib/adapters/openshell/policy-boundary";
import { setPolicyDocument } from "../../../src/lib/policy";
import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { discoverHostAddress } from "../fixtures/host-address.ts";
import { waitForMcpCurlPolicyDenial } from "../fixtures/curl-policy-denial.ts";
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
  pinnedIp = RAW_OPENSHELL_REBIND_PINNED_IP,
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
          allowed_ips: [pinnedIp],
          mcp: {
            // OpenShell 0.1.3 includes this default in policy readback.
            versions: ["2025-11-25"],
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
 * Exercise OpenShell directly; the caller verifies an HTTP, connect, or audited DNS denial.
 * This intentionally bypasses every NemoClaw MCP command and agent adapter.
 *
 * OpenShell 0.1.3 also reports native TCP destination denial as connect EACCES;
 * preserve curl's errno diagnostic rather than requiring the old proxy's 403.
 */
export function buildRawOpenShellAllowedIpsRebindingProbeScript(
  targetUrl: string,
  outputDirectory = "/tmp",
): string {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const responsePath = path.join(outputDirectory, "nemoclaw-raw-openshell-rebinding.body");
  const stderrPath = path.join(outputDirectory, "nemoclaw-raw-openshell-rebinding.stderr");
  return [
    "set -u",
    `rm -f ${shellQuote(responsePath)} ${shellQuote(stderrPath)}`,
    `body=${shellQuote(body)}`,
    "set +e",
    `status="$(LC_ALL=C curl -sS --verbose --max-time 30 -o ${shellQuote(responsePath)} -w '%{http_code}' -X POST ${shellQuote(targetUrl)} -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-11-25' --data-binary "$body" 2>${shellQuote(stderrPath)})"`,
    "curl_rc=$?",
    "set -e",
    `cat ${shellQuote(responsePath)} 2>/dev/null || true`,
    `cat ${shellQuote(stderrPath)} >&2 2>/dev/null || true`,
    `printf '${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}%s\\n' "$status"`,
    'exit "$curl_rc"',
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
      reboundAddress,
      "raw-openshell-rebinding-map-control-pin",
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
    const controlPolicyApplied = await setPolicyDocument(
      options.sandboxName,
      buildRawOpenShellAllowedIpsRebindingPolicy(basePolicyYaml, server.port, reboundAddress),
      { nonFatal: true, operation: "allow the raw OpenShell rebinding control" },
    );
    await new Promise((resolve) => setTimeout(resolve, options.policySettleMs));
    const targetUrl = `http://${RAW_OPENSHELL_REBIND_HOSTNAME}:${server.port}/mcp`;
    const control = await options.sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(buildRawOpenShellAllowedIpsRebindingProbeScript(targetUrl)),
      { artifactName: "raw-openshell-rebinding-allowed-control", env, timeoutMs: 60_000 },
    );
    const requestsBeforeDenial = server.requestCount();
    await remapDnsRebindingHostname(
      options.host,
      options.sandboxName,
      hostsFixture,
      RAW_OPENSHELL_REBIND_PINNED_IP,
      "raw-openshell-rebinding-map-public-pin",
    );
    expect(
      (await setPolicyDocument(options.sandboxName, fs.readFileSync(policyPath, "utf8"), {
        nonFatal: true,
        operation: "run the raw OpenShell allowed_ips rebinding proof",
      })) &&
        controlPolicyApplied &&
        control.exitCode === 0 &&
        !control.timedOut &&
        control.stdout.includes(`${RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER}200`) &&
        requestsBeforeDenial === 1,
      "raw-openshell-rebinding-policy-set",
    ).toBe(true);
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

    const readDnsAudit = (suffix: string) =>
      options.sandbox.openshell(
        ["logs", options.sandboxName, "-n", "500", "--source", "sandbox", "--since", "2m"],
        { artifactName: `raw-openshell-rebinding-dns-audit-${suffix}`, env, timeoutMs: 30_000 },
      );
    const dnsAuditBefore = await readDnsAudit("before");
    const denial = await options.sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(buildRawOpenShellAllowedIpsRebindingProbeScript(targetUrl)),
      {
        artifactName: "raw-openshell-rebinding-policy-denial",
        env,
        timeoutMs: 60_000,
      },
    );
    const policyDenied = await waitForMcpCurlPolicyDenial(
      denial,
      dnsAuditBefore,
      readDnsAudit,
      RAW_OPENSHELL_REBIND_HOSTNAME,
      RAW_OPENSHELL_REBIND_HTTP_CODE_MARKER,
    );
    expect(policyDenied && hostsFixture.server.answers() > 0, resultText(denial)).toBe(true);
    expect(
      server.requestCount(),
      "raw OpenShell allowed_ips denial must record no additional upstream requests",
    ).toBe(requestsBeforeDenial);
  } finally {
    try {
      if (policyMutationAttempted && basePolicyPath) {
        expect(
          await setPolicyDocument(options.sandboxName, fs.readFileSync(basePolicyPath, "utf8"), {
            nonFatal: true,
            operation: "restore the raw OpenShell allowed_ips rebinding proof policy",
          }),
          "raw-openshell-rebinding-policy-restore",
        ).toBe(true);
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
