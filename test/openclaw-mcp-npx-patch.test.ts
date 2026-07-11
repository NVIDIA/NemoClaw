// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import {
  MARKER,
  buildMcpTimeoutMessage,
  formatMcpCommand,
  hasNpxYesFlag,
  isNpxCommand,
  normalizeMcpServerArgs,
  patchMcpTransportText,
  redactMcpArgs,
} from "../scripts/patch-openclaw-mcp-npx.mts";

const PATCH_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "patch-openclaw-mcp-npx.mts");

function writeMcpFixture(dist: string): string {
  const fixture = path.join(dist, "bundle-mcp.fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";',
      "",
      "const CONNECTION_TIMEOUT_MS = 30000;",
      "async function connectMcpServer(serverName, server, forceTimeout = false) {",
      "  const transport = new StdioClientTransport({",
      "    command: server.command,",
      "    args: server.args,",
      "    env: server.env",
      "  });",
      "  if (forceTimeout) throw new Error(`MCP server connection timed out after ${CONNECTION_TIMEOUT_MS}ms`);",
      "  return { serverName, transport };",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function writeMcpTransportOnlyFixture(dist: string): string {
  const fixture = path.join(dist, "chrome-mcp.fixture.js");
  fs.writeFileSync(
    fixture,
    [
      'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";',
      "",
      "async function connectMcpServer(serverName, server) {",
      "  const transport = new StdioClientTransport({",
      "    command: server.command,",
      "    args: server.args,",
      "    env: server.env",
      "  });",
      "  return { serverName, transport };",
      "}",
      "",
    ].join("\n"),
  );
  return fixture;
}

function runPatch(dist: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", PATCH_SCRIPT, dist], {
    encoding: "utf-8",
    timeout: 10_000,
  });
}

async function runPatchedFixture(
  patchedSource: string,
  serverName: string,
  server: { command: string; args?: string[] },
  forceTimeout = false,
) {
  const strippedSource = patchedSource.replace(
    /^import \{ StdioClientTransport \} from "@modelcontextprotocol\/sdk\/client\/stdio\.js";\n/,
    "",
  );
  const context = {
    StdioClientTransport: class StdioClientTransport {
      params: unknown;

      constructor(params: unknown) {
        this.params = params;
      }
    },
  };
  const api = vm.runInNewContext(`${strippedSource}\n({ connectMcpServer });`, context) as {
    connectMcpServer: (
      serverName: string,
      server: { command: string; args?: string[] },
      forceTimeout?: boolean,
    ) => Promise<{ transport: { params: { command: string; args?: string[] } } }>;
  };
  return await api.connectMcpServer(serverName, server, forceTimeout);
}

