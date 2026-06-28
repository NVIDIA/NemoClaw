// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { shellQuote } from "../../../src/lib/core/shell-quote";
import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import type { CleanupRegistry } from "../fixtures/cleanup.ts";
import type { HostCliClient } from "../fixtures/clients/host.ts";
import { type SandboxClient, trustedSandboxShellScript } from "../fixtures/clients/sandbox.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { installMcpTestCaInSandbox } from "./mcp-bridge-sandbox.ts";
import { startCompatibleMock, startFakeMcpHttpsServer } from "./mcp-bridge-servers.ts";

const OPENCLAW_SANDBOX_NAME = process.env.NEMOCLAW_SANDBOX_NAME ?? "e2e-mcp-bridge";
const HERMES_SANDBOX_NAME = process.env.NEMOCLAW_MCP_HERMES_SANDBOX_NAME ?? "e2e-mcp-hermes";
const DEEPAGENTS_SANDBOX_NAME = process.env.NEMOCLAW_MCP_DEEPAGENTS_SANDBOX_NAME ?? "e2e-mcp-dcode";
const SERVER_NAME = "fake";
const HOST_SECRET = "fake-host-mcp-secret-value";
const COMPATIBLE_KEY = "fake-compatible-mcp-bridge-key";
const COMPATIBLE_MODEL = "mock/mcp-bridge";
const TOOL_CHALLENGE = "nemoclaw-authenticated-mcp-proof";
const REGISTRY_FILE = path.join(process.env.HOME ?? os.homedir(), ".nemoclaw", "sandboxes.json");
const liveTest = process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" ? test : test.skip;
const liveAgentMatrixTest =
  process.env.NEMOCLAW_RUN_E2E_SCENARIOS === "1" &&
  process.env.NEMOCLAW_MCP_BRIDGE_AGENT_MATRIX === "1"
    ? test
    : test.skip;

type McpAgent = "openclaw" | "hermes" | "langchain-deepagents-code";
type McpAdapter = "mcporter" | "hermes-config" | "deepagents-config";

