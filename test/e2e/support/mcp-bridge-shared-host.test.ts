// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { createMcpFixtureTls } from "../fixtures/mcp-fixture-tls.ts";
import { withMcpDnsAnswers } from "../live/mcp-bridge-shared-host.ts";
import { startFakeMcpHttpsServer } from "../live/mcp-bridge-servers.ts";

const { tls, close } = createMcpFixtureTls();
afterAll(close);

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
