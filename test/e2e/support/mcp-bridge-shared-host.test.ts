// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createMcpFixtureTls } from "../fixtures/mcp-fixture-tls.ts";
import {
  assertSharedHostMcpComposition,
  withMcpDnsAnswers,
} from "../live/mcp-bridge-shared-host.ts";
import * as bridgeCleanup from "../live/mcp-bridge-cleanup.ts";
import * as reliability from "../live/mcp-bridge-reliability.ts";
import * as servers from "../live/mcp-bridge-servers.ts";
import * as adminScope from "../live/openclaw-admin-scope.ts";
import * as sandboxProbes from "../live/mcp-bridge-sandbox.ts";
import { MCP_BRIDGE_TEST_CREDENTIALS } from "../fixtures/mcp-bridge-credentials.ts";
import type { ShellProbeResult } from "../fixtures/shell-probe.ts";
import { startFakeMcpHttpsServer } from "../live/mcp-bridge-servers.ts";

const { tls, close } = createMcpFixtureTls();
afterAll(close);
afterEach(() => vi.restoreAllMocks());

it("controls only the selected host lookup and removes its DNS preload afterward", async () => {
  const answers = [
    { address: "8.8.8.8", family: 4 },
    { address: "8.8.4.4", family: 4 },
  ];
  let directory = "";
  await withMcpDnsAnswers("shared.example.test", answers, async (nodeOptions) => {
    directory = path.dirname(JSON.parse(nodeOptions.slice("--require=".length)) as string);
    const script = `
const dns = require("node:dns/promises");
Promise.all([
  dns.lookup("shared.example.test", { all: true, verbatim: true }),
  dns.lookup("127.0.0.1", { all: true, verbatim: true }),
]).then(result => process.stdout.write(JSON.stringify(result)));
`;
    const output = execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(JSON.parse(output)).toEqual([answers, [{ address: "127.0.0.1", family: 4 }]]);
  });
  expect(fs.existsSync(directory)).toBe(false);
});

it("rejects an unused DNS preload and removes it when the add fails", async () => {
  const answers = [{ address: "8.8.8.8", family: 4 }];
  let directory = "";
  await expect(
    withMcpDnsAnswers("shared.example.test", answers, async (nodeOptions) => {
      directory = path.dirname(JSON.parse(nodeOptions.slice("--require=".length)) as string);
    }),
  ).rejects.toThrow(/ENOENT/u);
  expect(fs.existsSync(directory)).toBe(false);
  await expect(
    withMcpDnsAnswers("shared.example.test", answers, async (nodeOptions) => {
      directory = path.dirname(JSON.parse(nodeOptions.slice("--require=".length)) as string);
      throw new Error("add refused");
    }),
  ).rejects.toThrow("add refused");
  expect(fs.existsSync(directory)).toBe(false);
});

it("authenticates each MCP path with its own credential through real HTTPS", async () => {
  const server = await startFakeMcpHttpsServer({
    secret: "first",
    additionalPaths: { "/mcp-peer": "second" },
    tls,
  });
  async function request(pathname: string, secret: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const request = https.request(
        `https://127.0.0.1:${server.port}${pathname}`,
        {
          ca: tls.cert,
          method: "POST",
          timeout: 5_000,
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        },
      );
      request.once("error", reject);
      request.once("timeout", () => request.destroy(new Error("MCP fixture request timed out")));
      request.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    });
  }
  try {
    expect(await request("/mcp", "first")).toBe(200);
    expect(await request("/mcp-peer", "second")).toBe(200);
    expect(await request("/mcp", "second")).toBe(401);
    expect(await request("/mcp-peer", "first")).toBe(401);
    expect(await request("/unconfigured", "first")).toBe(404);
    server.setSecret("replacement");
    expect(await request("/mcp", "replacement")).toBe(200);
    expect(await request("/mcp-peer", "second")).toBe(200);
  } finally {
    await server.close();
  }
});

