// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it } from "vitest";

import { patchManagedTransportDiagnosticsText } from "../../../scripts/patch-openclaw-managed-transport-diagnostics.mts";
import {
  INJECTED_TOOLS_LIST_TIMEOUT_HELPER,
  MARKER,
  patchMcpToolsListTimeoutText,
  patchOpenClawMcpToolsListTimeout,
  SUPPORTED_OPENCLAW_VERSION,
  TOOLS_LIST_TIMEOUT_ENV,
  TOOLS_LIST_TIMEOUT_MAX_MS,
  TOOLS_LIST_TIMEOUT_MIN_MS,
} from "../../../scripts/patch-openclaw-mcp-tools-list-timeout.mts";

/** Mirrors the reviewed OpenClaw 2026.7.1 bundle-mcp timeout boundary. */
function bundleMcpRuntimeFixture(): string {
  return [
    'import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";',
    'import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";',
    'const CLIENT_IDENTITY = "openclaw-bundle-mcp";',
    "const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1500;",
    "let bundleMcpCatalogListTimeoutMs;",
    "function hasConfiguredMcpRequestTimeout(rawServer) {",
    '\treturn Boolean(rawServer && typeof rawServer.requestTimeoutMs === "number");',
    "}",
    "function getCatalogListTimeoutMs(rawServer, requestTimeoutMs) {",
    "\tif (bundleMcpCatalogListTimeoutMs !== void 0) return bundleMcpCatalogListTimeoutMs;",
    "\treturn hasConfiguredMcpRequestTimeout(rawServer) ? requestTimeoutMs : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;",
    "}",
    "function setBundleMcpCatalogListTimeoutMsForTest(timeoutMs) {",
    "\tbundleMcpCatalogListTimeoutMs = timeoutMs;",
    "}",
    "function resolveMcpTransport(serverName, rawServer) {",
    "\tvoid serverName;",
    "\tvoid rawServer;",
    '\tconst resolved = { auth: undefined, transportType: "streamable-http", url: "https://mcp.test/rpc" };',
    "\tconst headers = undefined;",
    "\tconst httpFetch = fetch;",
    '\tif (resolved.transportType === "streamable-http") return {',
    "\t\ttransport: new StreamableHTTPClientTransport(new URL(resolved.url), {",
    '\t\t\trequestInit: resolved.auth === "oauth" || !headers ? void 0 : { headers },',
    "\t\t\tfetch: httpFetch,",
    "\t\t\tauthProvider: undefined",
    "\t\t}),",
    '\t\ttransportType: "streamable-http"',
    "\t};",
    "\treturn {",
    "\t\ttransport: new SSEClientTransport(new URL(resolved.url), {",
    "\t\t\tfetch: httpFetch,",
    "\t\t\tauthProvider: undefined",
    "\t\t}),",
    '\t\ttransportType: "sse"',
    "\t};",
    "}",
    "void CLIENT_IDENTITY;",
    "void getCatalogListTimeoutMs;",
    "void setBundleMcpCatalogListTimeoutMsForTest;",
    "void resolveMcpTransport;",
  ].join("\n");
}

function loadOverride(env: Record<string, string>): { stderr: string[]; value: unknown } {
  const stderr: string[] = [];
  const context = vm.createContext({
    Error,
    Number,
    process: { env, stderr: { write: (chunk: string) => stderr.push(chunk) } },
  });
  const value = vm.runInContext(
    `${INJECTED_TOOLS_LIST_TIMEOUT_HELPER}\nNEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_OVERRIDE_MS;`,
    context,
  );
  return { stderr, value };
}

