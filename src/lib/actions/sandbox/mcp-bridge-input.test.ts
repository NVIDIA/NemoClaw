// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  addMcpBridge,
  buildMcpBridgeProviderArgs,
  dispatchMcpBridgeCommand,
  MCP_SERVER_URL_MAX_LENGTH,
  normalizeMcpServerUrl,
  parseMcpAddArgs,
  redactCredentialValuesForDisplay,
  resolveCredentialEnv,
} from "./mcp-bridge";

describe("MCP CLI parsing", () => {
  it("parses server, URL, and env references", () => {
    const parsed = parseMcpAddArgs([
      "github",
      "--url",
      "https://api.githubcopilot.com/mcp/",
      "--env",
      "GITHUB_TOKEN",
    ]);

    expect(parsed).toEqual({
      server: "github",
      url: "https://api.githubcopilot.com/mcp/",
      env: [{ name: "GITHUB_TOKEN" }],
    });
  });

  it("rejects inline env values that would leak through process arguments", () => {
    expect(() =>
      parseMcpAddArgs(["srv", "--url=https://mcp.example.test/rpc", "--env=TOKEN=a=b=c"]),
    ).toThrow(/process arguments and shell history/);
  });

  it("rejects OpenShell child-environment compatibility keys as MCP credentials", () => {
    const materializedKeys = [
      "GCP_PROJECT_ID",
      "GOOGLE_CLOUD_PROJECT",
      "CLOUD_ML_REGION",
      "GCP_LOCATION",
      "GCP_SERVICE_ACCOUNT_EMAIL",
      "GOOSE_PROVIDER",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "VERTEX_LOCATION",
    ];
    for (const name of materializedKeys) {
      expect(() =>
        parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp", "--env", name]),
      ).toThrow(/materialized as a raw child-process value/);
      expect(() => resolveCredentialEnv([{ name, value: "host-only-secret" }])).toThrow(
        /preserve the host-only credential boundary/,
      );
      expect(() =>
        buildMcpBridgeProviderArgs("create", "provider", [{ name }], {
          [name]: "host-only-secret",
        }),
      ).toThrow(/materialized as a raw child-process value/);
    }

    expect(() =>
      parseMcpAddArgs([
        "github",
        "--url",
        "https://mcp.example.test/mcp",
        "--env",
        "GCE_METADATA_HOST",
      ]),
    ).toThrow(/rewritten by OpenShell's Google Cloud metadata compatibility path/);
  });

  it("rejects host subprocess control and allowlist names as MCP credentials", () => {
    for (const name of [
      "PATH",
      "HOME",
      "HTTP_PROXY",
      "SSL_CERT_FILE",
      "KUBECONFIG",
      "LC_ALL",
      "XDG_CONFIG_HOME",
      "OPENSHELL_GATEWAY",
      "GRPC_TRACE",
    ]) {
      expect(() =>
        parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp", "--env", name]),
      ).toThrow(/reserved for host subprocess control/);
    }
  });

  it("rejects host stdio commands", () => {
    expect(() =>
      parseMcpAddArgs([
        "github",
        "--env",
        "GITHUB_TOKEN",
        "--",
        "npx",
        "@modelcontextprotocol/server-github",
      ]),
    ).toThrow(/Host stdio MCP commands are not supported/);
  });

  it("requires an HTTPS MCP URL", () => {
    expect(() => parseMcpAddArgs(["github"])).toThrow(/--url/);
    expect(() => parseMcpAddArgs(["github", "--url", "stdio://github"])).toThrow(/https/);
  });

  it("normalizes URLs without persisting credentials", () => {
    expect(normalizeMcpServerUrl("https://mcp.example.test")).toBe("https://mcp.example.test/");
    expect(() => normalizeMcpServerUrl("https://user:pass@mcp.example.test/mcp")).toThrow(
      /must not embed credentials/,
    );
    expect(() => normalizeMcpServerUrl("https://mcp.example.test/mcp?token=secret")).toThrow(
      /must not include a query string/,
    );
    expect(() => normalizeMcpServerUrl("https://mcp.example.test/mcp?")).toThrow(
      /must not include a query string/,
    );
    expect(() => normalizeMcpServerUrl("https://mcp.example.test/mcp#credential")).toThrow(
      /must not include a fragment/,
    );
    expect(() => normalizeMcpServerUrl("https://mcp.example.test/mcp#")).toThrow(
      /must not include a fragment/,
    );
    expect(() => normalizeMcpServerUrl("https://*.example.test/mcp")).toThrow(
      /hosts must be literal/,
    );
    expect(() => normalizeMcpServerUrl("https://mcp.example.test:0/mcp")).toThrow(
      /port must be between 1 and 65535/,
    );
    for (const path of [
      "/mcp/**",
      "/mcp/%2A%2A",
      "/a/%2e%2e/mcp",
      "/mcp/%2fadmin",
      "/mcp;version=1",
      "/mcp/[admin]",
      "/mcp\\admin",
      "/mcp//admin",
      "/mcp/café",
    ]) {
      expect(() => normalizeMcpServerUrl(`https://mcp.example.test${path}`)).toThrow(
        /literal and canonical/,
      );
    }
  });

  it("bounds persisted MCP endpoint URLs consistently across adapters", () => {
    const prefix = "https://mcp.example.test/";
    const maxLengthUrl = prefix.padEnd(MCP_SERVER_URL_MAX_LENGTH, "a");
    expect(normalizeMcpServerUrl(maxLengthUrl)).toBe(maxLengthUrl);
    expect(() => normalizeMcpServerUrl(`${maxLengthUrl}a`)).toThrow(/at most 2048 characters/);
  });

  it("requires exactly one bearer credential reference", () => {
    expect(() => parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp"])).toThrow(
      /requires exactly one --env KEY/,
    );
    expect(() =>
      parseMcpAddArgs([
        "github",
        "--url",
        "https://mcp.example.test/mcp",
        "--env",
        "TOKEN_ONE",
        "--env",
        "TOKEN_TWO",
      ]),
    ).toThrow(/requires exactly one --env KEY/);
  });

  it("rejects unauthenticated direct add callers before sandbox or network side effects", async () => {
    await expect(
      addMcpBridge("missing-sandbox", {
        server: "github",
        url: "https://mcp.example.test/mcp",
        env: [],
      }),
    ).rejects.toThrow(/requires exactly one --env KEY/);
    await expect(
      addMcpBridge("missing-sandbox", {
        server: "github",
        url: "https://mcp.example.test/mcp",
        env: [{ name: "GCP_PROJECT_ID", value: "host-only-secret" }],
      }),
    ).rejects.toThrow(/materialized as a raw child-process value/);
  });

  it("rejects local and private URL targets except OpenShell host aliases", () => {
    expect(() => normalizeMcpServerUrl("https://localhost:31337/mcp")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://127.0.0.1:31337/mcp")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://169.254.169.254/latest")).toThrow(
      /private, local, or special-use IP/,
    );
    expect(() => normalizeMcpServerUrl("https://[::1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("https://[::ffff:a00:1]:31337/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("http://mcp.example.test/mcp")).toThrow(/must use https/);
    expect(normalizeMcpServerUrl("https://8.8.8.8/mcp")).toBe("https://8.8.8.8/mcp");
    expect(() => normalizeMcpServerUrl("https://[2606:4700::1]/mcp")).toThrow(
      /IPv6-literal MCP server URLs are not supported/,
    );
    expect(() => normalizeMcpServerUrl("http://host.openshell.internal:31337/mcp")).toThrow(
      /must use https/,
    );
    expect(normalizeMcpServerUrl("https://host.openshell.internal.:31337/mcp")).toBe(
      "https://host.openshell.internal:31337/mcp",
    );
  });

  it("resolves host env values without requiring them for provider reuse", () => {
    const prior = process.env.MCP_BRIDGE_TEST_TOKEN;
    process.env.MCP_BRIDGE_TEST_TOKEN = "secret-value";
    try {
      expect(resolveCredentialEnv([{ name: "MCP_BRIDGE_TEST_TOKEN" }])).toEqual({
        MCP_BRIDGE_TEST_TOKEN: "secret-value",
      });
    } finally {
      prior === undefined
        ? delete process.env.MCP_BRIDGE_TEST_TOKEN
        : (process.env.MCP_BRIDGE_TEST_TOKEN = prior);
    }
    expect(resolveCredentialEnv([{ name: "MCP_BRIDGE_TEST_TOKEN_NOT_SET" }])).toEqual({});
  });

  it("redacts inline credential values from provider failure output", () => {
    const output = redactCredentialValuesForDisplay(
      "provider failed for --credential TOKEN=inline-secret-value",
      { TOKEN: "inline-secret-value" },
    );
    expect(output).toContain("provider failed for --credential");
    expect(output).not.toContain("inline-secret-value");
  });

  it("passes MCP provider credentials by environment name, not argv value", () => {
    const args = buildMcpBridgeProviderArgs(
      "create",
      "alpha-mcp-github",
      [{ name: "TOKEN", value: "inline-secret-value" }],
      { TOKEN: "inline-secret-value" },
    );

    expect(args).toEqual([
      "provider",
      "create",
      "--name",
      "alpha-mcp-github",
      "--type",
      "generic",
      "--credential",
      "TOKEN",
    ]);
    expect(args.join(" ")).not.toContain("inline-secret-value");
    expect(args.join(" ")).not.toContain("TOKEN=inline-secret-value");
  });

  it("rejects surplus positional arguments before sandbox side effects", async () => {
    const priorExitCode = process.exitCode;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      process.exitCode = undefined;
      await dispatchMcpBridgeCommand("missing-sandbox", ["list", "extra"]);
      expect(process.exitCode).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: nemoclaw <sandbox> mcp list [--json]"),
      );

      process.exitCode = undefined;
      await dispatchMcpBridgeCommand("missing-sandbox", ["remove", "one", "two"]);
      expect(process.exitCode).toBe(2);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Usage: nemoclaw <sandbox> mcp remove <server> [--force]"),
      );
    } finally {
      errorSpy.mockRestore();
      process.exitCode = priorExitCode;
    }
  });

  it("documents force cleanup without promising residual registry removal", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await dispatchMcpBridgeCommand("missing-sandbox", ["remove", "--help"]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "Best-effort owned cleanup; preserves registry state when residuals remain",
        ),
      );
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("stale registry removal"));
    } finally {
      logSpy.mockRestore();
    }
  });
});
