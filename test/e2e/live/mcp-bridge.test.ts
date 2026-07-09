// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
} from "../../../src/lib/actions/sandbox/mcp-bridge-adapter-status";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import { parseOpenShellPolicy } from "../../../src/lib/policy/merge";
import type { McpBridgeEntry } from "../../../src/lib/state/registry";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  assertHermesConfig,
  assertHermesInspectionRejectsUnmanagedFields,
  assertHermesRemovalSurvivesGatewayRestart,
} from "./mcp-bridge-hermes-lifecycle.ts";
import {
  buildMcpDnsRebindingProbeScript,
  hostAddressForSandbox,
  hostPrivateAddressForSandbox,
  isExpectedMcpCurlPolicyDenial,
  type McpDnsRebindingAdapter,
  remapDnsRebindingHostname,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
} from "./mcp-bridge-sandbox.ts";
import {
  startCompatibleMock,
  startFakeMcpHttpsServer,
  startPublicMcpHttpsTunnel,
} from "./mcp-bridge-servers.ts";
import { assertRawOpenShellAllowedIpsRebindingDenied } from "./openshell-allowed-ips-rebinding.ts";

const OPENCLAW_SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-mcp-bridge";
const HERMES_SANDBOX_NAME = process.env.NEMOCLAW_MCP_HERMES_SANDBOX_NAME ?? "e2e-mcp-hermes";
const DEEPAGENTS_SANDBOX_NAME = process.env.NEMOCLAW_MCP_DEEPAGENTS_SANDBOX_NAME ?? "e2e-mcp-dcode";
const SERVER_NAME = "fake";
const SERVER_POLICY_KEY = "mcp_bridge_fake";
const CONCURRENT_SERVER_NAME = "concurrent";
const REBIND_SERVER_NAME = "rebind";
const REBIND_POLICY_KEY = "mcp_bridge_rebind";
const REBIND_HOSTNAME = "mcp-rebind.example.test";
const REBIND_PUBLIC_IP = "1.1.1.1";
const REBIND_CREDENTIAL_KEY = "REBIND_MCP_SECRET";
const HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.host;
const ROTATED_HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost;
const REBIND_HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.rebindHost;
const COMPATIBLE_KEY = MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint;
const COMPATIBLE_MODEL = "mock/mcp-bridge";
const TOOL_CHALLENGE = "nemoclaw-authenticated-mcp-proof";
const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
const liveAgentMatrixTest = process.env.NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX === "1" ? test : test.skip;

type McpAgent = "openclaw" | "hermes" | "langchain-deepagents-code";
type McpAdapter = "mcporter" | "hermes-config" | "deepagents-config";
const MCP_MUTATION_TIMEOUT_MS: Record<McpAdapter, number> = {
  "deepagents-config": 3 * 60_000,
  "hermes-config": 12 * 60_000,
  mcporter: 3 * 60_000,
};

function expectExitNonZero(result: ShellProbeResult, label: string, pattern: RegExp): void {
  expect(
    result.exitCode,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).not.toBe(0);
  expect(resultText(result)).toMatch(pattern);
}

function parseCurrentPolicy(raw: string): string {
  return parseOpenShellPolicy(raw).yamlBody;
}

async function bestEffortRemoveBridge(
  host: HostCliClient,
  sandboxName: string,
  server: string,
  adapter: McpAdapter,
): Promise<void> {
  await host.nemoclaw([sandboxName, "mcp", "remove", server, "--force"], {
    artifactName: `cleanup-mcp-remove-${server}`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: MCP_MUTATION_TIMEOUT_MS[adapter],
  });
}

async function cleanupSandbox(host: HostCliClient, sandboxName: string): Promise<void> {
  await host.bestEffortCleanupSandbox(sandboxName, {
    artifactName: "cleanup-destroy-sandbox",
    timeoutMs: 15 * 60_000,
  });
}

async function onboardAgent(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  endpointUrl: string,
  options: { agent: McpAgent; sandboxName: string; artifactName: string },
): Promise<void> {
  cleanup.add(`destroy MCP bridge ${options.agent} sandbox`, () =>
    cleanupSandbox(host, options.sandboxName),
  );
  await host.cleanupSandbox(options.sandboxName, {
    artifactName: "precleanup-destroy-sandbox",
    timeoutMs: 15 * 60_000,
  });
  const result = await host.nemoclaw(
    ["onboard", "--non-interactive", "--yes", "--yes-i-accept-third-party-software"],
    {
      artifactName: options.artifactName,
      env: {
        ...buildAvailabilityProbeEnv(),
        COMPATIBLE_API_KEY: COMPATIBLE_KEY,
        NVIDIA_INFERENCE_API_KEY: COMPATIBLE_KEY,
        NEMOCLAW_AGENT: options.agent,
        NEMOCLAW_ENDPOINT_URL: endpointUrl,
        NEMOCLAW_MODEL: COMPATIBLE_MODEL,
        NEMOCLAW_COMPAT_MODEL: COMPATIBLE_MODEL,
        NEMOCLAW_PREFERRED_API: "openai-completions",
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_SANDBOX_NAME: options.sandboxName,
        NEMOCLAW_RECREATE_SANDBOX: "1",
      },
      redactionValues: [COMPATIBLE_KEY],
      timeoutMs: 20 * 60_000,
    },
  );
  expectExitZero(result, `onboard ${options.agent} sandbox for MCP bridge`);
}

async function assertSecretAbsentFromSandbox(
  sandbox: SandboxClient,
  sandboxName: string,
  paths: string[],
  secrets: string[] = [HOST_SECRET],
  artifactName = "assert-secret-absent-from-sandbox",
): Promise<void> {
  const script = [
    "set -eu",
    ...secrets.map(
      (secret) => `! grep -R ${JSON.stringify(secret)} ${paths.join(" ")} 2>/dev/null`,
    ),
  ].join("\n");
  const result = await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName,
    env: buildAvailabilityProbeEnv(),
    redactionValues: [...secrets, Buffer.from(script, "utf8").toString("base64")],
    timeoutMs: 60_000,
  });
  expectExitZero(result, "host MCP secret must not appear in sandbox files");
}