function executePatchedTimeoutResolver(options: {
  env?: Record<string, string>;
  rawServer?: Record<string, unknown>;
  requestTimeoutMs: number;
  testOnlyTimeoutMs?: number;
}): unknown {
  const patched = patchMcpToolsListTimeoutText(bundleMcpRuntimeFixture(), "fixture.js");
  const executable = patched.text.replace(/^(?:import[^\n]*\n)+/u, "");
  const context = vm.createContext({
    Error,
    Number,
    process: {
      env: options.env ?? {},
      stderr: { write: () => undefined },
    },
  });
  const resolver = vm.runInContext(
    `${executable}\n({ getCatalogListTimeoutMs, setBundleMcpCatalogListTimeoutMsForTest });`,
    context,
  ) as {
    getCatalogListTimeoutMs: (rawServer: unknown, requestTimeoutMs: number) => unknown;
    setBundleMcpCatalogListTimeoutMsForTest: (timeoutMs: number | undefined) => void;
  };

  resolver.setBundleMcpCatalogListTimeoutMsForTest(options.testOnlyTimeoutMs);
  return resolver.getCatalogListTimeoutMs(options.rawServer, options.requestTimeoutMs);
}

describe("patchMcpToolsListTimeoutText", () => {
  it("adds a bounded override ahead of OpenClaw's configured and default budgets", () => {
    const result = patchMcpToolsListTimeoutText(bundleMcpRuntimeFixture(), "fixture.js");

    expect(result.status).toBe("patched");
    expect(result.text).toContain(MARKER);
    expect(result.text).toContain(
      "\tif (NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_OVERRIDE_MS !== void 0) return NEMOCLAW_MCP_TOOLS_LIST_TIMEOUT_OVERRIDE_MS;",
    );
    expect(result.text).toContain("const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1500;");
  });

  it.each([
    {
      env: { OPENSHELL_SANDBOX: "1", [TOOLS_LIST_TIMEOUT_ENV]: "5000" },
      expected: 9000,
      name: "test-only setter",
      rawServer: { requestTimeoutMs: 3000 },
      requestTimeoutMs: 3000,
      testOnlyTimeoutMs: 9000,
    },
    {
      env: { OPENSHELL_SANDBOX: "1", [TOOLS_LIST_TIMEOUT_ENV]: "5000" },
      expected: 5000,
      name: "NemoClaw override",
      rawServer: { requestTimeoutMs: 3000 },
      requestTimeoutMs: 3000,
    },
    {
      expected: 3000,
      name: "server timeout",
      rawServer: { requestTimeoutMs: 3000 },
      requestTimeoutMs: 3000,
    },
    {
      expected: 1500,
      name: "OpenClaw default",
      requestTimeoutMs: 3000,
    },
  ])("executes the patched resolver with $name precedence", (options) => {
    expect(executePatchedTimeoutResolver(options)).toBe(options.expected);
  });

  it("reports a fully applied timeout patch as already patched", () => {
    const once = patchMcpToolsListTimeoutText(bundleMcpRuntimeFixture(), "fixture.js");
    const twice = patchMcpToolsListTimeoutText(once.text, "fixture.js");

    expect(twice.status).toBe("already-patched");
    expect(twice.text).toBe(once.text);
  });

  it("fails closed when the reviewed timeout boundary drifts", () => {
    const drifted = bundleMcpRuntimeFixture().replace(
      "const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 1500;",
      "const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 2000;",
    );

    expect(() => patchMcpToolsListTimeoutText(drifted, "fixture.js")).toThrow(
      /expected exactly one reviewed MCP tools\/list timeout boundary, found 0/,
    );
  });

  it.each([{ scenario: "timeout then diagnostics" }, { scenario: "diagnostics then timeout" }])(
    "composes with managed transport diagnostics in either order [$scenario]",
    ({ scenario }) => {
      const timeoutThenDiagnostics = patchManagedTransportDiagnosticsText(
        patchMcpToolsListTimeoutText(bundleMcpRuntimeFixture(), "fixture.js").text,
        "fixture.js",
      ).text;
      const diagnosticsThenTimeout = patchMcpToolsListTimeoutText(
        patchManagedTransportDiagnosticsText(bundleMcpRuntimeFixture(), "fixture.js").text,
        "fixture.js",
      ).text;

      const composed = (
        {
          "timeout then diagnostics": timeoutThenDiagnostics,
          "diagnostics then timeout": diagnosticsThenTimeout,
        } as const
      )[scenario]!;
      expect(composed).toContain(MARKER);
      expect(composed).toContain("nemoclaw managed transport diagnostics (#7957)");
      expect(patchMcpToolsListTimeoutText(composed, "fixture.js").status).toBe("already-patched");
      expect(patchManagedTransportDiagnosticsText(composed, "fixture.js").status).toBe(
        "already-patched",
      );
    },
  );
});

