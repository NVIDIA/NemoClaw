// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDeepAgentsMcpStatusCommand,
  buildHermesMcpStatusCommand,
  buildOpenClawMcporterInspectCommand,
  OPENCLAW_MCPORTER_ROOT,
} from "../../../src/lib/actions/sandbox/mcp-bridge-adapter-status";
import { shellQuote } from "../../../src/lib/core/shell-quote";
import type { McpBridgeEntry } from "../../../src/lib/state/registry";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertExitZero as expectExitZero, resultText } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { test as e2eTest, expect } from "../fixtures/e2e-test.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import {
  type McpBridgeShard,
  resolveMcpBridgeE2eScope,
  resolveMcpBridgeShard,
  runFullMcpBridgeE2eCoverage,
} from "./mcp-bridge-agent-selection.ts";
import {
  cleanupMcpBridge,
  MCP_MUTATION_TIMEOUT_MS,
  type McpAdapter,
  prepareOwnedSandboxForOnboard,
  removeMcpBridgeWithOneConcurrencyRetry,
} from "./mcp-bridge-cleanup.ts";
import {
  assertHermesMcpHttpResponse,
  buildHermesMcpChatProbeScript,
  buildHermesMcpRuntimeDiagnosticsScript,
  HERMES_MCP_FAILURE_CAPTURE_BYTES,
} from "./mcp-bridge-hermes-http.ts";
import {
  assertHermesConfig,
  assertHermesInspectionRejectsUnmanagedFields,
  assertHermesManagedAddSurvivesLockedGatewayRestartAndStateLayout,
  assertHermesReloadRollback,
  assertHermesRemovalSurvivesGatewayRestart,
  lowerHermesShieldsForCleanup,
  reopenHermesMcpMaintenanceWindow,
} from "./mcp-bridge-hermes-lifecycle.ts";
import {
  assertMcpBridgeManagedImageReceipt,
  buildMcpBridgeExactMainEnv,
  buildMcpBridgeOnboardArgs,
  buildMcpBridgeOnboardEnv,
  requireMcpBridgeTlsCaCert,
} from "./mcp-bridge-onboard-env.ts";
import { MCP_BRIDGE_PHASES } from "./mcp-bridge-phases.ts";
import {
  restartBridgeWithoutHostSecret,
  retryOpenClawBaselineScopeOnboardFailure,
  retryAfterHermesRestartTransportFailure,
  retryHermesGatewayDraining,
} from "./mcp-bridge-reliability.ts";
import {
  applyMcpHostPolicyEdit,
  buildMcpDnsRebindingProbeScript,
  expectExitNonZero,
  hostAddressForSandbox,
  isExpectedMcpCurlPolicyDenial,
  type McpDnsRebindingAdapter,
} from "./mcp-bridge-sandbox.ts";
import {
  startCompatibleMock,
  startFakeMcpHttpsServer,
  startPublicMcpHttpsTunnel,
} from "./mcp-bridge-servers.ts";
import {
  assertAuthenticatedMcpDiscovery,
  assertAuthenticatedMcpDiscoveryWithOneRestart,
  assertAuthenticatedMcpRediscovery,
  assertAuthenticatedMcpToolDiscovery,
  runHermesInitialMcpReadiness,
} from "./mcp-bridge-tool-discovery.ts";
import { assertTrustedPrivateMcpRebindingDenied } from "./mcp-bridge-trusted-private.ts";
import {
  buildRevisionScopedMcpAuthorizationPattern,
  MCP_PROVIDER_REWRITE_PROBE_SOURCE,
} from "./mcp-provider-rewrite-probe.ts";
import { assertRawOpenShellAllowedIpsRebindingDenied } from "./openshell-allowed-ips-rebinding.ts";
import { prepareExactMainMcpProof } from "./openshell-exact-main-mcp-proof.ts";
const OPENCLAW_SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-mcp-bridge";
const HERMES_SANDBOX_NAME = process.env.NEMOCLAW_MCP_HERMES_SANDBOX_NAME ?? "e2e-mcp-hermes";
const DEEPAGENTS_SANDBOX_NAME = process.env.NEMOCLAW_MCP_DEEPAGENTS_SANDBOX_NAME ?? "e2e-mcp-dcode";
const SERVER_NAME = "fake";
const SERVER_POLICY_KEY = "mcp_bridge_fake";
const CONCURRENT_SERVER_NAME = "concurrent";
const HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.host;
const ROTATED_HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost;
const COMPATIBLE_KEY = MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint;
const COMPATIBLE_MODEL = "mock/mcp-bridge";
const TOOL_CHALLENGE = "nemoclaw-authenticated-mcp-proof";
const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
const selectedMcpBridgeShard = resolveMcpBridgeShard();
const mcpBridgeE2eScope = resolveMcpBridgeE2eScope();
function mcpBridgeShardTest(shard: McpBridgeShard) {
  return selectedMcpBridgeShard === shard ? e2eTest : e2eTest.skip;
}
const test = mcpBridgeShardTest("openclaw");
type McpAgent = "openclaw" | "hermes" | "langchain-deepagents-code";
function expectManagedImageQualificationReceipt(sandboxName: string, agent: McpAgent): void {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as {
    sandboxes?: Record<string, { workload?: Record<string, unknown> }>;
  };
  assertMcpBridgeManagedImageReceipt({
    expectedAgent: agent,
    workload: registry.sandboxes?.[sandboxName]?.workload,
  });
}
async function onboardAgent(
  host: HostCliClient,
  sandbox: SandboxClient,
  cleanup: CleanupRegistry,
  endpointUrl: string,
  options: {
    agent: McpAgent;
    sandboxName: string;
    artifactName: string;
    envOverlay?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const corporateCaBundle = requireMcpBridgeTlsCaCert();
  await prepareOwnedSandboxForOnboard(host, sandbox, cleanup, options.sandboxName);
  const args = buildMcpBridgeOnboardArgs();
  const commandOptions = {
    artifactName: options.artifactName,
    env: buildMcpBridgeOnboardEnv({
      agent: options.agent,
      compatibleKey: COMPATIBLE_KEY,
      compatibleModel: COMPATIBLE_MODEL,
      corporateCaBundle,
      endpointUrl,
      envOverlay: options.envOverlay,
      sandboxName: options.sandboxName,
    }),
    redactionValues: [COMPATIBLE_KEY],
    timeoutMs: 20 * 60_000,
  };
  const result = await retryOpenClawBaselineScopeOnboardFailure({
    agent: options.agent,
    sandboxName: options.sandboxName,
    initialResult: await host.nemoclaw(args, commandOptions),
    retry: () =>
      host.nemoclaw(args, {
        ...commandOptions,
        artifactName: `${options.artifactName}-baseline-scope-retry`,
      }),
  });
  expectExitZero(result, `onboard ${options.agent} sandbox for MCP bridge`);
  expectManagedImageQualificationReceipt(options.sandboxName, options.agent);
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
async function addBridgeAndReadStatus(
  host: HostCliClient,
  sandbox: SandboxClient,
  options: {
    sandboxName: string;
    mcpUrl: string;
    expectedAdapter: McpAdapter;
    artifactPrefix: string;
  },
): Promise<string> {
  await applyMcpHostPolicyEdit(sandbox, options);
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
  expect(statusJson.warnings).toEqual([]);
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
    cleanupMcpBridge(host, options.sandboxName, CONCURRENT_SERVER_NAME, options.expectedAdapter),
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
        // Keep both clients alive through Hermes' bounded restart and config
        // reload; the loser then acquires the lock and rejects the duplicate.
        timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.expectedAdapter],
      }),
    ),
  );
  const successful = attempts.filter((result) => result.exitCode === 0);
  const rejected = attempts.filter((result) => result.exitCode !== 0);
  expect(successful).toHaveLength(1);
  expect(rejected).toHaveLength(1);
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
  const duplicateRejection = await retryAfterHermesRestartTransportFailure({
    adapter: options.expectedAdapter,
    committedBridgeVerified: true,
    diagnostic: resultText(rejected[0]!),
    originalResult: rejected[0]!,
    retry: () =>
      host.nemoclaw(args, {
        artifactName: `${options.artifactPrefix}-mcp-concurrent-add-after-restart-transport-failure`,
        env,
        redactionValues: [HOST_SECRET],
        timeoutMs: MCP_MUTATION_TIMEOUT_MS[options.expectedAdapter],
      }),
  });
  expectExitNonZero(
    duplicateRejection,
    `${options.artifactPrefix} concurrent MCP add rejects the serialized duplicate`,
    /already exists/,
  );
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
  const remove = await removeMcpBridgeWithOneConcurrencyRetry(
    host,
    options.sandboxName,
    SERVER_NAME,
    options.adapter,
    options.artifactPrefix,
  );
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
  expect(resultText(policy)).toContain("mcp_host_edit_e2e");
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
  const authorizationPattern = buildRevisionScopedMcpAuthorizationPattern("FAKE_MCP_SECRET");
  const script = [
    "set -eu",
    "python3 - <<'PY'",
    "import json, pathlib, re",
    "path = pathlib.Path('/sandbox/.deepagents/.nemoclaw-mcp.json')",
    "text = path.read_text(encoding='utf-8')",
    "data = json.loads(text)",
    `entry = data['mcpServers'][${JSON.stringify(SERVER_NAME)}]`,
    "assert entry['type'] == 'http'",
    `assert entry['url'] == ${JSON.stringify(mcpUrl)}`,
    `assert re.fullmatch(${JSON.stringify(authorizationPattern)}, entry['headers']['Authorization'])`,
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
  // ShellProbe redacts these values before it returns command output or writes
  // artifacts. The HTTP assertion redacts them again before Vitest formats a
  // bounded failure preview.
  const hermesRedactionValues = [
    HOST_SECRET,
    ROTATED_HOST_SECRET,
    COMPATIBLE_KEY,
    TOOL_CHALLENGE,
    prompt,
    hermesPayload,
  ];
  const command =
    options.agent === "openclaw"
      ? `nemoclaw-start mcporter --root ${shellQuote(OPENCLAW_MCPORTER_ROOT)} call fake.fake_echo --args ${JSON.stringify(JSON.stringify({ challenge: TOOL_CHALLENGE }))} --output json`
      : options.agent === "hermes"
        ? [
            "set -a",
            "[ ! -f /sandbox/.hermes/.env ] || . /sandbox/.hermes/.env",
            "set +a",
            buildHermesMcpChatProbeScript(hermesPayload, options.resultToken),
          ].join("\n")
        : `nemoclaw-start dcode -n ${JSON.stringify(prompt)}`;
  const runToolCall = (artifactName: string) =>
    sandbox.execShell(
      options.sandboxName,
      trustedSandboxShellScript(["set -eu", command].join("\n")),
      {
        artifactName,
        env: buildAvailabilityProbeEnv(),
        captureLimitBytes:
          options.agent === "hermes" ? HERMES_MCP_FAILURE_CAPTURE_BYTES : undefined,
        redactionValues: options.agent === "hermes" ? hermesRedactionValues : [],
        timeoutMs: 5 * 60_000,
      },
    );
  const initialResult = await runToolCall(options.artifactName);
  const result =
    options.agent === "hermes"
      ? await retryHermesGatewayDraining({
          initialResult,
          retry: (attempt) =>
            runToolCall(`${options.artifactName}-gateway-draining-retry-${attempt}`),
        })
      : initialResult;
  const assertResponse =
    options.agent === "hermes"
      ? () => assertHermesMcpHttpResponse(result, hermesRedactionValues)
      : () => {
          expectExitZero(result, `${options.agent} real MCP tool call`);
          expect(resultText(result)).toContain(options.resultToken);
        };
  assertResponse();
  const calls = fakeMcp.requests.filter((request) => request.rpcMethod === "tools/call");
  expect(calls).toHaveLength(before + 1);
  expect(calls.at(-1)).toMatchObject({
    auth: `Bearer ${options.expectedSecret ?? HOST_SECRET}`,
    path: "/mcp",
  });
  expect(calls.at(-1)?.auth).not.toContain("openshell:resolve:env");
}