async function assertAdapterDnsRebindingDenied(
  host: HostCliClient,
  sandbox: SandboxClient,
  cleanup: CleanupRegistry,
  options: {
    adapter: McpDnsRebindingAdapter;
    artifactPrefix: string;
    sandboxName: string;
    secretPaths: string[];
  },
): Promise<void> {
  const rebindMcp = await startFakeMcpHttpsServer({
    secret: REBIND_HOST_SECRET,
  });
  cleanup.add(`stop ${options.artifactPrefix} DNS rebinding fake MCP HTTPS server`, () =>
    rebindMcp.close(),
  );
  cleanup.add(`remove ${options.artifactPrefix} DNS rebinding MCP bridge`, () =>
    bestEffortRemoveBridge(host, options.sandboxName, REBIND_SERVER_NAME, options.adapter),
  );
  const rebindMcpUrl = `https://${REBIND_HOSTNAME}:${rebindMcp.port}/mcp`;
  const hostsFixture = await setupDnsRebindingHostsFixture(
    host,
    options.sandboxName,
    REBIND_HOSTNAME,
  );
  cleanup.add(`restore ${options.artifactPrefix} DNS rebinding hosts fixture`, () =>
    restoreDnsRebindingHostsFixture(host, options.sandboxName, hostsFixture),
  );

  await remapDnsRebindingHostname(
    host,
    options.sandboxName,
    hostsFixture,
    REBIND_PUBLIC_IP,
    `${options.artifactPrefix}-mcp-dns-rebinding-map-public-before-add`,
  );
  const add = await host.nemoclaw(
    [
      options.sandboxName,
      "mcp",
      "add",
      REBIND_SERVER_NAME,
      "--url",
      rebindMcpUrl,
      "--env",
      REBIND_CREDENTIAL_KEY,
    ],
    {
      artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-add-with-public-resolution`,
      env: {
        ...buildAvailabilityProbeEnv(),
        [REBIND_CREDENTIAL_KEY]: REBIND_HOST_SECRET,
      },
      redactionValues: [REBIND_HOST_SECRET],
      timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.adapter],
    },
  );
  expectExitZero(
    add,
    `${options.artifactPrefix} registers MCP route while its dedicated hostname resolves publicly`,
  );

  const status = await host.nemoclaw(
    [options.sandboxName, "mcp", "status", REBIND_SERVER_NAME, "--json"],
    {
      artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-status-after-add`,
      env: {
        ...buildAvailabilityProbeEnv(),
        [REBIND_CREDENTIAL_KEY]: REBIND_HOST_SECRET,
      },
      redactionValues: [REBIND_HOST_SECRET],
      timeoutMs: 60_000,
    },
  );
  expectExitZero(status, `${options.artifactPrefix} inspects DNS rebinding route after add`);
  expect(JSON.parse(status.stdout)).toMatchObject({
    support: { supported: true, adapter: options.adapter },
    server: REBIND_SERVER_NAME,
    url: rebindMcpUrl,
    env: { names: [REBIND_CREDENTIAL_KEY], ready: true, missing: [] },
    provider: { attached: true, credentialReady: true },
    policy: { gatewayPresent: true },
    adapter: { registered: true },
  });

  const policy = await sandbox.openshell(["policy", "get", "--full", options.sandboxName], {
    artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-policy-pinned-public-ip`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(policy, `${options.artifactPrefix} inspects add-time DNS pin`);
  const policyJson = YAML.parse(parseCurrentPolicy(resultText(policy))) as {
    network_policies?: Record<
      string,
      { endpoints?: Array<{ host?: string; allowed_ips?: string[] }> }
    >;
  };
  expect(policyJson.network_policies?.[REBIND_POLICY_KEY]?.endpoints?.[0]).toMatchObject({
    host: REBIND_HOSTNAME,
    allowed_ips: [REBIND_PUBLIC_IP],
  });
  await assertSecretAbsentFromSandbox(
    sandbox,
    options.sandboxName,
    options.secretPaths,
    [REBIND_HOST_SECRET],
    `${options.artifactPrefix}-dns-rebinding-secret-absent-from-sandbox`,
  );

  // If OpenShell resolved a second time after validating allowed_ips, this
  // reachable runner address would receive the request. The pinned v0.0.72
  // implementation instead returns the one resolved-and-validated SocketAddr
  // list directly to connect; see the exact proxy.rs citation in the helper.
  const reboundAddress = await hostPrivateAddressForSandbox(host);
  expect(reboundAddress).not.toBe(REBIND_PUBLIC_IP);
  await remapDnsRebindingHostname(
    host,
    options.sandboxName,
    hostsFixture,
    reboundAddress,
    `${options.artifactPrefix}-mcp-dns-rebinding-map-private-unpinned-after-add`,
  );
  const denial = await sandbox.execShell(
    options.sandboxName,
    trustedSandboxShellScript(
      buildMcpDnsRebindingProbeScript(options.adapter, rebindMcpUrl, REBIND_CREDENTIAL_KEY),
    ),
    {
      artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-adapter-denied`,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [REBIND_HOST_SECRET],
      timeoutMs: 90_000,
    },
  );
  expect(
    isExpectedMcpCurlPolicyDenial(denial),
    `${options.artifactPrefix} adapter identity must receive an OpenShell policy denial after rebinding\nstdout:\n${denial.stdout}\nstderr:\n${denial.stderr}`,
  ).toBe(true);
  expect(
    rebindMcp.requests,
    `${options.artifactPrefix} rebound request must not reach the upstream MCP server`,
  ).toHaveLength(0);

  // Restore while the current sandbox container is stable. Removing the MCP
  // route reloads policy and can restart the container first; the registered
  // cleanup remains an idempotent fallback.
  await restoreDnsRebindingHostsFixture(host, options.sandboxName, hostsFixture);
  const remove = await host.nemoclaw([options.sandboxName, "mcp", "remove", REBIND_SERVER_NAME], {
    artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-remove`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.adapter],
  });
  expectExitZero(remove, `${options.artifactPrefix} removes DNS rebinding route after proof`);
}

async function addBridgeAndReadStatus(
  host: HostCliClient,
  options: {
    sandboxName: string;
    mcpUrl: string;
    expectedAdapter: McpAdapter;
    artifactPrefix: string;
  },
): Promise<string> {
  const add = await host.nemoclaw(
    [
      options.sandboxName,
      "mcp",
      "add",
      SERVER_NAME,
      "--url",
      options.mcpUrl,
      "--env",
      "FAKE_MCP_SECRET",
    ],
    {
      artifactName: `${options.artifactPrefix}-mcp-add-fake-server`,
      env: {
        ...buildAvailabilityProbeEnv(),
        FAKE_MCP_SECRET: HOST_SECRET,
      },
      redactionValues: [HOST_SECRET],
      timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.expectedAdapter],
    },
  );
  expectExitZero(add, `${options.artifactPrefix} mcp add fake server`);

  const status = await host.nemoclaw(
    [options.sandboxName, "mcp", "status", SERVER_NAME, "--json"],
    {
      artifactName: `${options.artifactPrefix}-mcp-status-json`,
      env: {
        ...buildAvailabilityProbeEnv(),
        FAKE_MCP_SECRET: HOST_SECRET,
      },
      redactionValues: [HOST_SECRET],
      timeoutMs: 60_000,
    },
  );
  expectExitZero(status, `${options.artifactPrefix} mcp status --json`);
  const statusJson = JSON.parse(status.stdout) as {
    support: { supported: boolean; adapter: string };
    server: string;
    url: string;
    warnings: string[];
    env: { names: string[]; ready: boolean; missing: string[] };
    provider: {
      name: string;
      gatewayPresent: boolean | null;
      attached: boolean | null;
    };
    policy: { gatewayPresent: boolean | null };
    adapter: { registered: boolean | null };
  };
  expect(statusJson.support).toMatchObject({
    supported: true,
    adapter: options.expectedAdapter,
  });
  expect(statusJson).toMatchObject({
    server: SERVER_NAME,
    url: options.mcpUrl,
    env: { names: ["FAKE_MCP_SECRET"], ready: true, missing: [] },
    provider: { gatewayPresent: true, attached: true },
    policy: { gatewayPresent: true },
    adapter: { registered: true },
  });
  expect(statusJson.warnings).toEqual([
    expect.stringMatching(/provider at sandbox scope.*endpoint-exclusive credential binding/i),
  ]);
  expect(status.stdout).not.toContain(HOST_SECRET);
  expect(statusJson.provider.name).toMatch(
    new RegExp(`^${options.sandboxName}-mcp-${SERVER_NAME}-[a-f0-9]{16}$`),
  );
  return statusJson.provider.name;
}

async function assertConcurrentAddSerialized(
  host: HostCliClient,
  cleanup: CleanupRegistry,
  options: {
    sandboxName: string;
    mcpUrl: string;
    expectedAdapter: McpAdapter;
    artifactPrefix: string;
  },
): Promise<void> {
  cleanup.add(`remove ${options.artifactPrefix} concurrent MCP bridge`, () =>
    bestEffortRemoveBridge(
      host,
      options.sandboxName,
      CONCURRENT_SERVER_NAME,
      options.expectedAdapter,
    ),
  );
  const args = [
    options.sandboxName,
    "mcp",
    "add",
    CONCURRENT_SERVER_NAME,
    "--url",
    options.mcpUrl,
    "--env",
    "FAKE_MCP_SECRET",
  ];
  const env = {
    ...buildAvailabilityProbeEnv(),
    FAKE_MCP_SECRET: HOST_SECRET,
  };
  const attempts = await Promise.all(
    ["first", "second"].map((attempt) =>
      host.nemoclaw(args, {
        artifactName: `${options.artifactPrefix}-mcp-concurrent-add-${attempt}`,
        env,
        redactionValues: [HOST_SECRET],
        // Hermes may need one host-authenticated managed restart (210s), a
        // fresh helper-readiness window (90s), and its acknowledged config
        // reload (300s). Keep both concurrent clients alive through that
        // bounded recovery; the loser then acquires the lifecycle lock and
        // rejects the committed duplicate.
        timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.expectedAdapter],
      }),
    ),
  );
  const successful = attempts.filter((result) => result.exitCode === 0);
  const rejected = attempts.filter((result) => result.exitCode !== 0);
  expect(successful).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expectExitNonZero(
    rejected[0]!,
    `${options.artifactPrefix} concurrent MCP add rejects the serialized duplicate`,
    /already exists/,
  );
  const status = await host.nemoclaw(
    [options.sandboxName, "mcp", "status", CONCURRENT_SERVER_NAME, "--json"],
    {
      artifactName: `${options.artifactPrefix}-mcp-concurrent-add-coherent-status`,
      env,
      redactionValues: [HOST_SECRET],
      timeoutMs: 60_000,
    },
  );
  expectExitZero(status, `${options.artifactPrefix} concurrent add leaves one coherent bridge`);
  expect(JSON.parse(status.stdout)).toMatchObject({
    server: CONCURRENT_SERVER_NAME,
    url: options.mcpUrl,
    support: { adapter: options.expectedAdapter },
    env: { names: ["FAKE_MCP_SECRET"], ready: true, missing: [] },
    provider: {
      registryPresent: true,
      gatewayPresent: true,
      attached: true,
      credentialReady: true,
    },
    policy: { registryPresent: true, gatewayPresent: true },
    adapter: { registered: true },
  });
  const remove = await host.nemoclaw(
    [options.sandboxName, "mcp", "remove", CONCURRENT_SERVER_NAME],
    {
      artifactName: `${options.artifactPrefix}-mcp-concurrent-add-remove`,
      env: buildAvailabilityProbeEnv(),
      // Adapter removal performs the same acknowledged config reload as add.
      timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.expectedAdapter],
    },
  );
  expectExitZero(remove, `${options.artifactPrefix} removes concurrent MCP bridge`);
  const list = await host.nemoclaw([options.sandboxName, "mcp", "list", "--json"], {
    artifactName: `${options.artifactPrefix}-mcp-concurrent-add-list-after-remove`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(list, `${options.artifactPrefix} lists after concurrent bridge removal`);
  expect(JSON.parse(list.stdout).bridges).toEqual([]);
}

async function expectMcpCliFailure(
  host: HostCliClient,
  sandboxName: string,
  args: string[],
  pattern: RegExp,
  artifactName: string,
  env: NodeJS.ProcessEnv = buildAvailabilityProbeEnv(),
): Promise<void> {
  const result = await host.nemoclaw([sandboxName, "mcp", ...args], {
    artifactName,
    env,
    redactionValues: [HOST_SECRET],
    timeoutMs: 60_000,
  });
  expectExitNonZero(result, artifactName, pattern);
}

async function assertBridgeInfrastructure(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: {
    sandboxName: string;
    artifactPrefix: string;
    providerName: string;
    mcpUrl: string;
  },
): Promise<void> {
  const policy = await sandbox.openshell(["policy", "get", "--full", options.sandboxName], {
    artifactName: `${options.artifactPrefix}-openshell-policy-get-mcp`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(policy, `${options.artifactPrefix} openshell policy get --full`);
  expect(resultText(policy)).toContain(SERVER_POLICY_KEY);
  expect(resultText(policy)).toContain("protocol: mcp");
  expect(resultText(policy)).not.toContain("tls: require");
  expect(resultText(policy)).not.toContain("credential_keys");
  expect(resultText(policy)).not.toContain("FAKE_MCP_SECRET");
  expect(resultText(policy)).toContain("strict_tool_names");
  expect(resultText(policy)).toContain("method: tools/list");
  expect(resultText(policy)).toContain("method: tools/call");
  expect(resultText(policy)).toContain(new URL(options.mcpUrl).hostname);
  const provider = await host.command("openshell", ["provider", "get", options.providerName], {
    artifactName: `${options.artifactPrefix}-openshell-provider-get-mcp`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(provider, `${options.artifactPrefix} openshell provider get mcp provider`);
  expect(resultText(provider)).toContain("FAKE_MCP_SECRET");
  expect(resultText(provider)).not.toContain(HOST_SECRET);
}

async function removeBridgeAndAssertEmpty(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: {
    agent: McpAgent;
    adapter: McpAdapter;
    sandboxName: string;
    artifactPrefix: string;
    providerName: string;
    mcpUrl: string;
  },
): Promise<void> {
  const remove = await host.nemoclaw([options.sandboxName, "mcp", "remove", SERVER_NAME], {
    artifactName: `${options.artifactPrefix}-mcp-remove-fake-server`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.adapter],
  });
  expectExitZero(remove, `${options.artifactPrefix} mcp remove fake server`);
  const list = await host.nemoclaw([options.sandboxName, "mcp", "list", "--json"], {
    artifactName: `${options.artifactPrefix}-mcp-list-after-remove`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(list, `${options.artifactPrefix} mcp list after remove`);
  expect(JSON.parse(list.stdout).bridges).toEqual([]);
  const provider = await host.command("openshell", ["provider", "get", options.providerName], {
    artifactName: `${options.artifactPrefix}-provider-absent-after-mcp-remove`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitNonZero(
    provider,
    `${options.artifactPrefix} provider absent after remove`,
    /not found/i,
  );
  const attachments = await host.command(
    "openshell",
    ["sandbox", "provider", "list", options.sandboxName],
    {
      artifactName: `${options.artifactPrefix}-provider-detached-after-mcp-remove`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(attachments, `${options.artifactPrefix} provider list after remove`);
  expect(resultText(attachments)).not.toContain(options.providerName);
  const policy = await sandbox.openshell(["policy", "get", "--full", options.sandboxName], {
    artifactName: `${options.artifactPrefix}-policy-absent-after-mcp-remove`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(policy, `${options.artifactPrefix} policy after remove`);
  expect(resultText(policy)).not.toMatch(/mcp[-_]bridge[-_]fake/);
  const entry: McpBridgeEntry = {
    server: SERVER_NAME,
    agent: options.agent,
    adapter: options.adapter,
    url: options.mcpUrl,
    env: ["FAKE_MCP_SECRET"],
    providerName: options.providerName,
    policyName: "mcp-bridge-fake",
    addedAt: "2026-06-01T00:00:00.000Z",
  };
  const adapterStatusCommand =
    options.adapter === "mcporter"
      ? buildOpenClawMcporterInspectCommand(entry, true)
      : options.adapter === "hermes-config"
        ? buildHermesMcpStatusCommand(entry)
        : buildDeepAgentsMcpStatusCommand(entry);
  const adapterStatus = await sandbox.execShell(
    options.sandboxName,
    trustedSandboxShellScript(["set -eu", adapterStatusCommand].join("\n")),
    {
      artifactName: `${options.artifactPrefix}-adapter-absent-after-mcp-remove`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(adapterStatus, `${options.artifactPrefix} adapter status after remove`);
  expect(resultText(adapterStatus)).toMatch(/(?:^|\n)absent(?:\n|$)/);
}
async function assertAdapterRequestDeniedAfterRemove(
  sandbox: SandboxClient,
  fakeMcp: Awaited<ReturnType<typeof startFakeMcpHttpsServer>>,
  options: {
    adapter: McpDnsRebindingAdapter;
    sandboxName: string;
    mcpUrl: string;
    artifactPrefix: string;
  },
): Promise<void> {
  const requestCount = fakeMcp.requests.length;
  const denial = await sandbox.execShell(
    options.sandboxName,
    trustedSandboxShellScript(
      buildMcpDnsRebindingProbeScript(options.adapter, options.mcpUrl, "FAKE_MCP_SECRET"),
    ),
    {
      artifactName: `${options.artifactPrefix}-mcp-adapter-request-denied-after-remove`,
      env: buildAvailabilityProbeEnv(),
      redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
      timeoutMs: 90_000,
    },
  );
  expect(
    isExpectedMcpCurlPolicyDenial(denial),
    `${options.artifactPrefix} adapter identity must receive an OpenShell policy denial after remove\nstdout:\n${denial.stdout}\nstderr:\n${denial.stderr}`,
  ).toBe(true);
  expect(fakeMcp.requests).toHaveLength(requestCount);
}
async function assertDeepAgentsConfig(
  sandbox: SandboxClient,
  sandboxName: string,
  mcpUrl: string,
): Promise<void> {
  const script = [
    "set -eu",
    "python3 - <<'PY'",
    "import json, pathlib",
    "path = pathlib.Path('/sandbox/.deepagents/.nemoclaw-mcp.json')",
    "text = path.read_text(encoding='utf-8')",
    "data = json.loads(text)",
    `entry = data['mcpServers'][${JSON.stringify(SERVER_NAME)}]`,
    "assert entry['type'] == 'http'",
    `assert entry['url'] == ${JSON.stringify(mcpUrl)}`,
    "assert entry['headers']['Authorization'] == 'Bearer openshell:resolve:env:FAKE_MCP_SECRET'",
    `assert ${JSON.stringify(HOST_SECRET)} not in text`,
    "PY",
  ].join("\n");
  const result = await sandbox.execShell(sandboxName, trustedSandboxShellScript(script), {
    artifactName: "deepagents-mcp-config-assertions",
    env: buildAvailabilityProbeEnv(),
    redactionValues: [HOST_SECRET, Buffer.from(script, "utf8").toString("base64")],
    timeoutMs: 60_000,
  });
  expectExitZero(result, "Deep Agents MCP config contains placeholder and no raw host secret");
}

async function assertAuthenticatedMcpDiscovery(
  fakeMcp: Awaited<ReturnType<typeof startFakeMcpHttpsServer>>,
  options: {
    requestOffset: number;
    expectedSecret: string;
    label: string;
  },
): Promise<void> {
  await expect
    .poll(
      () => {
        const requests = fakeMcp.requests.slice(options.requestOffset);
        const observed = (rpcMethod: "initialize" | "tools/list") =>
          requests.some(
            (request) =>
              request.method === "POST" &&
              request.path === "/mcp" &&
              request.rpcMethod === rpcMethod &&
              request.auth === `Bearer ${options.expectedSecret}`,
          );
        return {
          initialized: observed("initialize"),
          toolsListed: observed("tools/list"),
          requests: requests.map((request) => ({
            method: request.method,
            path: request.path,
            rpcMethod: request.rpcMethod,
            credentialRewritten: request.auth === `Bearer ${options.expectedSecret}`,
          })),
        };
      },
      { interval: 500, timeout: 90_000, message: options.label },
    )
    .toMatchObject({ initialized: true, toolsListed: true });
}

async function assertRealAdapterToolCall(
  sandbox: SandboxClient,
  fakeMcp: Awaited<ReturnType<typeof startFakeMcpHttpsServer>>,
  options: {
    agent: McpAgent;
    sandboxName: string;
    resultToken: string;
    artifactName: string;
    expectedSecret?: string;
  },
): Promise<void> {
  const before = fakeMcp.requests.filter((request) => request.rpcMethod === "tools/call").length;
  const prompt = `Call the fake MCP tool exactly once with challenge ${TOOL_CHALLENGE} and return its result verbatim.`;
  const hermesPayload = JSON.stringify({
    model: COMPATIBLE_MODEL,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 256,
  });
  const command =
    options.agent === "openclaw"
      ? `nemoclaw-start mcporter call fake.fake_echo --args ${JSON.stringify(JSON.stringify({ challenge: TOOL_CHALLENGE }))} --output json`
      : options.agent === "hermes"
        ? [
            "set -a",
            "[ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env",
            "set +a",
            `if [ -n "\${API_SERVER_KEY:-}" ]; then curl -fsS --max-time 180 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' -H "Authorization: Bearer \${API_SERVER_KEY}" --data-binary ${shellQuote(hermesPayload)}; else curl -fsS --max-time 180 http://localhost:8642/v1/chat/completions -H 'Content-Type: application/json' --data-binary ${shellQuote(hermesPayload)}; fi`,
          ].join("\n")
        : `nemoclaw-start dcode -n ${JSON.stringify(prompt)}`;
  const result = await sandbox.execShell(
    options.sandboxName,
    trustedSandboxShellScript(["set -eu", command].join("\n")),
    {
      artifactName: options.artifactName,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 5 * 60_000,
    },
  );
  expectExitZero(result, `${options.agent} real MCP tool call`);
  expect(resultText(result)).toContain(options.resultToken);
  const calls = fakeMcp.requests.filter((request) => request.rpcMethod === "tools/call");
  expect(calls).toHaveLength(before + 1);
  expect(calls.at(-1)).toMatchObject({
    auth: `Bearer ${options.expectedSecret ?? HOST_SECRET}`,
    path: "/mcp",
  });
  expect(calls.at(-1)?.auth).not.toContain("openshell:resolve:env");
}

async function rotateBridgeCredential(
  host: HostCliClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const restart = await host.nemoclaw([sandboxName, "mcp", "restart", SERVER_NAME], {
    artifactName: `${artifactPrefix}-mcp-rotate-provider-credential`,
    env: {
      ...buildAvailabilityProbeEnv(),
      FAKE_MCP_SECRET: ROTATED_HOST_SECRET,
    },
    redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET],
    timeoutMs: 12 * 60_000,
  });
  expectExitZero(restart, `${artifactPrefix} mcp credential rotation`);
}