function resultText(result: ShellProbeResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function expectExitZero(result: ShellProbeResult, label: string): void {
  expect(result.exitCode, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
}

function expectExitNonZero(result: ShellProbeResult, label: string, pattern: RegExp): void {
  expect(
    result.exitCode,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).not.toBe(0);
  expect(resultText(result)).toMatch(pattern);
}

async function hostAddressForSandbox(host: HostCliClient): Promise<string> {
  const probe = await host.command(
    "bash",
    [
      "-lc",
      [
        'ip_addr="$(ip route get 1.1.1.1 2>/dev/null | awk \'{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}\')"',
        'if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        "ip_addr=\"$(hostname -I 2>/dev/null | awk '{print $1}')\"",
        'if [ -n "$ip_addr" ]; then echo "$ip_addr"; exit 0; fi',
        "echo 127.0.0.1",
      ].join("\n"),
    ],
    {
      artifactName: "host-ip-for-mcp-compatible-endpoint",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 30_000,
    },
  );
  return probe.stdout.trim().split(/\s+/)[0] || "127.0.0.1";
}

async function bestEffortRemoveBridge(host: HostCliClient, sandboxName: string): Promise<void> {
  await host.nemoclaw([sandboxName, "mcp", "remove", SERVER_NAME, "--force"], {
    artifactName: "cleanup-mcp-remove",
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
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
  await host.bestEffortCleanupSandbox(options.sandboxName, {
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
): Promise<void> {
  const result = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      ["set -eu", `! grep -R ${JSON.stringify(HOST_SECRET)} ${paths.join(" ")} 2>/dev/null`].join(
        "\n",
      ),
    ),
    {
      artifactName: "assert-secret-absent-from-sandbox",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, "host MCP secret must not appear in sandbox files");
}

async function addBridgeAndReadStatus(
  host: HostCliClient,
  options: {
    sandboxName: string;
    mcpUrl: string;
    expectedAdapter: McpAdapter;
    artifactPrefix: string;
  },
): Promise<void> {
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
      timeoutMs: 2 * 60_000,
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
  expect(status.stdout).not.toContain(HOST_SECRET);
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
  options: { sandboxName: string; artifactPrefix: string },
): Promise<void> {
  const policy = await sandbox.openshell(["policy", "get", "--full", options.sandboxName], {
    artifactName: `${options.artifactPrefix}-openshell-policy-get-mcp`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(policy, `${options.artifactPrefix} openshell policy get --full`);
  expect(resultText(policy)).toContain("mcp-bridge-fake");
  expect(resultText(policy)).toContain("protocol: mcp");
  expect(resultText(policy)).toContain("tls: require");
  expect(resultText(policy)).toContain("credential_keys");
  expect(resultText(policy)).toContain("FAKE_MCP_SECRET");
  expect(resultText(policy)).toContain("strict_tool_names");
  expect(resultText(policy)).toContain("method: tools/list");
  expect(resultText(policy)).toContain("method: tools/call");
  expect(resultText(policy)).toContain("host.openshell.internal");

  const provider = await host.command(
    "openshell",
    ["provider", "get", `${options.sandboxName}-mcp-fake`],
    {
      artifactName: `${options.artifactPrefix}-openshell-provider-get-mcp`,
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(provider, `${options.artifactPrefix} openshell provider get mcp provider`);
  expect(resultText(provider)).toContain("FAKE_MCP_SECRET");
  expect(resultText(provider)).not.toContain(HOST_SECRET);
}

async function removeBridgeAndAssertEmpty(
  host: HostCliClient,
  options: { sandboxName: string; artifactPrefix: string },
): Promise<void> {
  const remove = await host.nemoclaw([options.sandboxName, "mcp", "remove", SERVER_NAME], {
    artifactName: `${options.artifactPrefix}-mcp-remove-fake-server`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(remove, `${options.artifactPrefix} mcp remove fake server`);

  const list = await host.nemoclaw([options.sandboxName, "mcp", "list", "--json"], {
    artifactName: `${options.artifactPrefix}-mcp-list-after-remove`,
    env: buildAvailabilityProbeEnv(),
    timeoutMs: 60_000,
  });
  expectExitZero(list, `${options.artifactPrefix} mcp list after remove`);
  expect(JSON.parse(list.stdout).bridges).toEqual([]);
}

async function assertHermesConfig(
  sandbox: SandboxClient,
  sandboxName: string,
  mcpUrl: string,
): Promise<void> {
  const result = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -eu",
        "/opt/hermes/.venv/bin/python - <<'PY'",
        "import pathlib, yaml",
        "path = pathlib.Path('/sandbox/.hermes/config.yaml')",
        "text = path.read_text(encoding='utf-8')",
        "data = yaml.safe_load(text) or {}",
        `entry = data['mcp_servers'][${JSON.stringify(SERVER_NAME)}]`,
        `assert entry['url'] == ${JSON.stringify(mcpUrl)}`,
        "assert entry['headers']['Authorization'] == 'Bearer openshell:resolve:env:FAKE_MCP_SECRET'",
        `assert ${JSON.stringify(HOST_SECRET)} not in text`,
        "PY",
      ].join("\n"),
    ),
    {
      artifactName: "hermes-mcp-config-assertions",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(result, "Hermes MCP config contains placeholder and no raw host secret");
}

async function assertDeepAgentsConfig(
  sandbox: SandboxClient,
  sandboxName: string,
  mcpUrl: string,
): Promise<void> {
  const result = await sandbox.execShell(
    sandboxName,
    trustedSandboxShellScript(
      [
        "set -eu",
        "python3 - <<'PY'",
        "import json, pathlib",
        "path = pathlib.Path('/sandbox/.deepagents/.mcp.json')",
        "text = path.read_text(encoding='utf-8')",
        "data = json.loads(text)",
        `entry = data['mcpServers'][${JSON.stringify(SERVER_NAME)}]`,
        "assert entry['type'] == 'http'",
        `assert entry['url'] == ${JSON.stringify(mcpUrl)}`,
        "assert entry['headers']['Authorization'] == 'Bearer openshell:resolve:env:FAKE_MCP_SECRET'",
        `assert ${JSON.stringify(HOST_SECRET)} not in text`,
        "PY",
      ].join("\n"),
    ),
    {
      artifactName: "deepagents-mcp-config-assertions",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
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
    auth: `Bearer ${HOST_SECRET}`,
    path: "/mcp",
  });
  expect(calls.at(-1)?.auth).not.toContain("openshell:resolve:env");
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
    redactionValues: [COMPATIBLE_KEY, HOST_SECRET],
    timeoutMs: 25 * 60_000,
  });
  expectExitZero(rebuild, `${artifactPrefix} rebuild without MCP host secret`);
}

liveTest("mcp-bridge", { timeout: 45 * 60_000 }, async ({ artifacts, cleanup, host, sandbox }) => {
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
  const decoyMcp = await startFakeMcpHttpsServer({ secret: HOST_SECRET });
  cleanup.add("stop unconfigured decoy MCP HTTPS server", () => decoyMcp.close());
  const hostAddress = await hostAddressForSandbox(host);
  const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
  const mcpUrl = `https://host.openshell.internal:${fakeMcp.port}/mcp`;
  const decoyMcpUrl = `https://host.openshell.internal:${decoyMcp.port}/mcp`;
  await onboardAgent(host, cleanup, endpointUrl, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    artifactName: "onboard-openclaw-mcp-bridge",
  });
  await installMcpTestCaInSandbox(host, sandbox, OPENCLAW_SANDBOX_NAME, "openclaw");
  cleanup.add("remove MCP bridge", () => bestEffortRemoveBridge(host, OPENCLAW_SANDBOX_NAME));

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

  await addBridgeAndReadStatus(host, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
    mcpUrl,
    expectedAdapter: "mcporter",
    artifactPrefix: "openclaw",
  });
  await assertBridgeInfrastructure(host, sandbox, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
    artifactPrefix: "openclaw",
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

  const mcpCallScript = `const http = require("node:http");
const https = require("node:https");
const url = new URL(process.argv[2]);
const transport = url.protocol === "https:" ? https : http;
const method = process.argv[3];
const expectation = process.argv[4];
const hostOverride = process.argv[5] || undefined;
const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method });
const req = transport.request({
  hostname: url.hostname,
  port: url.port,
  path: url.pathname + url.search,
  method: "POST",
  ...(hostOverride === "__missing__" ? { setHost: false } : {}),
  headers: {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "authorization": "Bearer openshell:resolve:env:FAKE_MCP_SECRET",
    ...(hostOverride && hostOverride !== "__missing__" ? { host: hostOverride } : {})
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
  process.exit(expectation === "deny" ? 0 : 1);
});
req.end(body);
`;
  await artifacts.writeText("mcp-provider-rewrite-proof.cjs", mcpCallScript);
  const mcpCallScriptB64 = Buffer.from(mcpCallScript, "utf8").toString("base64");
  const runNodeMcpProbe = async (
    targetUrl: string,
    method: string,
    expectation: "allow" | "deny",
    artifactName: string,
    hostOverride?: string,
  ): Promise<ShellProbeResult> =>
    sandbox.execShell(
      OPENCLAW_SANDBOX_NAME,
      trustedSandboxShellScript(
        [
          "set -eu",
          `printf '%s' ${JSON.stringify(mcpCallScriptB64)} | base64 -d > /tmp/nemoclaw-mcp-provider-rewrite-proof.cjs`,
          `nemoclaw-start node /tmp/nemoclaw-mcp-provider-rewrite-proof.cjs ${JSON.stringify(targetUrl)} ${JSON.stringify(method)} ${expectation}${hostOverride ? ` ${JSON.stringify(hostOverride)}` : ""}`,
        ].join("\n"),
      ),
      {
        artifactName,
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 90_000,
      },
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

  const deniedPlaintextCall = await runNodeMcpProbe(
    mcpUrl.replace(/^https:/, "http:"),
    "tools/list",
    "deny",
    "mcp-provider-rewrite-plaintext-downgrade-denied",
  );
  expectExitZero(
    deniedPlaintextCall,
    "allowed Node runtime cannot downgrade an authenticated MCP request to plaintext",
  );
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const deniedQueryCall = await runNodeMcpProbe(
    `${mcpUrl}?route=alternate`,
    "tools/list",
    "deny",
    "mcp-provider-rewrite-query-drift-denied",
  );
  expectExitZero(deniedQueryCall, "allowed Node runtime cannot add a query before replacement");
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const deniedHostMismatchCall = await runNodeMcpProbe(
    mcpUrl,
    "tools/list",
    "deny",
    "mcp-provider-rewrite-host-mismatch-denied",
    "alternate.invalid",
  );
  expectExitZero(
    deniedHostMismatchCall,
    "allowed Node runtime cannot route a rewritten credential to another HTTP Host",
  );
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const deniedMissingHostCall = await runNodeMcpProbe(
    mcpUrl,
    "tools/list",
    "deny",
    "mcp-provider-rewrite-missing-host-denied",
    "__missing__",
  );
  expectExitZero(
    deniedMissingHostCall,
    "allowed Node runtime cannot trigger replacement without an HTTP Host",
  );
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
        `code="$(curl -sS -o /tmp/nemoclaw-mcp-denied.out -w '%{http_code}' -X POST ${JSON.stringify(mcpUrl)} -H 'content-type: application/json' -H 'authorization: Bearer openshell:resolve:env:FAKE_MCP_SECRET' --data "$body")"`,
        'if [ "$code" != "403" ]; then',
        "  cat /tmp/nemoclaw-mcp-denied.out",
        '  echo "expected OpenShell 403, got $code" >&2',
        "  exit 1",
        "fi",
        "cat /tmp/nemoclaw-mcp-denied.out 2>/dev/null || true",
      ].join("\n"),
    ),
    {
      artifactName: "mcp-non-allowlisted-binary-curl-denied",
      env: buildAvailabilityProbeEnv(),
      timeoutMs: 60_000,
    },
  );
  expectExitZero(deniedCurl, "non-allowlisted curl cannot call the MCP endpoint");
  expect(fakeMcp.requests.length).toBe(requestCountAfterAllowedNodeProof);

  const registryRaw = fs.existsSync(REGISTRY_FILE) ? fs.readFileSync(REGISTRY_FILE, "utf8") : "";
  expect(registryRaw).toContain(mcpUrl);
  expect(registryRaw).toContain(`${OPENCLAW_SANDBOX_NAME}-mcp-fake`);
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
  await rebuildWithoutMcpHostSecret(host, OPENCLAW_SANDBOX_NAME, "openclaw");
  await installMcpTestCaInSandbox(host, sandbox, OPENCLAW_SANDBOX_NAME, "openclaw-rebuild");
  await assertRealAdapterToolCall(sandbox, fakeMcp, {
    agent: "openclaw",
    sandboxName: OPENCLAW_SANDBOX_NAME,
    resultToken: openClawResult,
    artifactName: "openclaw-real-mcp-tool-call-after-rebuild",
  });

  await removeBridgeAndAssertEmpty(host, {
    sandboxName: OPENCLAW_SANDBOX_NAME,
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
    });
    cleanup.add("stop Hermes MCP bridge compatible endpoint mock", () => compatibleMock.close());
    const fakeMcp = await startFakeMcpHttpsServer({
      secret: HOST_SECRET,
      challenge: TOOL_CHALLENGE,
      resultToken: hermesResult,
    });
    cleanup.add("stop fake Hermes MCP HTTPS server", () => fakeMcp.close());
    const hostAddress = await hostAddressForSandbox(host);
    const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
    const mcpUrl = `https://host.openshell.internal:${fakeMcp.port}/mcp`;
    await onboardAgent(host, cleanup, endpointUrl, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      artifactName: "onboard-hermes-mcp-bridge",
    });
    await installMcpTestCaInSandbox(host, sandbox, HERMES_SANDBOX_NAME, "hermes");
    cleanup.add("remove Hermes MCP bridge", () =>
      bestEffortRemoveBridge(host, HERMES_SANDBOX_NAME),
    );

    await addBridgeAndReadStatus(host, {
      sandboxName: HERMES_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "hermes-config",
      artifactPrefix: "hermes",
    });
    await assertBridgeInfrastructure(host, sandbox, {
      sandboxName: HERMES_SANDBOX_NAME,
      artifactPrefix: "hermes",
    });
    await assertHermesConfig(sandbox, HERMES_SANDBOX_NAME, mcpUrl);
    await assertSecretAbsentFromSandbox(sandbox, HERMES_SANDBOX_NAME, ["/sandbox/.hermes"]);
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
    await rebuildWithoutMcpHostSecret(host, HERMES_SANDBOX_NAME, "hermes");
    await installMcpTestCaInSandbox(host, sandbox, HERMES_SANDBOX_NAME, "hermes-rebuild");
    await assertHermesConfig(sandbox, HERMES_SANDBOX_NAME, mcpUrl);
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "hermes",
      sandboxName: HERMES_SANDBOX_NAME,
      resultToken: hermesResult,
      artifactName: "hermes-real-mcp-tool-call-after-rebuild",
    });
    await removeBridgeAndAssertEmpty(host, {
      sandboxName: HERMES_SANDBOX_NAME,
      artifactPrefix: "hermes",
    });
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
      toolNames: ["fake_fake_echo"],
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
    const hostAddress = await hostAddressForSandbox(host);
    const endpointUrl = `http://${hostAddress}:${compatibleMock.port}/v1`;
    const mcpUrl = `https://host.openshell.internal:${fakeMcp.port}/mcp`;
    await onboardAgent(host, cleanup, endpointUrl, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactName: "onboard-deepagents-mcp-bridge",
    });
    await installMcpTestCaInSandbox(host, sandbox, DEEPAGENTS_SANDBOX_NAME, "deepagents");
    cleanup.add("remove Deep Agents MCP bridge", () =>
      bestEffortRemoveBridge(host, DEEPAGENTS_SANDBOX_NAME),
    );

    await addBridgeAndReadStatus(host, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      mcpUrl,
      expectedAdapter: "deepagents-config",
      artifactPrefix: "deepagents",
    });
    await assertBridgeInfrastructure(host, sandbox, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactPrefix: "deepagents",
    });
    await assertDeepAgentsConfig(sandbox, DEEPAGENTS_SANDBOX_NAME, mcpUrl);
    await assertSecretAbsentFromSandbox(sandbox, DEEPAGENTS_SANDBOX_NAME, ["/sandbox/.deepagents"]);
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
    await rebuildWithoutMcpHostSecret(host, DEEPAGENTS_SANDBOX_NAME, "deepagents");
    await installMcpTestCaInSandbox(host, sandbox, DEEPAGENTS_SANDBOX_NAME, "deepagents-rebuild");
    await assertDeepAgentsConfig(sandbox, DEEPAGENTS_SANDBOX_NAME, mcpUrl);
    await assertRealAdapterToolCall(sandbox, fakeMcp, {
      agent: "langchain-deepagents-code",
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      resultToken: deepAgentsResult,
      artifactName: "deepagents-real-mcp-tool-call-after-rebuild",
    });
    await removeBridgeAndAssertEmpty(host, {
      sandboxName: DEEPAGENTS_SANDBOX_NAME,
      artifactPrefix: "deepagents",
    });
  },
);