it.each(["openclaw-config", "hermes-config", "deepagents-config"] as const)(
  "passes %s through shared-host registration and partial-failure cleanup",
  async (adapter) => {
    type Options = Parameters<typeof assertSharedHostMcpComposition>[0];
    vi.spyOn(adminScope, "approveOpenClawAdminScope").mockResolvedValue();
    vi.spyOn(servers, "startFakeMcpHttpsServer").mockResolvedValue({
      close: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof servers.startFakeMcpHttpsServer>>);
    vi.spyOn(servers, "startPublicMcpHttpsTunnel").mockResolvedValue({
      origin: "https://shared.example.test",
    } as Awaited<ReturnType<typeof servers.startPublicMcpHttpsTunnel>>);
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.4.4", family: 4 },
    ] as never);
    const add = vi
      .spyOn(reliability, "addBridgeAndReadStatus")
      .mockRejectedValue(new Error("stop after registration handoff"));
    const remove = vi.spyOn(bridgeCleanup, "cleanupMcpBridge").mockResolvedValue();
    const host = {
      command: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
      openshellCommandPath: "openshell",
    } as unknown as Options["host"];
    const cleanup = { add: vi.fn() };
    await expect(
      assertSharedHostMcpComposition({
        adapter,
        host,
        sandbox: {} as Options["sandbox"],
        cleanup: cleanup as unknown as Options["cleanup"],
        artifacts: { writeJson: vi.fn() } as unknown as Options["artifacts"],
        progress: {} as Options["progress"],
        sandboxName: "alpha",
      }),
    ).rejects.toThrow("stop after registration handoff");
    expect(add).toHaveBeenCalledWith(
      host,
      expect.anything(),
      expect.objectContaining({
        expectedAdapter: adapter,
        serverName: "shared-one",
        credentialEnvName: "SHARED_ONE_MCP_SECRET",
      }),
    );
    const cleanupEntry = cleanup.add.mock.calls.find(
      ([name]) => name === "remove shared-host MCP registration and provider shared-one",
    );
    await cleanupEntry![1]();
    expect(remove).toHaveBeenCalledWith(host, "alpha", "shared-one", adapter);
  },
);

it.each([
  ["openclaw-config", "nemoclaw-start node -"],
  ["hermes-config", "nemoclaw-start /opt/hermes/.venv/bin/python -c"],
  ["deepagents-config", "nemoclaw-start /opt/venv/bin/python3 -c"],
] as const)("uses the admitted %s runtime for credential probes", async (adapter, runtime) => {
  const result = { exitCode: 0, stdout: "", stderr: "" };
  const execShell = vi.fn().mockResolvedValue(result);
  type Sandbox = Parameters<typeof reliability.runMcpProviderRewriteProbe>[0];
  expect(
    await reliability.runMcpProviderRewriteProbe(
      { execShell } as unknown as Sandbox,
      "alpha",
      "https://shared.example.test/mcp",
      "tools/list",
      "allow",
      "shared-host-probe",
      "SHARED_ONE_MCP_SECRET",
      undefined,
      adapter,
    ),
  ).toBe(result);
  expect(execShell.mock.calls[0][1]).toContain(runtime);
  expect(execShell.mock.calls[0][1]).toContain("SHARED_ONE_MCP_SECRET");
});

