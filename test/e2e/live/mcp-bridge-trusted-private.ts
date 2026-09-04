// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertExitZero as expectExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect } from "../fixtures/e2e-test.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import {
  assertManagedMcpPolicySurvivedRemoval,
  buildMcpDnsRebindingProbeScript,
  captureManagedMcpPolicy,
  hostPrivateAddressForSandbox,
  isExpectedMcpCurlPolicyDenial,
  type McpDnsRebindingAdapter,
  remapDnsRebindingHostname,
  restoreDnsRebindingHostsFixture,
  setupDnsRebindingHostsFixture,
} from "./mcp-bridge-sandbox.ts";
import { startFakeMcpHttpsServer } from "./mcp-bridge-servers.ts";
import { assertAuthenticatedMcpToolDiscovery } from "./mcp-bridge-tool-discovery.ts";
import { startRoutedPrivateRelay } from "../fixtures/routed-private-relay.ts";

const SERVER_POLICY_KEY = "mcp_bridge_fake";
const REBIND_SERVER_NAME = "rebind";
const REBIND_POLICY_KEY = "mcp_bridge_rebind";
const REBIND_HOSTNAME = "mcp-rebind.example.test";
const REBIND_PUBLIC_IP = "1.1.1.1";
const REBIND_CREDENTIAL_KEY = "REBIND_MCP_SECRET";
const REBIND_HOST_SECRET = MCP_BRIDGE_TEST_CREDENTIALS.rebindHost;