describe("patchOpenClawMcpToolsListTimeout", () => {
  it.each(["2026.3.11", "2026.4.24"])(
    "skips the unsupported legacy OpenClaw %s fixture before bundle discovery",
    (version) => {
      const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-timeout-"));
      const distDir = path.join(packageRoot, "dist");
      fs.mkdirSync(distDir);
      fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({ version }));
      try {
        expect(patchOpenClawMcpToolsListTimeout(distDir)).toEqual({
          status: "skipped-unsupported-version",
          version,
        });
      } finally {
        fs.rmSync(packageRoot, { recursive: true, force: true });
      }
    },
  );

  it("keeps the exact-shape patch enabled for the supported OpenClaw version", () => {
    expect(SUPPORTED_OPENCLAW_VERSION).toBe("2026.7.1");
  });

  it("fails closed for an unreviewed OpenClaw version", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-timeout-"));
    const distDir = path.join(packageRoot, "dist");
    fs.mkdirSync(distDir);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ version: "2026.8.1" }),
    );
    try {
      expect(() => patchOpenClawMcpToolsListTimeout(distDir)).toThrow(
        "OpenClaw 2026.8.1 is not reviewed for the MCP tools/list timeout compatibility patch",
      );
    } finally {
      fs.rmSync(packageRoot, { recursive: true, force: true });
    }
  });
});

describe("injected MCP tools/list timeout override", () => {
  it("retains the OpenClaw default when the override is absent", () => {
    const result = loadOverride({ OPENSHELL_SANDBOX: "1" });

    expect(result.value).toBeUndefined();
    expect(result.stderr).toEqual([]);
  });

  it("ignores a host-side override outside an OpenShell sandbox", () => {
    const result = loadOverride({ [TOOLS_LIST_TIMEOUT_ENV]: "3000" });

    expect(result.value).toBeUndefined();
    expect(result.stderr).toEqual([]);
  });

  it.each([TOOLS_LIST_TIMEOUT_MIN_MS, 3000, 5000, TOOLS_LIST_TIMEOUT_MAX_MS])(
    "accepts the bounded %i ms override and logs it once",
    (timeoutMs) => {
      const result = loadOverride({
        OPENSHELL_SANDBOX: "1",
        [TOOLS_LIST_TIMEOUT_ENV]: String(timeoutMs),
      });

      expect(result.value).toBe(timeoutMs);
      expect(result.stderr).toEqual([
        `[nemoclaw] mcp_tools_list_timeout_override_ms=${timeoutMs}\n`,
      ]);
    },
  );

  it.each(["1499", "10001", "3000.5", "3s", "+3000", "03000", "1e4"])(
    "rejects the invalid %s override before OpenClaw starts",
    (value) => {
      expect(() =>
        loadOverride({ OPENSHELL_SANDBOX: "1", [TOOLS_LIST_TIMEOUT_ENV]: value }),
      ).toThrow(
        `${TOOLS_LIST_TIMEOUT_ENV} must be an integer from ${TOOLS_LIST_TIMEOUT_MIN_MS} to ${TOOLS_LIST_TIMEOUT_MAX_MS} milliseconds`,
      );
    },
  );
});