async function restartBridgeWithoutHostSecret(
  host: HostCliClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const restart = await host.nemoclaw([sandboxName, "mcp", "restart", SERVER_NAME], {
    artifactName: `${artifactPrefix}-mcp-restart-provider-reuse`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 12 * 60_000,
  });
  expectExitZero(restart, `${artifactPrefix} mcp restart without host secret`);
}

async function rebuildWithoutMcpHostSecret(
  host: HostCliClient,
  sandboxName: string,
  artifactPrefix: string,
): Promise<void> {
  const rebuild = await host.nemoclaw([sandboxName, "rebuild", "--yes"], {
    artifactName: `${artifactPrefix}-rebuild-with-provider-backed-mcp`,
    env: {
      ...buildAvailabilityProbeEnv(),
      COMPATIBLE_API_KEY: COMPATIBLE_KEY,
      NVIDIA_INFERENCE_API_KEY: COMPATIBLE_KEY,
    },
    redactionValues: [COMPATIBLE_KEY, HOST_SECRET, ROTATED_HOST_SECRET],
    timeoutMs: 25 * 60_000,
  });
  expectExitZero(rebuild, `${artifactPrefix} rebuild without MCP host secret`);
}

test("mcp-bridge", { timeout: 45 * 60_000 }, async ({ artifacts, cleanup, host, sandbox }) => {
  await artifacts.writeJson("scenario.json", {
    id: "mcp-bridge",
    sandbox: OPENCLAW_SANDBOX_NAME,
    server: SERVER_NAME,
  });
  const compatibleMock = await startCompatibleMock({
    apiKey: COMPATIBLE_KEY,
    model: COMPATIBLE_MODEL,
  });
  cleanup.add("stop MCP bridge compatible endpoint mock", () => compatibleMock.close());
  const fakeMcp = await startFakeMcpHttpsServer({ secret: HOST_SECRET });
  cleanup.add("stop fake MCP HTTPS server", () => fakeMcp.close());
  const fakeMcpTunnel = await startPublicMcpHttpsTunnel({
    cleanup,
    label: "fake MCP HTTPS server",
    server: fakeMcp,
  });
  const decoyMcp = await startFakeMcpHttpsServer({ secret: HOST_SECRET });
  cleanup.add("stop unconfigured decoy MCP HTTPS server", () => decoyMcp.close());
  const decoyMcpTunnel = await startPublicMcpHttpsTunnel({
    cleanup,
    label: "unconfigured decoy MCP HTTPS server",
    server: decoyMcp,
  });
  const hostAddress = await hostAddressForSandbox(host);
  const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
  const mcpUrl = fakeMcpTunnel.url;
  const decoyMcpUrl = decoyMcpTunnel.url;
  await onboardAgent(host, cleanup, endpointUrl, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    artifactName: "onboard-openclaw-mcp-bridge",
  });
  // Exercise the raw OpenShell `allowed_ips` boundary before any NemoClaw MCP
  // mutation. The helper uses a direct curl request with a /** binary grant,
  // then restores this sandbox's exact base policy before returning, so this
  // proof is independent of both the CLI implementation and adapter identity.
  await assertRawOpenShellAllowedIpsRebindingDenied({
    artifacts,
    env: buildAvailabilityProbeEnv(),
    host,
    policySettleMs: 5_000,
    sandbox,
    sandboxName: OPENCLAW_SANDBOX_NAME,
    timeoutMs: 120_000,
  });

  cleanup.add("remove MCP bridge", () =>
    bestEffortRemoveBridge(host, OPENCLAW_SANDBOX_NAME, SERVER_NAME, "mcporter"),
  );
  cleanup.add("remove unexpected missing-secret MCP state", () =>
    bestEffortRemoveBridge(host, OPENCLAW_SANDBOX_NAME, "missingsecret", "mcporter"),
  );

  await expectMcpCliFailure(
    host,
    OPENCLAW_SANDBOX_NAME,
    ["add", "missingurl"],
    /MCP server URL is required/,
    "mcp-negative-missing-url",
  );
  await expectMcpCliFailure(
    host,
    OPENCLAW_SANDBOX_NAME,
    ["add", "badurl", "--url", "stdio://local"],
    /must use https:\/\//,
    "mcp-negative-invalid-url",
  );
  await expectMcpCliFailure(
    host,
    OPENCLAW_SANDBOX_NAME,
    ["add", "ssrf", "--url", "https://169.254.169.254/latest"],
    /private, local, or special-use/,
    "mcp-negative-ssrf-url",
  );
  await expectMcpCliFailure(
    host,
    OPENCLAW_SANDBOX_NAME,
    ["add", "noauth", "--url", mcpUrl],
    /Authenticated MCP requires exactly one --env KEY/,
    "mcp-negative-missing-credential-reference",
  );
  await expectMcpCliFailure(
    host,
    OPENCLAW_SANDBOX_NAME,
    ["add", "missingsecret", "--url", mcpUrl, "--env", "MISSING_MCP_SECRET"],
    /Host environment variable 'MISSING_MCP_SECRET' is required/,
    "mcp-negative-missing-secret",
  );

  await assertConcurrentAddSerialized(host, cleanup, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
    mcpUrl,
    expectedAdapter: "mcporter",
    artifactPrefix: "openclaw",
  });

  const providerName = await addBridgeAndReadStatus(host, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
    mcpUrl,
    expectedAdapter: "mcporter",
    artifactPrefix: "openclaw",
  });
  await assertBridgeInfrastructure(host, sandbox, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
    artifactPrefix: "openclaw",
    providerName,
    mcpUrl,
  });
  await expectMcpCliFailure(
    host,
    OPENCLAW_SANDBOX_NAME,
    ["add", SERVER_NAME, "--url", mcpUrl, "--env", "FAKE_MCP_SECRET"],
    /already exists/,
    "mcp-negative-duplicate-server",
    {
      ...buildAvailabilityProbeEnv(),
      FAKE_MCP_SECRET: HOST_SECRET,
    },
  );

  const mcporterList = await sandbox.execShell(
    OPENCLAW_SANDBOX_NAME,
    trustedSandboxShellScript(
      ["set -eu", `nemoclaw-start mcporter list ${SERVER_NAME} --json`].join("\n"),
    ),
    {
      artifactName: "mcp-mcporter-list-tools",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 90_000,
    },
  );
  expectExitZero(mcporterList, "mcporter lists tools through OpenShell MCP policy");
  expect(resultText(mcporterList)).toContain("fake_echo");
  expect(fakeMcp.requests.some((request) => request.auth === `Bearer ${HOST_SECRET}`)).toBe(true);
  expect(fakeMcp.requests.every((request) => !request.auth.includes("openshell:resolve:env"))).toBe(
    true,
  );

  const mcpCallScript = `const https = require("node:https");
const url = new URL(process.argv[2]);
const method = process.argv[3];
const expectation = process.argv[4];
const credentialKey = process.argv[5] || "FAKE_MCP_SECRET";
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method });
const req = https.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname,
  method: "POST",
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "authorization": "Bearer openshell:resolve:env:" + credentialKey
  }
}, (res) => {
  let data = "";
  res.setEncoding("utf8");
  res.on("data", (chunk) => { data += chunk; });
  res.on("end", () => {
    console.log(JSON.stringify({ status: res.statusCode, body: data }));
    const allowed = res.statusCode === 200 && data.includes("fake_echo");
    const denied = res.statusCode === 403;
    process.exit(expectation === "allow" ? (allowed ? 0 : 1) : (denied ? 0 : 1));
  });
});
req.on("error", (error) => {
  console.error(error.message);
  const strictDenied = expectation === "deny-strict" && /HTTP\\/1\\.[01] 403 Forbidden/.test(error.message);
  strictDenied && console.log(JSON.stringify({ status: 403, error: error.message }));
  process.exit(expectation === "deny" || strictDenied ? 0 : 1);
});
req.end(body);
`;
  await artifacts.writeText("mcp-provider-rewrite-proof.cjs", mcpCallScript);
  const mcpCallScriptB64 = Buffer.from(mcpCallScript, "utf8").toString("base64");
  const runNodeMcpProbe = async (
    targetUrl: string,
    method: string,
    expectation: "allow" | "deny" | "deny-strict",
    artifactName: string,
    credentialKey = "FAKE_MCP_SECRET",
  ): Promise<ShellProbeResult> =>
    sandbox.execShell(
      OPENCLAW_SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `printf '%s' ${JSON.stringify(mcpCallScriptB64)} | base64 -d > /tmp/nemoclaw-mcp-provider-rewrite-proof.cjs`,
          `nemoclaw-start node /tmp/nemoclaw-mcp-provider-rewrite-proof.cjs ${JSON.stringify(targetUrl)} ${JSON.stringify(method)} ${expectation} ${JSON.stringify(credentialKey)}`,
        ].join("\n"),
      ),
      {
        artifactName,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 90_000,
      },
    );

  await assertAdapterDnsRebindingDenied(host, sandbox, cleanup, {
    adapter: "mcporter",
    artifactPrefix: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    secretPaths: ["/sandbox/.openclaw", "/sandbox/.mcp.json"],
  });

  const requestCountBeforeAllowedNodeProof = fakeMcp.requests.length;
  const allowedNodeCall = await runNodeMcpProbe(
    mcpUrl,
    "tools/list",
    "allow",
    "mcp-provider-rewrite-tools-list",
  );
  expectExitZero(allowedNodeCall, "Node runtime identity can use an explicitly allowed MCP method");
  const allowedNodeRequests = fakeMcp.requests.slice(requestCountBeforeAllowedNodeProof);
  expect(allowedNodeRequests).toHaveLength(1);
  expect(allowedNodeRequests[0]).toMatchObject({
    method: "POST",
    path: "/mcp",
    auth: `Bearer ${HOST_SECRET}`,
  });
  expect(JSON.parse(allowedNodeRequests[0].body)).toMatchObject({
    jsonrpc: "2.0",
    method: "tools/list",
  });
  expect(fakeMcp.requests.every((request) => !request.auth.includes("openshell:resolve:env"))).toBe(
    true,
  );

  const requestCountAfterAllowedNodeProof = fakeMcp.requests.length;
  const deniedNodeCall = await runNodeMcpProbe(
    mcpUrl,
    "admin/delete",
    "deny",
    "mcp-provider-rewrite-extension-method-denied",
  );
  expectExitZero(deniedNodeCall, "Node runtime identity cannot use a non-allowlisted MCP method");
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const deniedWrongPathCall = await runNodeMcpProbe(
    `${new URL(mcpUrl).origin}/not-the-configured-mcp-path`,
    "tools/list",
    "deny",
    "mcp-provider-rewrite-unconfigured-path-denied",
  );
  expectExitZero(
    deniedWrongPathCall,
    "allowed Node runtime cannot replay the placeholder to another path",
  );
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const deniedDecoyCall = await runNodeMcpProbe(
    decoyMcpUrl,
    "tools/list",
    "deny",
    "mcp-provider-rewrite-unconfigured-endpoint-denied",
  );
  expectExitZero(
    deniedDecoyCall,
    "allowed Node runtime cannot replay the placeholder to another endpoint",
  );
  expect(decoyMcp.requests).toHaveLength(0);
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const deniedCurl = await sandbox.execShell(
    OPENCLAW_SANDBOX_NAME,
    trustedSandboxShellScript(
      [
        "set -eu",
        `body='{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        "rm -f /tmp/nemoclaw-mcp-denied.out /tmp/nemoclaw-mcp-denied.err",
        "set +e",
        `code="$(curl -sS -o /tmp/nemoclaw-mcp-denied.out -w '%{http_code}' -X POST ${JSON.stringify(mcpUrl)} -H 'content-type: application/json' -H 'authorization: Bearer openshell:resolve:env:FAKE_MCP_SECRET' --data "$body" 2>/tmp/nemoclaw-mcp-denied.err)"`,
        "curl_rc=$?",
        "set -e",
        "cat /tmp/nemoclaw-mcp-denied.out 2>/dev/null || true",
        "cat /tmp/nemoclaw-mcp-denied.err >&2",
        'printf "NEMOCLAW_MCP_CURL_HTTP_CODE=%s\\n" "$code"',
        'exit "$curl_rc"',
      ].join("\n"),
    ),
    {
      artifactName: "mcp-non-allowlisted-binary-curl-denied",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expect(
    isExpectedMcpCurlPolicyDenial(deniedCurl),
    `non-allowlisted curl must receive an OpenShell policy denial\nstdout:\n${deniedCurl.stdout}\nstderr:\n${deniedCurl.stderr}`,
  ).toBe(true);
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const registryRaw = fs.existsSync(REGISTRY_FILE) ? fs.readFileSync(REGISTRY_FILE, "utf8") : "";
  expect(registryRaw).toContain(mcpUrl);
  expect(registryRaw).toContain(providerName);
  expect(registryRaw).not.toContain("enc:v1:");
  expect(registryRaw).not.toContain("proxy.pid");
  expect(registryRaw).not.toContain(HOST_SECRET);
  await assertSecretAbsentFromSandbox(sandbox, OPENCLAW_SANDBOX_NAME, [
    "/sandbox/.openclaw",
    "/sandbox/.mcp.json",
  ]);

  const openClawResult = `MCP_AUTH_REWRITE_OK::${TOOL_CHALLENGE}`;
  await assertRealAdapterToolCall(sandbox, fakeMcp, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    resultToken: openClawResult,
    artifactName: "openclaw-real-mcp-tool-call-initial",
  });
  await restartBridgeWithoutHostSecret(host, OPENCLAW_SANDBOX_NAME, "openclaw");
  await assertRealAdapterToolCall(sandbox, fakeMcp, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    resultToken: openClawResult,
    artifactName: "openclaw-real-mcp-tool-call-after-restart",
  });
  fakeMcp.setSecret(ROTATED_HOST_SECRET);
  await rotateBridgeCredential(host, OPENCLAW_SANDBOX_NAME, "openclaw");
  await assertRealAdapterToolCall(sandbox, fakeMcp, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    resultToken: openClawResult,
    artifactName: "openclaw-real-mcp-tool-call-after-credential-rotation",
    expectedSecret: ROTATED_HOST_SECRET,
  });
  await assertSecretAbsentFromSandbox(
    sandbox,
    OPENCLAW_SANDBOX_NAME,
    ["/sandbox/.openclaw", "/sandbox/.mcp.json"],
    [HOST_SECRET, ROTATED_HOST_SECRET],
    "openclaw-assert-secrets-absent-after-rotation",
  );
  await rebuildWithoutMcpHostSecret(host, OPENCLAW_SANDBOX_NAME, "openclaw");
  await assertSecretAbsentFromSandbox(
    sandbox,
    OPENCLAW_SANDBOX_NAME,
    ["/sandbox/.openclaw", "/sandbox/.mcp.json"],
    [HOST_SECRET, ROTATED_HOST_SECRET],
    "openclaw-assert-secrets-absent-after-rebuild",
  );
  await assertRealAdapterToolCall(sandbox, fakeMcp, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    resultToken: openClawResult,
    artifactName: "openclaw-real-mcp-tool-call-after-rebuild",
    expectedSecret: ROTATED_HOST_SECRET,
  });

  await removeBridgeAndAssertEmpty(host, sandbox, {
    agent: "openclaw",
    adapter: "mcporter",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    artifactPrefix: "openclaw",
    providerName,
    mcpUrl,
  });
  await assertAdapterRequestDeniedAfterRemove(sandbox, fakeMcp, {
    adapter: "mcporter",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    mcpUrl,
    artifactPrefix: "openclaw",
  });
});

liveAgentMatrixTest(
  "mcp-bridge-hermes",
  { timeout: 45 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox }) => {
    await artifacts.writeJson("scenario.json", {
      id: "mcp-bridge-hermes",
      sandbox: HERMES_SANDBOX_NAME,
      server: SERVER_NAME,
    });
    const hermesResult = `MCP_AUTH_REWRITE_OK::${TOOL_CHALLENGE}`;
    const compatibleMock = await startCompatibleMock({
      apiKey: COMPATIBLE_KEY,
      model: COMPATIBLE_MODEL,
      toolChallenge: TOOL_CHALLENGE,
      toolResultToken: hermesResult,
      toolNames: ["mcp_fake_fake_echo"],
      deferredToolName: "mcp_fake_fake_echo",
    });
    cleanup.add("stop Hermes MCP bridge compatible endpoint mock", () => compatibleMock.close());
    const fakeMcp = await startFakeMcpHttpsServer({
      secret: HOST_SECRET,
      challenge: TOOL_CHALLENGE,
      resultToken: hermesResult,
    });
    cleanup.add("stop fake Hermes MCP HTTPS server", () => fakeMcp.close());
    const fakeMcpTunnel = await startPublicMcpHttpsTunnel({
      cleanup,
      label: "fake Hermes MCP HTTPS server",
      server: fakeMcp,
    });
    const hostAddress = await hostAddressForSandbox(host);
    const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
    const mcpUrl = fakeMcpTunnel.url;
    await onboardAgent(host, cleanup, endpointUrl, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      artifactName: "onboard-hermes-mcp-bridge",
    });
    cleanup.add("remove Hermes MCP bridge", () =>
      bestEffortRemoveBridge(host, HERMES_SANDBOX_NAME, SERVER_NAME, "hermes-config"),
    );

    await assertConcurrentAddSerialized(host, cleanup, {
      sandboxName: HERMES_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "hermes-config",
      artifactPrefix: "hermes",
    });

    const initialDiscoveryOffset = fakeMcp.requests.length;
    const providerName = await addBridgeAndReadStatus(host, {
      sandboxName: HERMES_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "hermes-config",
      artifactPrefix: "hermes",
    });
    await assertAuthenticatedMcpDiscovery(fakeMcp, {
      requestOffset: initialDiscoveryOffset,
      expectedSecret: HOST_SECRET,
      label: "Hermes initial MCP discovery",
    });
    await assertBridgeInfrastructure(host, sandbox, {
      sandboxName: HERMES_SANDBOX_NAME,
      artifactPrefix: "hermes",
      providerName,
      mcpUrl,
    });
    await assertHermesConfig(sandbox, HERMES_SANDBOX_NAME, mcpUrl);
    await assertHermesInspectionRejectsUnmanagedFields(sandbox, HERMES_SANDBOX_NAME);
    await assertSecretAbsentFromSandbox(sandbox, HERMES_SANDBOX_NAME, ["/sandbox/.hermes"]);
    await assertAdapterDnsRebindingDenied(host, sandbox, cleanup, {
      adapter: "hermes-config",
      artifactPrefix: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      secretPaths: ["/sandbox/.hermes"],
    });
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      resultToken: hermesResult,
      artifactName: "hermes-real-mcp-tool-call-initial",
    });
    await restartBridgeWithoutHostSecret(host, HERMES_SANDBOX_NAME, "hermes");
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      resultToken: hermesResult,
      artifactName: "hermes-real-mcp-tool-call-after-restart",
    });
    fakeMcp.setSecret(ROTATED_HOST_SECRET);
    await rotateBridgeCredential(host, HERMES_SANDBOX_NAME, "hermes");
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      resultToken: hermesResult,
      artifactName: "hermes-real-mcp-tool-call-after-credential-rotation",
      expectedSecret: ROTATED_HOST_SECRET,
    });
    await assertSecretAbsentFromSandbox(
      sandbox,
      HERMES_SANDBOX_NAME,
      ["/sandbox/.hermes"],
      [HOST_SECRET, ROTATED_HOST_SECRET],
      "hermes-assert-secrets-absent-after-rotation",
    );
    const rebuildDiscoveryOffset = fakeMcp.requests.length;
    await rebuildWithoutMcpHostSecret(host, HERMES_SANDBOX_NAME, "hermes");
    await assertAuthenticatedMcpDiscovery(fakeMcp, {
      requestOffset: rebuildDiscoveryOffset,
      expectedSecret: ROTATED_HOST_SECRET,
      label: "Hermes post-rebuild MCP discovery",
    });
    await assertHermesConfig(sandbox, HERMES_SANDBOX_NAME, mcpUrl);
    await assertSecretAbsentFromSandbox(
      sandbox,
      HERMES_SANDBOX_NAME,
      ["/sandbox/.hermes"],
      [HOST_SECRET, ROTATED_HOST_SECRET],
      "hermes-assert-secrets-absent-after-rebuild",
    );
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      resultToken: hermesResult,
      artifactName: "hermes-real-mcp-tool-call-after-rebuild",
      expectedSecret: ROTATED_HOST_SECRET,
    });
    await removeBridgeAndAssertEmpty(host, sandbox, {
      agent: "hermes",
      adapter: "hermes-config",
      sandboxName: HERMES_SANDBOX_NAME,
      artifactPrefix: "hermes",
      providerName,
      mcpUrl,
    });
    await assertAdapterRequestDeniedAfterRemove(sandbox, fakeMcp, {
      adapter: "hermes-config",
      sandboxName: HERMES_SANDBOX_NAME,
      mcpUrl,
      artifactPrefix: "hermes",
    });
    await assertHermesRemovalSurvivesGatewayRestart(host, sandbox, HERMES_SANDBOX_NAME);
    await assertAdapterRequestDeniedAfterRemove(sandbox, fakeMcp, {
      adapter: "hermes-config",
      sandboxName: HERMES_SANDBOX_NAME,
      mcpUrl,
      artifactPrefix: "hermes-after-removal-gateway-restart",
    });
    await assertSecretAbsentFromSandbox(
      sandbox,
      HERMES_SANDBOX_NAME,
      ["/sandbox/.hermes", "/tmp/nemoclaw-start.log"],
      [HOST_SECRET, ROTATED_HOST_SECRET],
      "hermes-assert-secrets-absent-after-removal-gateway-restart",
    );
  },
);

liveAgentMatrixTest(
  "mcp-bridge-deepagents",
  { timeout: 45 * 60_000 },
  async ({ artifacts, cleanup, host, sandbox }) => {
    await artifacts.writeJson("scenario.json", {
      id: "mcp-bridge-deepagents",
      sandbox: DEEPAGENTS_SANDBOX_NAME,
      server: SERVER_NAME,
    });
    const deepAgentsResult = `MCP_AUTH_REWRITE_OK::${TOOL_CHALLENGE}`;
    const compatibleMock = await startCompatibleMock({
      apiKey: COMPATIBLE_KEY,
      model: COMPATIBLE_MODEL,
      toolChallenge: TOOL_CHALLENGE,
      toolResultToken: deepAgentsResult,
      progressiveToolSearch: { toolName: "fake_fake_echo", query: "AuThEnTiCaTeD McP" },
    });
    cleanup.add("stop Deep Agents MCP bridge compatible endpoint mock", () =>
      compatibleMock.close(),
    );
    const fakeMcp = await startFakeMcpHttpsServer({
      secret: HOST_SECRET,
      challenge: TOOL_CHALLENGE,
      resultToken: deepAgentsResult,
    });
    cleanup.add("stop fake Deep Agents MCP HTTPS server", () => fakeMcp.close());
    const fakeMcpTunnel = await startPublicMcpHttpsTunnel({
      cleanup,
      label: "fake Deep Agents MCP HTTPS server",
      server: fakeMcp,
    });
    const hostAddress = await hostAddressForSandbox(host);
    const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
    const mcpUrl = fakeMcpTunnel.url;
    await onboardAgent(host, cleanup, endpointUrl, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactName: "onboard-deepagents-mcp-bridge",
    });
    cleanup.add("remove Deep Agents MCP bridge", () =>
      bestEffortRemoveBridge(host, DEEPAGENTS_SANDBOX_NAME, SERVER_NAME, "deepagents-config"),
    );

    await assertConcurrentAddSerialized(host, cleanup, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "deepagents-config",
      artifactPrefix: "deepagents",
    });

    const providerName = await addBridgeAndReadStatus(host, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "deepagents-config",
      artifactPrefix: "deepagents",
    });
    await assertBridgeInfrastructure(host, sandbox, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactPrefix: "deepagents",
      providerName,
      mcpUrl,
    });
    await assertDeepAgentsConfig(sandbox, DEEPAGENTS_SANDBOX_NAME, mcpUrl);
    await assertSecretAbsentFromSandbox(sandbox, DEEPAGENTS_SANDBOX_NAME, ["/sandbox/.deepagents"]);
    await assertAdapterDnsRebindingDenied(host, sandbox, cleanup, {
      adapter: "deepagents-config",
      artifactPrefix: "deepagents",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      secretPaths: ["/sandbox/.deepagents"],
    });
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-initial",
    });
    await restartBridgeWithoutHostSecret(host, DEEPAGENTS_SANDBOX_NAME, "deepagents");
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-after-restart",
    });
    fakeMcp.setSecret(ROTATED_HOST_SECRET);
    await rotateBridgeCredential(host, DEEPAGENTS_SANDBOX_NAME, "deepagents");
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-after-credential-rotation",
      expectedSecret: ROTATED_HOST_SECRET,
    });
    await assertSecretAbsentFromSandbox(
      sandbox,
      DEEPAGENTS_SANDBOX_NAME,
      ["/sandbox/.deepagents"],
      [HOST_SECRET, ROTATED_HOST_SECRET],
      "deepagents-assert-secrets-absent-after-rotation",
    );
    await rebuildWithoutMcpHostSecret(host, DEEPAGENTS_SANDBOX_NAME, "deepagents");
    await assertDeepAgentsConfig(sandbox, DEEPAGENTS_SANDBOX_NAME, mcpUrl);
    await assertSecretAbsentFromSandbox(
      sandbox,
      DEEPAGENTS_SANDBOX_NAME,
      ["/sandbox/.deepagents"],
      [HOST_SECRET, ROTATED_HOST_SECRET],
      "deepagents-assert-secrets-absent-after-rebuild",
    );
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-after-rebuild",
      expectedSecret: ROTATED_HOST_SECRET,
    });
    await removeBridgeAndAssertEmpty(host, sandbox, {
      agent: "langchain-deepagents-code",
      adapter: "deepagents-config",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactPrefix: "deepagents",
      providerName,
      mcpUrl,
    });
    await assertAdapterRequestDeniedAfterRemove(sandbox, fakeMcp, {
      adapter: "deepagents-config",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      mcpUrl,
      artifactPrefix: "deepagents",
    });
  },
);