it.each([
  ["withheld", "SHARED_ONE_MCP_SECRET", "success", 2],
  ["gateway-rejection", "SHARED_ONE_MCP_SECRET", "success", 2],
  ["foreign-credential", "SHARED_ONE_MCP_SECRET", "failure", 1],
  ["foreign-credential", "SHARED_TWO_MCP_SECRET", "failure", 2],
  ["peer-credential", "SHARED_ONE_MCP_SECRET", "failure", 1],
  ["peer-credential", "SHARED_TWO_MCP_SECRET", "failure", 2],
  ["transport-failure", "SHARED_ONE_MCP_SECRET", "failure", 1],
] as const)(
  "requires configured-peer withholding for %s at %s",
  async (behavior, affectedKey, expected, count) => {
    type Options = Parameters<typeof assertSharedHostMcpComposition>[0];
    const requests: Array<{ path: string; auth: string; responseStatus: number }> = [];
    const peerCalls: string[] = [];
    vi.spyOn(adminScope, "approveOpenClawAdminScope").mockResolvedValue();
    vi.spyOn(servers, "startFakeMcpHttpsServer").mockResolvedValue({
      requests,
      close: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof servers.startFakeMcpHttpsServer>>);
    vi.spyOn(servers, "startPublicMcpHttpsTunnel").mockResolvedValue({
      origin: "https://shared.example.test",
    } as Awaited<ReturnType<typeof servers.startPublicMcpHttpsTunnel>>);
    vi.spyOn(dns, "lookup").mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "8.8.4.4", family: 4 },
    ] as never);
    vi.spyOn(reliability, "addBridgeAndReadStatus").mockImplementation(
      async (_host, _sandbox, options) => {
        execFileSync(
          process.execPath,
          ["-e", 'require("node:dns/promises").lookup("shared.example.test", { all: true })'],
          {
            env: { ...process.env, NODE_OPTIONS: options.addNodeOptions },
            timeout: 10_000,
          },
        );
        return "";
      },
    );
    vi.spyOn(sandboxProbes, "captureManagedMcpPolicy").mockResolvedValue({
      policy: { endpoints: [{ allowed_ips: ["8.8.4.4", "8.8.8.8"] }] },
    } as unknown as Awaited<ReturnType<typeof sandboxProbes.captureManagedMcpPolicy>>);
    const result = (exitCode = 0): ShellProbeResult => ({
      command: [],
      exitCode,
      stdout: "",
      stderr: "",
      signal: null,
      timedOut: false,
      artifacts: { stdout: "", stderr: "", result: "" },
    });
    const entries = [
      {
        key: "SHARED_ONE_MCP_SECRET",
        own: "/mcp",
        peer: "/mcp-peer",
        secret: MCP_BRIDGE_TEST_CREDENTIALS.host,
        peerSecret: MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost,
      },
      {
        key: "SHARED_TWO_MCP_SECRET",
        own: "/mcp-peer",
        peer: "/mcp",
        secret: MCP_BRIDGE_TEST_CREDENTIALS.rotatedHost,
        peerSecret: MCP_BRIDGE_TEST_CREDENTIALS.host,
      },
    ];
    type Plan = { requests: typeof requests; peer: boolean; result: ShellProbeResult };
    const plans = new Map(
      entries.flatMap<[string, Plan]>((entry) => {
        const selected = entry.key === affectedKey ? behavior : "withheld";
        const peerAuth = {
          withheld: `Bearer openshell:resolve:env:v1_${entry.key}`,
          "gateway-rejection": "",
          "foreign-credential": `Bearer ${entry.secret}`,
          "peer-credential": `Bearer ${entry.peerSecret}`,
          "transport-failure": "",
        }[selected];
        return [
          [
            `${entry.key}:${entry.own}`,
            {
              requests: [{ path: entry.own, auth: `Bearer ${entry.secret}`, responseStatus: 200 }],
              peer: false,
              result: result(),
            },
          ],
          [
            `${entry.key}:${entry.peer}`,
            {
              requests: peerAuth
                ? [
                    {
                      path: entry.peer,
                      auth: peerAuth,
                      responseStatus: selected === "peer-credential" ? 200 : 401,
                    },
                  ]
                : [],
              peer: true,
              result: result(selected === "transport-failure" ? 1 : 0),
            },
          ],
          [`${entry.key}:/unconfigured`, { requests: [], peer: false, result: result() }],
        ];
      }),
    );
    vi.spyOn(reliability, "runMcpProviderRewriteProbe").mockImplementation(
      async (_sandbox, _name, url, _method, expectation, _artifact, key) => {
        const pathname = new URL(url).pathname;
        const plan = plans.get(`${key}:${pathname}`)!;
        requests.push(...plan.requests);
        peerCalls.push(...(plan.peer ? [`${key}:${pathname}:${expectation}`] : []));
        return plan.result;
      },
    );
    vi.spyOn(bridgeCleanup, "cleanupMcpBridge").mockResolvedValue();
    const host = {
      command: vi.fn(async (_command: string, args: string[]) =>
        args[1] === "get" ? { ...result(1), stderr: "NOT_FOUND" } : result(),
      ),
      nemoclaw: vi.fn(async () => ({ ...result(), stdout: '{"bridges":[]}' })),
      openshellCommandPath: "openshell",
    } as unknown as Options["host"];
    const run = assertSharedHostMcpComposition({
      adapter: "openclaw-config",
      host,
      sandbox: {} as Options["sandbox"],
      cleanup: { add: vi.fn() } as unknown as Options["cleanup"],
      artifacts: { writeJson: vi.fn() } as unknown as Options["artifacts"],
      progress: {} as Options["progress"],
      sandboxName: "alpha",
    });
    await expect(
      run.then(
        () => "success",
        () => "failure",
      ),
    ).resolves.toBe(expected);
    expect(peerCalls).toEqual(
      ["SHARED_ONE_MCP_SECRET:/mcp-peer:withhold", "SHARED_TWO_MCP_SECRET:/mcp:withhold"].slice(
        0,
        count,
      ),
    );
  },
);