async function captureHermesGatewayIdentity(
  sandbox: SandboxClient,
  artifactName: string,
): Promise<void> {
  const result = await sandbox.execShell(
    HERMES_SANDBOX_NAME,
    trustedSandboxShellScript(
      [
        "set -eu",
        "/usr/bin/python3 -I -S - <<'PY'",
        "import json, pathlib",
        "record = json.loads(pathlib.Path('/sandbox/.hermes/runtime/gateway.pid').read_text())",
        "pid = record if isinstance(record, int) else record['pid']",
        "fields = pathlib.Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()",
        "print(json.dumps({'pid': pid, 'start_time': int(fields[19])}, sort_keys=True))",
        "PY",
      ].join("\n"),
    ),
    { artifactName, env: buildAvailabilityProbeEnv(), timeoutMs: 60_000 },
  );
  expectExitZero(result, artifactName);
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

async function rebuildWithoutMcpHostSecret(
  host: HostCliClient,
  sandboxName: string,
  artifactPrefix: string,
  envOverlay: NodeJS.ProcessEnv = {},
): Promise<void> {
  const rebuild = await host.nemoclaw([sandboxName, "rebuild", "--yes"], {
    artifactName: `${artifactPrefix}-rebuild-with-provider-backed-mcp`,
    env: {
      ...buildMcpBridgeExactMainEnv({ envOverlay }),
      COMPATIBLE_API_KEY: COMPATIBLE_KEY,
      NEMOCLAW_REBUILD_VERBOSE: "1",
      NVIDIA_INFERENCE_API_KEY: COMPATIBLE_KEY,
    },
    redactionValues: [COMPATIBLE_KEY, HOST_SECRET, ROTATED_HOST_SECRET],
    timeoutMs: 25 * 60_000,
  });
  expectExitZero(rebuild, `${artifactPrefix} rebuild without MCP host secret`);
}

test("mcp-bridge", {
  timeout: 45 * 60_000,
  meta: { e2ePhases: MCP_BRIDGE_PHASES.openclaw },
}, async ({ artifacts, cleanup, host, progress, sandbox }) => {
  await artifacts.writeJson("scenario.json", {
    id: "mcp-bridge",
    sandbox: OPENCLAW_SANDBOX_NAME,
    scope: mcpBridgeE2eScope,
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
    progress,
    server: fakeMcp,
  });
  const decoyMcp = await startFakeMcpHttpsServer({ secret: HOST_SECRET });
  cleanup.add("stop unconfigured decoy MCP HTTPS server", () => decoyMcp.close());
  const decoyMcpTunnel = await startPublicMcpHttpsTunnel({
    cleanup,
    label: "unconfigured decoy MCP HTTPS server",
    progress,
    server: decoyMcp,
  });
  const hostAddress = await hostAddressForSandbox(host);
  const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
  const mcpUrl = fakeMcpTunnel.url;
  const decoyMcpUrl = decoyMcpTunnel.url;
  progress.phase("onboard OpenClaw and prove base policy");
  await onboardAgent(host, sandbox, cleanup, endpointUrl, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    artifactName: "onboard-openclaw-mcp-bridge",
  });
  // Exercise the raw OpenShell `allowed_ips` boundary before any NemoClaw MCP
  // mutation in full-scope topologies. The helper uses a direct curl request
  // with a /** binary grant, then restores this sandbox's exact base policy
  // before returning, so this proof is independent of the CLI and adapter.
  await runFullMcpBridgeE2eCoverage(mcpBridgeE2eScope, () =>
    assertRawOpenShellAllowedIpsRebindingDenied({
      artifacts,
      env: buildAvailabilityProbeEnv(),
      host,
      policySettleMs: 5_000,
      sandbox,
      sandboxName: OPENCLAW_SANDBOX_NAME,
      timeoutMs: 120_000,
    }),
  );

  cleanup.add("remove MCP bridge", () =>
    cleanupMcpBridge(host, OPENCLAW_SANDBOX_NAME, SERVER_NAME, "mcporter"),
  );
  cleanup.add("remove unexpected missing-secret MCP state", () =>
    cleanupMcpBridge(host, OPENCLAW_SANDBOX_NAME, "missingsecret", "mcporter"),
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

  progress.phase("configure bridge and enforce endpoint boundaries");
  await assertConcurrentAddSerialized(host, cleanup, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
    mcpUrl,
    expectedAdapter: "mcporter",
    artifactPrefix: "openclaw",
  });

  const providerName = await addBridgeAndReadStatus(host, sandbox, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
    mcpUrl,
    expectedAdapter: "mcporter",
    artifactPrefix: "openclaw",
  });
  await assertAuthenticatedMcpToolDiscovery(host, fakeMcp, {
    artifacts,
    sandboxName: OPENCLAW_SANDBOX_NAME,
    artifactPrefix: "openclaw",
    hostSecret: HOST_SECRET,
    progress,
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

  const mcporterRequestOffset = fakeMcp.requests.length;
  const mcporterList = await sandbox.execShell(
    OPENCLAW_SANDBOX_NAME,
    trustedSandboxShellScript(
      [
        "set -eu",
        `nemoclaw-start mcporter --root ${shellQuote(OPENCLAW_MCPORTER_ROOT)} list ${SERVER_NAME} --json`,
      ].join("\n"),
    ),
    {
      artifactName: "mcp-mcporter-list-tools",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 90_000,
    },
  );
  expectExitZero(mcporterList, "mcporter lists tools through OpenShell MCP policy");
  expect(resultText(mcporterList)).toContain("fake_echo");
  await assertAuthenticatedMcpDiscovery(fakeMcp, {
    requestOffset: mcporterRequestOffset,
    expectedSecret: HOST_SECRET,
    label: "mcporter authenticated MCP tool discovery",
  });
  expect(fakeMcp.requests.some((request) => request.auth === `Bearer ${HOST_SECRET}`)).toBe(true);
  expect(fakeMcp.requests.every((request) => !request.auth.includes("openshell:resolve:env"))).toBe(
    true,
  );

  const mcpCallScript = MCP_PROVIDER_REWRITE_PROBE_SOURCE;
  await artifacts.writeText("mcp-provider-rewrite-proof.cjs", mcpCallScript);
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
          `nemoclaw-start node - ${shellQuote(targetUrl)} ${shellQuote(method)} ${shellQuote(expectation)} ${shellQuote(credentialKey)} <<'NEMOCLAW_MCP_PROVIDER_REWRITE_PROBE'`,
          mcpCallScript,
          "NEMOCLAW_MCP_PROVIDER_REWRITE_PROBE",
        ].join("\n"),
      ),
      {
        artifactName,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 90_000,
      },
    );

  await runFullMcpBridgeE2eCoverage(mcpBridgeE2eScope, () =>
    assertTrustedPrivateMcpRebindingDenied(host, sandbox, cleanup, {
      adapter: "mcporter",
      artifacts,
      artifactPrefix: "openclaw",
      assertSecretAbsent: assertSecretAbsentFromSandbox,
      cleanupBridge: cleanupMcpBridge,
      mutationTimeoutMs: MCP_MUTATION_TIMEOUT_MS.mcporter,
      sandboxName: OPENCLAW_SANDBOX_NAME,
      secretPaths: ["/sandbox/.openclaw", "/sandbox/.mcp.json"],
      survivingMcpUrl: mcpUrl,
      progress,
    }),
  );

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

  progress.phase("exercise lifecycle and confirm OpenClaw bridge removal");
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

