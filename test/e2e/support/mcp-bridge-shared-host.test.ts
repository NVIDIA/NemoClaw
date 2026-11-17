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