describe("OpenClaw MCP npx normalization patch", () => {
  it("normalizes npx server args without duplicating -y", () => {
    expect(isNpxCommand("npx")).toBe(true);
    expect(isNpxCommand("/usr/local/bin/npx")).toBe(true);
    expect(isNpxCommand("/opt/node/bin/npx.cmd")).toBe(true);
    expect(isNpxCommand("C:\\Program Files\\nodejs\\npx.cmd")).toBe(true);
    expect(isNpxCommand("node")).toBe(false);

    expect(hasNpxYesFlag(["-y", "@modelcontextprotocol/server-filesystem"])).toBe(true);
    expect(hasNpxYesFlag(["--yes", "@modelcontextprotocol/server-filesystem"])).toBe(true);
    expect(hasNpxYesFlag(["@modelcontextprotocol/server-filesystem"])).toBe(false);

    expect(
      normalizeMcpServerArgs("npx", [
        "@modelcontextprotocol/server-filesystem",
        "/sandbox/.openclaw/workspace",
        "/tmp",
      ]),
    ).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/sandbox/.openclaw/workspace",
      "/tmp",
    ]);
    expect(normalizeMcpServerArgs("npx", ["-y", "pkg"])).toEqual(["-y", "pkg"]);
    expect(normalizeMcpServerArgs("npx", ["--yes", "pkg"])).toEqual(["--yes", "pkg"]);
    expect(normalizeMcpServerArgs("node", ["server.js"])).toEqual(["server.js"]);
  });

  it("builds an actionable timeout message without leaking secret-looking args", () => {
    expect(redactMcpArgs(["--api-key", "sk-live-value", "--scope=repo"])).toEqual([
      "--api-key",
      "[redacted]",
      "--scope=repo",
    ]);
    expect(redactMcpArgs(["--token=ghp_fake", "stdio"])).toEqual(["--token=[redacted]", "stdio"]);
    expect(formatMcpCommand("npx", ["@scope/pkg", "--api-key", "secret"])).toBe(
      "npx @scope/pkg --api-key [redacted]",
    );

    const message = buildMcpTimeoutMessage(
      "filesystem",
      "npx",
      ["@modelcontextprotocol/server-filesystem", "/tmp"],
      30000,
    );
    expect(message).toContain('MCP server "filesystem"');
    expect(message).toContain("npx @modelcontextprotocol/server-filesystem /tmp");
    expect(message).toContain('starts npx servers with "-y"');
    expect(message).toContain("pre-install the package");
    expect(message).toContain("stdout");
  });

  it("rewrites StdioClientTransport construction and timeout text once", () => {
    const source = [
      'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";',
      "",
      "const CONNECTION_TIMEOUT_MS = 30000;",
      "function connect(serverName, server) {",
      "  const transport = new StdioClientTransport({",
      "    command: server.command,",
      "    args: server.args",
      "  });",
      "  throw new Error(`MCP server connection timed out after ${CONNECTION_TIMEOUT_MS}ms`);",
      "}",
      "",
    ].join("\n");

    const first = patchMcpTransportText(source, "bundle-mcp.fixture.js");
    expect(first.patched).toBe(true);
    expect(first.text).toContain(MARKER);
    expect(first.text).toContain("class NemoClawMcpStdioClientTransport");
    expect(first.text).toContain("new NemoClawMcpStdioClientTransport({");
    expect(first.text).toContain('return ["-y", ...normalizedArgs];');
    expect(first.text).toContain(
      "nemoClawMcpTimeoutMessage(serverName, server?.command, server?.args, CONNECTION_TIMEOUT_MS)",
    );
    expect(first.text).toContain("pre-install the package");
    expect(first.text).not.toContain("new StdioClientTransport({");

    const second = patchMcpTransportText(first.text, "bundle-mcp.fixture.js");
    expect(second.patched).toBe(false);
    expect(second.status).toBe("already-patched");
    expect(second.text.match(/class NemoClawMcpStdioClientTransport/g)).toHaveLength(1);
    expect(second.text.match(/new NemoClawMcpStdioClientTransport/g)).toHaveLength(1);
  });

  it("rewrites transport-only MCP bundles without timeout text", async () => {
    const source = [
      'import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";',
      "",
      "async function connectMcpServer(serverName, server) {",
      "  const transport = new StdioClientTransport({",
      "    command: server.command,",
      "    args: server.args",
      "  });",
      "  return { serverName, transport };",
      "}",
      "",
    ].join("\n");

    const result = patchMcpTransportText(source, "chrome-mcp.fixture.js");
    expect(result.patched).toBe(true);
    expect(result.status).toBe("patched-no-timeout");
    expect(result.text).toContain(MARKER);
    expect(result.text).toContain("class NemoClawMcpStdioClientTransport");
    expect(result.text).toContain("new NemoClawMcpStdioClientTransport({");
    expect(result.text).not.toContain("new StdioClientTransport({");
    expect(result.text).not.toContain("nemoClawMcpTimeoutMessage(serverName, server?.command");

    await expect(
      runPatchedFixture(result.text, "chrome", {
        command: "npx",
        args: ["@modelcontextprotocol/server-puppeteer"],
      }),
    ).resolves.toMatchObject({
      transport: {
        params: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-puppeteer"],
        },
      },
    });
  });

  it("patches an OpenClaw dist fixture through the CLI", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-mcp-npx-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    const fixture = writeMcpFixture(dist);
    const transportOnlyFixture = writeMcpTransportOnlyFixture(dist);

    try {
      const patch = runPatch(dist);
      expect(patch.status, `${patch.stdout}${patch.stderr}`).toBe(0);
      expect(patch.stdout).toContain("OpenClaw MCP npx normalization");
      expect(patch.stdout).toContain("patched,patched-no-timeout");

      const patched = fs.readFileSync(fixture, "utf-8");
      expect(patched).toContain(MARKER);
      expect(patched).toContain("nemoClawNormalizeMcpServerArgs(params.command, params.args)");
      expect(patched).toContain("new NemoClawMcpStdioClientTransport({");
      expect(patched).toContain(
        "nemoClawMcpTimeoutMessage(serverName, server?.command, server?.args, CONNECTION_TIMEOUT_MS)",
      );
      expect(patched).toContain("pre-install the package");

      const transportOnlyPatched = fs.readFileSync(transportOnlyFixture, "utf-8");
      expect(transportOnlyPatched).toContain(MARKER);
      expect(transportOnlyPatched).toContain("new NemoClawMcpStdioClientTransport({");
      expect(transportOnlyPatched).not.toContain("new StdioClientTransport({");
      await expect(
        runPatchedFixture(transportOnlyPatched, "chrome", {
          command: "npx",
          args: ["@modelcontextprotocol/server-puppeteer"],
        }),
      ).resolves.toMatchObject({
        transport: {
          params: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-puppeteer"],
          },
        },
      });

      await expect(
        runPatchedFixture(patched, "filesystem", {
          command: "/usr/local/bin/npx",
          args: ["@modelcontextprotocol/server-filesystem", "/tmp"],
        }),
      ).resolves.toMatchObject({
        transport: {
          params: {
            command: "/usr/local/bin/npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
          },
        },
      });
      await expect(
        runPatchedFixture(patched, "already-yes", {
          command: "C:\\Program Files\\nodejs\\npx.cmd",
          args: ["--yes", "pkg"],
        }),
      ).resolves.toMatchObject({
        transport: {
          params: {
            command: "C:\\Program Files\\nodejs\\npx.cmd",
            args: ["--yes", "pkg"],
          },
        },
      });
      await expect(
        runPatchedFixture(patched, "node-server", {
          command: "node",
          args: ["server.js"],
        }),
      ).resolves.toMatchObject({
        transport: {
          params: {
            command: "node",
            args: ["server.js"],
          },
        },
      });
      await expect(
        runPatchedFixture(
          patched,
          "filesystem",
          {
            command: "npx",
            args: ["@modelcontextprotocol/server-filesystem", "--api-key", "sk-live-value"],
          },
          true,
        ),
      ).rejects.toThrow(
        /MCP server "filesystem" \(npx @modelcontextprotocol\/server-filesystem --api-key \[redacted\]\) connection timed out after 30000ms\. Hint: npx MCP servers/,
      );

      const rerun = runPatch(dist);
      expect(rerun.status, `${rerun.stdout}${rerun.stderr}`).toBe(0);
      const rerunPatched = fs.readFileSync(fixture, "utf-8");
      expect(rerunPatched.match(/class NemoClawMcpStdioClientTransport/g)).toHaveLength(1);
      expect(rerunPatched.match(/new NemoClawMcpStdioClientTransport/g)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails closed when no MCP stdio transport target is present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-mcp-npx-missing-"));
    const dist = path.join(tmp, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "unrelated.js"), "export const noop = true;\n");

    try {
      const patch = runPatch(dist);
      expect(patch.status).toBe(1);
      expect(patch.stderr).toContain("No OpenClaw MCP stdio transport target found");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