export async function assertTrustedPrivateMcpRebindingDenied(
  host: HostCliClient,
  sandbox: SandboxClient,
  cleanup: CleanupRegistry,
  options: {
    adapter: McpDnsRebindingAdapter;
    artifacts: Pick<ArtifactSink, "writeJson">;
    artifactPrefix: string;
    assertSecretAbsent: (
      sandbox: SandboxClient,
      sandboxName: string,
      paths: string[],
      secrets: string[],
      artifactName: string,
    ) => Promise<void>;
    cleanupBridge: (
      host: HostCliClient,
      sandboxName: string,
      server: string,
      adapter: McpDnsRebindingAdapter,
    ) => Promise<void>;
    mutationTimeoutMs: number;
    progress: Parameters<typeof assertAuthenticatedMcpToolDiscovery>[2]["progress"];
    sandboxName: string;
    secretPaths: string[];
    survivingMcpUrl: string;
  },
): Promise<void> {
  const rebindMcp = await startFakeMcpHttpsServer({ secret: REBIND_HOST_SECRET });
  cleanup.add(`stop ${options.artifactPrefix} trusted-private fake MCP HTTPS server`, () =>
    rebindMcp.close(),
  );
  cleanup.add(`remove ${options.artifactPrefix} trusted-private MCP bridge`, () =>
    options.cleanupBridge(host, options.sandboxName, REBIND_SERVER_NAME, options.adapter),
  );
  const upstreamHost = await hostPrivateAddressForSandbox(host);
  const relay = await startRoutedPrivateRelay({
    host,
    sandboxName: options.sandboxName,
    upstreamHost,
    upstreamPort: rebindMcp.port,
  });
  cleanup.add(`stop ${options.artifactPrefix} trusted-private MCP relay`, relay.close);
  const rebindMcpUrl = `https://${REBIND_HOSTNAME}:${String(relay.port)}/mcp`;
  const hostsFixture = await setupDnsRebindingHostsFixture(
    host,
    options.sandboxName,
    REBIND_HOSTNAME,
  );
  cleanup.add(`restore ${options.artifactPrefix} DNS rebinding hosts fixture`, () =>
    restoreDnsRebindingHostsFixture(host, options.sandboxName, hostsFixture),
  );
  const survivingPolicyBeforeAddResult = await captureManagedMcpPolicy(sandbox, {
    artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-surviving-policy-before-add`,
    label: `${options.artifactPrefix} captures the surviving MCP policy before adding the rebinding route`,
    policyKey: SERVER_POLICY_KEY,
    sandboxName: options.sandboxName,
    url: options.survivingMcpUrl,
  });
  const survivingPolicyBeforeAdd = survivingPolicyBeforeAddResult.policy;
  const trustedPrivateAddress = relay.address;
  expect(trustedPrivateAddress).not.toBe(REBIND_PUBLIC_IP);
  await remapDnsRebindingHostname(
    host,
    options.sandboxName,
    hostsFixture,
    trustedPrivateAddress,
    `${options.artifactPrefix}-mcp-trusted-private-map-before-add`,
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
      "--trusted-private-host",
      REBIND_HOSTNAME,
    ],
    {
      artifactName: `${options.artifactPrefix}-mcp-trusted-private-add`,
      env: {
        ...buildAvailabilityProbeEnv(),
        [REBIND_CREDENTIAL_KEY]: REBIND_HOST_SECRET,
      },
      redactionValues: [REBIND_HOST_SECRET],
      timeoutMs: options.mutationTimeoutMs,
    },
  );
  expectExitZero(
    add,
    `${options.artifactPrefix} registers a routed-private MCP endpoint with explicit trust`,
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
  expectExitZero(status, `${options.artifactPrefix} inspects trusted-private route after add`);
  expect(JSON.parse(status.stdout)).toMatchObject({
    support: { supported: true, adapter: options.adapter },
    server: REBIND_SERVER_NAME,
    url: rebindMcpUrl,
    env: { names: [REBIND_CREDENTIAL_KEY], ready: true, missing: [] },
    provider: { attached: true, credentialReady: true },
    policy: { gatewayPresent: true },
    adapter: { registered: true },
    trustedPrivateTarget: {
      host: REBIND_HOSTNAME,
      recordedPins: [trustedPrivateAddress],
      currentPins: [trustedPrivateAddress],
      state: "match",
    },
  });
  const rebindingPolicy = await captureManagedMcpPolicy(sandbox, {
    artifactName: `${options.artifactPrefix}-mcp-trusted-private-policy-pinned-address`,
    label: `${options.artifactPrefix} validates the trusted-private add-time DNS pin`,
    policyKey: REBIND_POLICY_KEY,
    sandboxName: options.sandboxName,
    url: rebindMcpUrl,
  });
  expect(rebindingPolicy.policy.endpoints?.[0]).toMatchObject({
    host: REBIND_HOSTNAME,
    allowed_ips: [trustedPrivateAddress],
  });
  await options.assertSecretAbsent(
    sandbox,
    options.sandboxName,
    options.secretPaths,
    [REBIND_HOST_SECRET],
    `${options.artifactPrefix}-dns-rebinding-secret-absent-from-sandbox`,
  );
  await assertAuthenticatedMcpToolDiscovery(host, rebindMcp, {
    artifacts: options.artifacts,
    sandboxName: options.sandboxName,
    artifactPrefix: `${options.artifactPrefix}-trusted-private`,
    credentialKey: REBIND_CREDENTIAL_KEY,
    hostSecret: REBIND_HOST_SECRET,
    progress: options.progress,
    serverName: REBIND_SERVER_NAME,
  });
  const requestsBeforeRebindingDenial = rebindMcp.requests.length;

  // OpenShell must retain the exact private address admitted at add time. A
  // later DNS answer outside that set is drift for status and a hard denial
  // for every adapter runtime identity.
  await remapDnsRebindingHostname(
    host,
    options.sandboxName,
    hostsFixture,
    REBIND_PUBLIC_IP,
    `${options.artifactPrefix}-mcp-trusted-private-map-public-unpinned-after-add`,
  );
  const driftStatus = await host.nemoclaw(
    [options.sandboxName, "mcp", "status", REBIND_SERVER_NAME, "--json"],
    {
      artifactName: `${options.artifactPrefix}-mcp-trusted-private-status-drift`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(driftStatus, `${options.artifactPrefix} reports trusted-private pin drift`);
  const driftInspection = JSON.parse(driftStatus.stdout);
  expect(driftInspection).toMatchObject({
    trustedPrivateTarget: {
      host: REBIND_HOSTNAME,
      recordedPins: [trustedPrivateAddress],
      state: "drift",
      detail: expect.stringContaining("did not resolve to supported routed private addresses"),
    },
  });
  expect(driftInspection.trustedPrivateTarget.currentPins).toBeUndefined();
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
    rebindMcp.requests.length,
    `${options.artifactPrefix} rebound request must not reach the upstream MCP server`,
  ).toBe(requestsBeforeRebindingDenial);

  // Restore before removal can reload policy and restart the sandbox.
  await restoreDnsRebindingHostsFixture(host, options.sandboxName, hostsFixture);
  const remove = await host.nemoclaw([options.sandboxName, "mcp", "remove", REBIND_SERVER_NAME], {
    artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-remove`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: options.mutationTimeoutMs,
  });
  expectExitZero(remove, `${options.artifactPrefix} removes DNS rebinding route after proof`);
  const survivingPolicyAfterRemoveResult = await captureManagedMcpPolicy(sandbox, {
    artifactName: `${options.artifactPrefix}-mcp-dns-rebinding-surviving-policy-after-remove`,
    label: `${options.artifactPrefix} inspects MCP policy after removing the rebinding route`,
    policyKey: SERVER_POLICY_KEY,
    sandboxName: options.sandboxName,
    url: options.survivingMcpUrl,
  });
  assertManagedMcpPolicySurvivedRemoval(
    survivingPolicyBeforeAdd,
    survivingPolicyAfterRemoveResult,
    REBIND_POLICY_KEY,
  );
}