mcpBridgeShardTest("hermes")(
  "mcp-bridge-hermes",
  {
    timeout: 45 * 60_000,
    meta: { e2ePhases: MCP_BRIDGE_PHASES.hermes },
  },
  async ({ artifacts, cleanup, host, progress, sandbox }) => {
    await artifacts.writeJson("scenario.json", {
      id: "mcp-bridge-hermes",
      sandbox: HERMES_SANDBOX_NAME,
      scope: mcpBridgeE2eScope,
      server: SERVER_NAME,
    });
    const hermesResult = `MCP_AUTH_REWRITE_OK::${TOOL_CHALLENGE}`;
    const compatibleMock = await startCompatibleMock({
      apiKey: COMPATIBLE_KEY,
      model: COMPATIBLE_MODEL,
      toolChallenge: TOOL_CHALLENGE,
      toolResultToken: hermesResult,
      toolNames: ["mcp__fake__fake_echo"],
      deferredToolName: "mcp__fake__fake_echo",
    });
    cleanup.add("stop Hermes MCP bridge compatible endpoint mock", () => compatibleMock.close());
    const fakeMcp = await startFakeMcpHttpsServer({
      secret: HOST_SECRET,
      challenge: TOOL_CHALLENGE,
      resultToken: hermesResult,
    });
    const assertHermesToolCall = (artifactName: string) =>
      assertRealAdapterToolCall(sandbox, fakeMcp, {
        agent: "hermes",
        sandboxName: HERMES_SANDBOX_NAME,
        resultToken: hermesResult,
        artifactName,
      });
    cleanup.add("stop fake Hermes MCP HTTPS server", () => fakeMcp.close());
    const fakeMcpTunnel = await startPublicMcpHttpsTunnel({
      cleanup,
      label: "fake Hermes MCP HTTPS server",
      progress,
      server: fakeMcp,
    });
    const hostAddress = await hostAddressForSandbox(host);
    const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
    const mcpUrl = fakeMcpTunnel.url;
    progress.phase("onboard the Hermes MCP sandbox");
    await onboardAgent(host, sandbox, cleanup, endpointUrl, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      artifactName: "onboard-hermes-mcp-bridge",
    });
    cleanup.add("remove Hermes MCP bridge", () =>
      cleanupMcpBridge(host, HERMES_SANDBOX_NAME, SERVER_NAME, "hermes-config"),
    );
    progress.phase("configure and inspect the Hermes MCP bridge");
    await assertConcurrentAddSerialized(host, cleanup, {
      sandboxName: HERMES_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "hermes-config",
      artifactPrefix: "hermes",
    });
    const providerName = await addBridgeAndReadStatus(host, sandbox, {
      sandboxName: HERMES_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "hermes-config",
      artifactPrefix: "hermes",
    });
    const initialDiscoveryRequestOffset = fakeMcp.requests.length;
    const initialDiscoveryObservationOffset = fakeMcp.observations.length;
    await runHermesInitialMcpReadiness({
      discover: () =>
        assertAuthenticatedMcpDiscoveryWithOneRestart(fakeMcp, {
          requestOffset: initialDiscoveryRequestOffset,
          observationOffset: initialDiscoveryObservationOffset,
          expectedSecret: HOST_SECRET,
          label: "Hermes initial MCP discovery",
          artifacts,
          artifactName: "hermes-initial-mcp-discovery-retry-evidence.json",
          restart: async () => {
            progress.event(
              "Hermes initial MCP discovery classified no-request-observed after the initial-discovery offset; restarting once",
            );
            await restartBridgeWithoutHostSecret(
              host,
              HERMES_SANDBOX_NAME,
              "hermes-discovery-retry",
            );
          },
        }),
      inspectToolStatus: () =>
        assertAuthenticatedMcpToolDiscovery(host, fakeMcp, {
          artifacts,
          sandboxName: HERMES_SANDBOX_NAME,
          artifactPrefix: "hermes",
          hostSecret: HOST_SECRET,
          progress,
        }),
      prepareModelTurn: async () => {
        await assertBridgeInfrastructure(host, sandbox, {
          sandboxName: HERMES_SANDBOX_NAME,
          artifactPrefix: "hermes",
          providerName,
          mcpUrl,
        });
        await assertHermesConfig(sandbox, HERMES_SANDBOX_NAME, mcpUrl);
        await assertHermesInspectionRejectsUnmanagedFields(sandbox, HERMES_SANDBOX_NAME);
        await assertSecretAbsentFromSandbox(sandbox, HERMES_SANDBOX_NAME, ["/sandbox/.hermes"]);
        progress.phase("restore Hermes shields, restart, and prove rollback");
        await assertHermesManagedAddSurvivesLockedGatewayRestartAndStateLayout(
          host,
          sandbox,
          HERMES_SANDBOX_NAME,
          mcpUrl,
        );
      },
      runModelTurn: () =>
        assertHermesToolCall("hermes-real-mcp-tool-call-immediately-after-shields-down"),
    });
    await assertHermesReloadRollback(sandbox, HERMES_SANDBOX_NAME, mcpUrl);
    await assertSecretAbsentFromSandbox(
      sandbox,
      HERMES_SANDBOX_NAME,
      ["/sandbox/.hermes", "/tmp/nemoclaw-start.log"],
      [HOST_SECRET],
      "hermes-assert-secret-absent-after-add-gateway-restart",
    );
    progress.phase("exercise lifecycle and confirm Hermes bridge removal");
    const survivingMcp = {
      server: fakeMcp,
      expectedSecret: HOST_SECRET,
      label: "Hermes MCP rediscovery after explicit restart",
    };
    await runFullMcpBridgeE2eCoverage(mcpBridgeE2eScope, () =>
      assertTrustedPrivateMcpRebindingDenied(host, sandbox, cleanup, {
        adapter: "hermes-config",
        artifacts,
        artifactPrefix: "hermes",
        assertSecretAbsent: assertSecretAbsentFromSandbox,
        cleanupBridge: cleanupMcpBridge,
        mutationTimeoutMs: MCP_MUTATION_TIMEOUT_MS["hermes-config"],
        sandboxName: HERMES_SANDBOX_NAME,
        secretPaths: ["/sandbox/.hermes"],
        survivingMcpUrl: mcpUrl,
        progress,
      }),
    );
    await assertHermesToolCall("hermes-real-mcp-tool-call-after-dns-rebinding-remove");
    const survivingDiscoveryOffset = fakeMcp.requests.length;
    await restartBridgeWithoutHostSecret(host, HERMES_SANDBOX_NAME, "hermes");
    await assertHermesToolCall("hermes-real-mcp-tool-call-after-rediscovery-restart");
    await assertAuthenticatedMcpRediscovery(survivingMcp, survivingDiscoveryOffset);
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
    await captureHermesGatewayIdentity(sandbox, "hermes-gateway-identity-before-rebuild");
    await rebuildWithoutMcpHostSecret(host, HERMES_SANDBOX_NAME, "hermes");
    await captureHermesGatewayIdentity(sandbox, "hermes-gateway-identity-after-mcp-restore");
    cleanup.add("lower Hermes Shields before teardown", async () => {
      await lowerHermesShieldsForCleanup(host, HERMES_SANDBOX_NAME);
    });
    cleanup.add("capture Hermes post-rebuild MCP evidence", async () => {
      await artifacts.writeJson(
        "hermes-post-rebuild-mcp-requests.json",
        fakeMcp.requests.slice(rebuildDiscoveryOffset).map((request) => ({
          authenticated: request.auth === `Bearer ${ROTATED_HOST_SECRET}`,
          path: request.path,
          responseHasResult: request.responseHasResult,
          responseStatus: request.responseStatus,
          rpcMethod: request.rpcMethod,
        })),
      );
      await host.nemoclaw([HERMES_SANDBOX_NAME, "shields", "status"], {
        artifactName: "hermes-post-rebuild-shields-status",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 60_000,
      });
      await sandbox.execShell(
        HERMES_SANDBOX_NAME,
        trustedSandboxShellScript(buildHermesMcpRuntimeDiagnosticsScript()),
        {
          artifactName: "hermes-post-rebuild-runtime-diagnostics",
          captureLimitBytes: 32_768,
          env: buildAvailabilityProbeEnv(),
          redactionValues: [HOST_SECRET, ROTATED_HOST_SECRET, COMPATIBLE_KEY, TOOL_CHALLENGE],
          timeoutMs: 60_000,
        },
      );
    });
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
    await reopenHermesMcpMaintenanceWindow(host, HERMES_SANDBOX_NAME);
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

mcpBridgeShardTest("deepagents")(
  "mcp-bridge-deepagents",
  {
    timeout: 45 * 60_000,
    meta: { e2ePhases: MCP_BRIDGE_PHASES.deepagents },
  },
  async ({ artifacts, cleanup, host, lifecycle, progress, sandbox }) => {
    await artifacts.writeJson("scenario.json", {
      id: "mcp-bridge-deepagents",
      sandbox: DEEPAGENTS_SANDBOX_NAME,
      scope: mcpBridgeE2eScope,
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
      progress,
      server: fakeMcp,
    });
    const hostAddress = await hostAddressForSandbox(host);
    const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
    const mcpUrl = fakeMcpTunnel.url;
    const exactMainProof = prepareExactMainMcpProof(
      { artifacts, cleanup, host, lifecycle, sandbox },
      DEEPAGENTS_SANDBOX_NAME,
      mcpUrl,
    );
    progress.phase("onboard the Deep Agents MCP sandbox");
    await onboardAgent(host, sandbox, cleanup, endpointUrl, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactName: "onboard-deepagents-mcp-bridge",
      envOverlay: exactMainProof.envOverlay,
    });
    await exactMainProof.afterOnboard();
    cleanup.add("remove Deep Agents MCP bridge", () =>
      cleanupMcpBridge(host, DEEPAGENTS_SANDBOX_NAME, SERVER_NAME, "deepagents-config"),
    );

    progress.phase("configure and inspect the Deep Agents MCP bridge");
    await assertConcurrentAddSerialized(host, cleanup, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "deepagents-config",
      artifactPrefix: "deepagents",
    });

    const providerName = await addBridgeAndReadStatus(host, sandbox, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "deepagents-config",
      artifactPrefix: "deepagents",
    });
    await assertAuthenticatedMcpToolDiscovery(host, fakeMcp, {
      artifacts,
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactPrefix: "deepagents",
      hostSecret: HOST_SECRET,
      progress,
    });
    await assertBridgeInfrastructure(host, sandbox, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactPrefix: "deepagents",
      providerName,
      mcpUrl,
    });
    await assertDeepAgentsConfig(sandbox, DEEPAGENTS_SANDBOX_NAME, mcpUrl);
    await assertSecretAbsentFromSandbox(sandbox, DEEPAGENTS_SANDBOX_NAME, ["/sandbox/.deepagents"]);
    await runFullMcpBridgeE2eCoverage(mcpBridgeE2eScope, () =>
      assertTrustedPrivateMcpRebindingDenied(host, sandbox, cleanup, {
        adapter: "deepagents-config",
        artifacts,
        artifactPrefix: "deepagents",
        assertSecretAbsent: assertSecretAbsentFromSandbox,
        cleanupBridge: cleanupMcpBridge,
        mutationTimeoutMs: MCP_MUTATION_TIMEOUT_MS["deepagents-config"],
        sandboxName: DEEPAGENTS_SANDBOX_NAME,
        secretPaths: ["/sandbox/.deepagents"],
        survivingMcpUrl: mcpUrl,
        progress,
      }),
    );
    progress.phase("exercise lifecycle and confirm Deep Agents bridge removal");
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-initial",
    });
    await exactMainProof.assertSnapshotResidue("after-initial-tool-call");
    await exactMainProof.assertLogPrivacy([TOOL_CHALLENGE, deepAgentsResult], "fake_echo");
    await restartBridgeWithoutHostSecret(host, DEEPAGENTS_SANDBOX_NAME, "deepagents");
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-after-restart",
    });
    await exactMainProof.assertSnapshotResidue("after-restart-tool-call");
    fakeMcp.setSecret(ROTATED_HOST_SECRET);
    await rotateBridgeCredential(host, DEEPAGENTS_SANDBOX_NAME, "deepagents");
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-after-credential-rotation",
      expectedSecret: ROTATED_HOST_SECRET,
    });
    await exactMainProof.assertSnapshotResidue("after-credential-rotation-tool-call");
    await assertSecretAbsentFromSandbox(
      sandbox,
      DEEPAGENTS_SANDBOX_NAME,
      ["/sandbox/.deepagents"],
      [HOST_SECRET, ROTATED_HOST_SECRET],
      "deepagents-assert-secrets-absent-after-rotation",
    );
    await rebuildWithoutMcpHostSecret(
      host,
      DEEPAGENTS_SANDBOX_NAME,
      "deepagents",
      exactMainProof.envOverlay,
    );
    await exactMainProof.afterRebuild();
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
    await exactMainProof.assertSnapshotResidue("after-rebuild-tool-call");
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
