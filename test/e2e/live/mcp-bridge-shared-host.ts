// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dns from "node:dns/promises";
import fs from "node:fs";
import path from "node:path";
import { expect } from "vitest";

import type { ArtifactSink } from "../fixtures/artifacts.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import { assertCleanupSucceededOrAbsent } from "../fixtures/cleanup-resources.ts";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { assertExitZero } from "../fixtures/clients/command.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import type { SandboxClient } from "../fixtures/clients/sandbox.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import type { TestProgress } from "../fixtures/progress.ts";
import { buildMcpBridgePolicyKey } from "../../../src/lib/actions/sandbox/mcp-bridge-policy-render";
import { cleanupMcpBridge, type McpAdapter } from "./mcp-bridge-cleanup.ts";
import { approveOpenClawAdminScope } from "./openclaw-admin-scope.ts";
import { addBridgeAndReadStatus, runMcpProviderRewriteProbe } from "./mcp-bridge-reliability.ts";
import { captureManagedMcpPolicy, expectExitNonZero } from "./mcp-bridge-sandbox.ts";
import { startFakeMcpHttpsServer, startPublicMcpHttpsTunnel } from "./mcp-bridge-servers.ts";

type Address = { address: string; family: number };

/** Control a CLI process's DNS input without replacing policy or provider operations. */
export async function withMcpDnsAnswers<T>(
  hostname: string,
  addresses: readonly Address[],
  run: (nodeOptions: string) => Promise<T>,
): Promise<T> {
  const scratch = path.resolve(".ws-tmp", "tmp");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(scratch, "mcp-shared-host-dns-"));
  const preload = path.join(directory, "lookup.cjs");
  const observed = path.join(directory, "observed.json");
  const callbackPreload = path.join(directory, "callback.cjs");
  try {
    fs.writeFileSync(
      preload,
      `
const promises = require("node:dns/promises");
const childProcess = require("node:child_process");
const originalPromisesLookup = promises.lookup;
const originalExecFile = childProcess.execFile;
const target = ${JSON.stringify(hostname)};
const answers = ${JSON.stringify(addresses)};
function selectedAnswers() {
  require("node:fs").writeFileSync(${JSON.stringify(observed)}, JSON.stringify(answers));
  return answers.map(answer => ({ ...answer }));
}
promises.lookup = async (hostname, options) => {
  if (hostname !== target || options?.all !== true) {
    return originalPromisesLookup.call(promises, hostname, options);
  }
  return selectedAnswers();
};
// Status clears loader environment variables. Load only this fixture explicitly in its DNS child.
childProcess.execFile = function(file, args, ...rest) {
  const options = rest[0];
  const boundedLookup = file === process.execPath && Array.isArray(args) && args.length === 4 &&
    args[0] === "-e" && args[1].includes('require("node:dns").lookup(') &&
    args[2] === "--" && args[3] === target &&
    options?.env?.NODE_OPTIONS === "" && options?.env?.NODE_PATH === "";
  return originalExecFile.call(this, file,
    boundedLookup ? ["--require", ${JSON.stringify(callbackPreload)}, ...args] : args, ...rest);
};
module.exports = selectedAnswers;
`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      callbackPreload,
      // Only the recognized, host-bound resolver child loads this callback fixture.
      `const answers = require(${JSON.stringify(preload)});
require("node:dns").lookup = (_hostname, _options, callback) => {
  queueMicrotask(() => callback(null, answers()));
};
`,
      { mode: 0o600 },
    );
    const result = await run(`--require=${JSON.stringify(preload)}`);
    // An unused preload cannot establish that the CLI command saw the intended DNS input.
    if (fs.readFileSync(observed, "utf8") !== JSON.stringify(addresses)) {
      throw new Error("MCP command did not consume the controlled DNS answers");
    }
    return result;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function assertSharedHostMcpComposition(options: {
  adapter: McpAdapter;
  host: HostCliClient;
  sandbox: SandboxClient;
  cleanup: CleanupRegistry;
  artifacts: ArtifactSink;
  progress: TestProgress;
  sandboxName: string;
}): Promise<void> {
  const { adapter, host, sandbox, cleanup, artifacts, progress, sandboxName } = options;
  if (adapter === "openclaw-config") {
    await approveOpenClawAdminScope(host, sandbox, sandboxName, buildAvailabilityProbeEnv(), [
      MCP_BRIDGE_TEST_CREDENTIALS.compatibleEndpoint,
      MCP_BRIDGE_TEST_CREDENTIALS.host,
    ]);
  }
  const endpoint = await startFakeMcpHttpsServer({
    secret: MCP_BRIDGE_TEST_CREDENTIALS.host,
    additionalPaths: { "/mcp-peer": MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost },
  });
  cleanup.add("stop shared-host MCP endpoint", () => endpoint.close());
  const tunnel = await startPublicMcpHttpsTunnel({
    cleanup,
    progress,
    server: endpoint,
    label: "shared-host MCP",
  });
  const hostname = new URL(tunnel.origin).hostname;
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  const answers = [
    ...new Map(
      resolved.map((answer) => [
        answer.address.toLowerCase(),
        { ...answer, address: answer.address.toLowerCase() },
      ]),
    ).values(),
  ].sort((a, b) => a.address.localeCompare(b.address));
  if (answers.length < 2)
    throw new Error("Shared-host MCP fixture requires multiple public DNS answers");
  const firstPins = answers.map((answer) => answer.address).sort();
  const entries = [
    {
      server: "shared-one",
      pathname: "/mcp",
      key: "SHARED_ONE_MCP_SECRET",
      secret: MCP_BRIDGE_TEST_CREDENTIALS.host,
      answers,
    },
    {
      server: "shared-two",
      pathname: "/mcp-peer",
      key: "SHARED_TWO_MCP_SECRET",
      secret: MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost,
      answers: answers.slice(1),
    },
  ];
  await artifacts.writeJson(
    "mcp-shared-host-dns-answers.json",
    entries.map(({ server, answers }) => ({ server, answers })),
  );
  const remove = entries.map((entry) => {
    let complete = false;
    const provider = `${sandboxName}-mcp-${entry.server}`;
    const run = async () => {
      if (complete) return;
      await cleanupMcpBridge(host, sandboxName, entry.server, adapter);
      const deleted = await host.command(
        host.openshellCommandPath,
        ["provider", "delete", provider],
        {
          env: buildAvailabilityProbeEnv(),
          artifactName: `shared-host-delete-${entry.server}`,
          timeoutMs: 60_000,
        },
      );
      assertCleanupSucceededOrAbsent(
        deleted,
        /provider[^\n]*(?:not found|does not exist)|NOT_FOUND/iu,
        `remove owned shared-host provider ${provider}`,
      );
      complete = true;
    };
    cleanup.add(`remove shared-host MCP registration and provider ${entry.server}`, run);
    return run;
  });
  await withMcpDnsAnswers(hostname, answers, async (statusNodeOptions) => {
    for (const entry of entries) {
      await withMcpDnsAnswers(hostname, entry.answers, (addNodeOptions) =>
        addBridgeAndReadStatus(host, sandbox, {
          sandboxName,
          mcpUrl: `${tunnel.origin}${entry.pathname}`,
          expectedAdapter: adapter,
          artifactPrefix: entry.server,
          serverName: entry.server,
          credentialEnvName: entry.key,
          credential: entry.secret,
          applyHostPolicyEdit: false,
          addNodeOptions,
          statusNodeOptions,
        }),
      );
    }
  });
  for (const entry of entries) {
    const captured = await captureManagedMcpPolicy(sandbox, {
      sandboxName,
      url: `${tunnel.origin}${entry.pathname}`,
      policyKey: buildMcpBridgePolicyKey(entry.server),
      artifactName: `${entry.server}-effective-pins`,
      label: "shared-host effective pins",
    });
    expect(captured.policy.endpoints?.[0]?.allowed_ips).toEqual(firstPins);
    const requestOffset = endpoint.requests.length;
    const accepted = await runMcpProviderRewriteProbe(
      sandbox,
      sandboxName,
      `${tunnel.origin}${entry.pathname}`,
      "tools/list",
      "allow",
      `${entry.server}-authenticated`,
      entry.key,
      undefined,
      adapter,
    );
    assertExitZero(accepted, `${entry.server} authenticated request after both adds`);
    const observed = endpoint.requests
      .slice(requestOffset)
      .filter((request) => request.path === entry.pathname);
    expect(observed.length).toBeGreaterThan(0);
    expect(
      observed.every(
        (request) => request.auth === `Bearer ${entry.secret}` && request.responseStatus === 200,
      ),
    ).toBe(true);
  }
  const requestOffset = endpoint.requests.length;
  for (const [index, entry] of entries.entries()) {
    const peer = entries[1 - index];
    const peerRequestOffset = endpoint.requests.length;
    const withheld = await runMcpProviderRewriteProbe(
      sandbox,
      sandboxName,
      `${tunnel.origin}${peer.pathname}`,
      "tools/list",
      "withhold",
      `${entry.server}-credential-at-${peer.server}`,
      entry.key,
      undefined,
      adapter,
    );
    assertExitZero(withheld, `${entry.server} credential cannot authorize ${peer.server}`);
    const peerRequests = endpoint.requests
      .slice(peerRequestOffset)
      .filter((request) => request.path === peer.pathname);
    expect(
      peerRequests.every(
        (request) => !request.auth.includes(entry.secret) && request.responseStatus === 401,
      ),
    ).toBe(true);
    const denied = await runMcpProviderRewriteProbe(
      sandbox,
      sandboxName,
      `${tunnel.origin}/unconfigured`,
      "tools/list",
      "deny-strict",
      `${entry.server}-outside-binding`,
      entry.key,
      undefined,
      adapter,
    );
    assertExitZero(denied, `${entry.server} credential cannot reach an unconfigured path`);
  }
  expect(
    endpoint.requests.slice(requestOffset).filter((request) => request.path === "/unconfigured"),
  ).toHaveLength(0);
  for (const run of remove) await run();
  const list = await host.nemoclaw([sandboxName, "mcp", "list", "--json"], {
    env: buildAvailabilityProbeEnv(),
    artifactName: "shared-host-registrations-removed",
    timeoutMs: 60_000,
  });
  assertExitZero(list, "list registrations after shared-host cleanup");
  const names = (JSON.parse(list.stdout).bridges as Array<{ server: string }>).map(
    (entry) => entry.server,
  );
  expect(names.filter((name) => entries.some((entry) => entry.server === name))).toEqual([]);
  for (const entry of entries) {
    const absent = await host.command(
      host.openshellCommandPath,
      ["provider", "get", `${sandboxName}-mcp-${entry.server}`],
      {
        env: buildAvailabilityProbeEnv(),
        artifactName: `${entry.server}-provider-absent`,
        timeoutMs: 60_000,
      },
    );
    expectExitNonZero(
      absent,
      "shared-host provider removed",
      /not found|does not exist|NOT_FOUND/iu,
    );
  }
}

/** Keep the existing different-host credential case beside the same-host composition case. */
export async function addDistinctCredentialMcpEndpoint(options: {
  host: HostCliClient;
  sandbox: SandboxClient;
  cleanup: CleanupRegistry;
  progress: TestProgress;
  sandboxName: string;
  serverOptions: Parameters<typeof startFakeMcpHttpsServer>[0];
}) {
  const { host, sandbox, cleanup, progress, sandboxName, serverOptions } = options;
  const endpoint = await startFakeMcpHttpsServer(serverOptions);
  cleanup.add("stop distinct MCP HTTPS server", () => endpoint.close());
  const tunnel = await startPublicMcpHttpsTunnel({
    cleanup,
    label: "distinct credential MCP HTTPS server",
    progress,
    server: endpoint,
  });
  cleanup.add("remove distinct credential bridge", () =>
    cleanupMcpBridge(host, sandboxName, "distinct", "openclaw-config"),
  );
  await addBridgeAndReadStatus(host, sandbox, {
    sandboxName,
    mcpUrl: tunnel.url,
    expectedAdapter: "openclaw-config",
    serverName: "distinct",
    credentialEnvName: "DISTINCT_MCP_SECRET",
    credential: serverOptions.secret,
    artifactPrefix: "openclaw-distinct",
    applyHostPolicyEdit: false,
  });
  return { endpoint, tunnel };
}
