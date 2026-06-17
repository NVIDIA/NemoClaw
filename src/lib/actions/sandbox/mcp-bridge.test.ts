// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MCP_HOST,
  MCP_PORT_END,
  MCP_PORT_START,
  parseAddArgs,
  waitForProxyReady,
} from "./mcp-bridge";

// waitForProxyReady derives its log/pid paths from /tmp/nemoclaw-services-<name>.
// A live pid is the test runner's own pid; a dead pid is an absurd value whose
// kill(pid, 0) probe fails. Each case uses a unique sandbox name for isolation.
const DEAD_PID = 2_147_483_646;

function seedBridge(sandboxName: string, server: string, logContents: string, pid: number): void {
  const dir = `/tmp/nemoclaw-services-${sandboxName}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, `mcp-${server}.log`), logContents);
  fs.writeFileSync(path.join(dir, `mcp-${server}.pid`), `${pid}\n${Date.now()}`);
}

describe("mcp-bridge constants", () => {
  it("uses host.docker.internal so the sandbox can reach the host proxy", () => {
    expect(MCP_HOST).toBe("host.docker.internal");
  });

  it("reserves a 100-port range (3100-3199) for proxies", () => {
    expect(MCP_PORT_START).toBe(3100);
    expect(MCP_PORT_END).toBe(3199);
    expect(MCP_PORT_END - MCP_PORT_START + 1).toBe(100);
  });
});

describe("parseAddArgs", () => {
  it("parses --name and --command", () => {
    const opts = parseAddArgs([
      "--name",
      "github",
      "--command",
      "npx @modelcontextprotocol/server-github",
    ]);
    expect(opts.name).toBe("github");
    expect(opts.command).toBe("npx @modelcontextprotocol/server-github");
    expect(opts.args).toEqual([]);
    expect(opts.env).toEqual({});
    expect(opts.port).toBeUndefined();
  });

  it("parses -e KEY=VALUE pairs into env", () => {
    const opts = parseAddArgs([
      "--name",
      "gh",
      "--command",
      "x",
      "-e",
      "GITHUB_TOKEN=abc123",
      "-e",
      "API_BASE=https://api.example.com",
    ]);
    expect(opts.env).toEqual({
      GITHUB_TOKEN: "abc123",
      API_BASE: "https://api.example.com",
    });
  });

  it("treats --env as an alias for -e", () => {
    const opts = parseAddArgs(["--name", "n", "--command", "c", "--env", "K=v"]);
    expect(opts.env).toEqual({ K: "v" });
  });

  it("preserves '=' inside the value", () => {
    const opts = parseAddArgs(["--name", "n", "--command", "c", "-e", "URL=foo=bar=baz"]);
    expect(opts.env).toEqual({ URL: "foo=bar=baz" });
  });

  it("parses --port as an integer", () => {
    const opts = parseAddArgs(["--name", "n", "--command", "c", "--port", "3105"]);
    expect(opts.port).toBe(3105);
  });

  it("collects --arg into the args array", () => {
    const opts = parseAddArgs([
      "--name",
      "n",
      "--command",
      "node",
      "--arg",
      "server.js",
      "--arg",
      "--flag",
    ]);
    expect(opts.args).toEqual(["server.js", "--flag"]);
  });

  it("treats everything after '--' as command + args", () => {
    const opts = parseAddArgs(["--name", "n", "--", "node", "server.js", "--port", "9999"]);
    expect(opts.command).toBe("node");
    expect(opts.args).toEqual(["server.js", "--port", "9999"]);
  });
});

describe("waitForProxyReady", () => {
  const created: string[] = [];
  const sandboxFor = (suffix: string): string => {
    const name = `wfpr-test-${suffix}-${process.pid}`;
    created.push(`/tmp/nemoclaw-services-${name}`);
    return name;
  };

  afterEach(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'ready' once the proxy logs a successful bind and stays alive", async () => {
    const sb = sandboxFor("ready");
    seedBridge(sb, "github", "[mcp-proxy] listening on 127.0.0.1:3100\n", process.pid);
    expect(await waitForProxyReady(sb, "github", 3100, 0, 2000)).toBe("ready");
  });

  it("returns 'failed' when the proxy logs a bind error", async () => {
    const sb = sandboxFor("failed");
    seedBridge(
      sb,
      "github",
      "[mcp-proxy] failed to listen on 127.0.0.1:3100: EADDRINUSE\n",
      DEAD_PID,
    );
    expect(await waitForProxyReady(sb, "github", 3100, 0, 2000)).toBe("failed");
  });

  it("returns 'failed' when the proxy bound but its child exited", async () => {
    const sb = sandboxFor("child-exit");
    seedBridge(
      sb,
      "github",
      "[mcp-proxy] listening on 127.0.0.1:3100\n[mcp-proxy] child exited with code 1\n",
      DEAD_PID,
    );
    expect(await waitForProxyReady(sb, "github", 3100, 0, 2000)).toBe("failed");
  });

  it("ignores a stale bind line written before sinceOffset", async () => {
    const sb = sandboxFor("offset");
    const stale = "[mcp-proxy] listening on 127.0.0.1:3100\n";
    seedBridge(sb, "github", stale, DEAD_PID);
    // Start scanning past the stale line; the dead pid means no new bind.
    expect(await waitForProxyReady(sb, "github", 3100, Buffer.byteLength(stale), 800)).toBe(
      "failed",
    );
  });

  it("returns 'timeout' when the proxy neither binds nor dies in time", async () => {
    const sb = sandboxFor("timeout");
    seedBridge(sb, "github", "[mcp-proxy] starting up...\n", process.pid);
    expect(await waitForProxyReady(sb, "github", 3100, 0, 400)).toBe("timeout");
  });
});
