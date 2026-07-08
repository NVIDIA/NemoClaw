// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  SUBPROCESS_ENV_ALLOWED_NAMES,
  SUBPROCESS_ENV_ALLOWED_PREFIXES,
} from "../../subprocess-env";
import {
  buildMcpBridgeProviderArgs,
  MCP_SERVER_URL_MAX_LENGTH,
  normalizeMcpServerUrl,
  parseMcpAddArgs,
  resolveCredentialEnv,
} from "./mcp-bridge";
import childVisibleCredentialManifest from "./openshell-child-visible-credentials.v0.0.72.json";

describe("MCP CLI input validation", () => {
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
    expect(childVisibleCredentialManifest).toMatchObject({
      openshellVersion: "0.0.72",
      openshellCommit: "8cb16de9eae4c44d7d31e1493747d8c10abb5963",
    });
    expect(childVisibleCredentialManifest.rawChildValueKeys).toEqual([
      "GCP_PROJECT_ID",
      "GOOGLE_CLOUD_PROJECT",
      "CLOUD_ML_REGION",
      "GCP_LOCATION",
      "GCP_SERVICE_ACCOUNT_EMAIL",
      "GOOSE_PROVIDER",
      "ANTHROPIC_VERTEX_PROJECT_ID",
      "VERTEX_LOCATION",
    ]);
    for (const name of childVisibleCredentialManifest.rawChildValueKeys) {
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

    expect(childVisibleCredentialManifest.rewrittenChildValueKeys).toEqual([
      "GCE_METADATA_HOST",
      "GCE_METADATA_IP",
      "METADATA_SERVER_DETECTION",
    ]);
    for (const name of childVisibleCredentialManifest.rewrittenChildValueKeys) {
      expect(() =>
        parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp", "--env", name]),
      ).toThrow(/rewritten by OpenShell's Google Cloud metadata compatibility path/);
    }
  });

  it("rejects host subprocess control and allowlist names as MCP credentials", () => {
    for (const name of SUBPROCESS_ENV_ALLOWED_NAMES) {
      expect(childVisibleCredentialManifest.runtimeControlKeys).toContain(name);
    }
    for (const prefix of SUBPROCESS_ENV_ALLOWED_PREFIXES) {
      expect(childVisibleCredentialManifest.runtimeControlPrefixes).toContain(prefix);
    }
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

  it("rejects sandbox runtime-control names as MCP credentials", () => {
    for (const name of [
      "BASH_ENV",
      "ALL_PROXY",
      "all_proxy",
      "API_SERVER_KEY",
      "DENO_CERT",
      "grpc_proxy",
      "NEMOCLAW_DASHBOARD_PORT",
      "OPENCLAW_GATEWAY_URL",
      "OPENAI_BASE_URL",
      "HERMES_HOME",
      "DEEPAGENTS_CONFIG_PATH",
      "LANGCHAIN_TRACING_V2",
      "ENV",
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "GLIBC_TUNABLES",
      "NODE_OPTIONS",
      "PYTHONHOME",
      "PYTHONPATH",
      "RUBYOPT",
      "PERL5OPT",
      "JAVA_TOOL_OPTIONS",
      "_JAVA_OPTIONS",
      "CLASSPATH",
      "VIRTUAL_ENV",
      "UV_PROJECT_ENVIRONMENT",
    ]) {
      expect(() =>
        parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp", "--env", name]),
      ).toThrow(/reserved for sandbox runtime control/);
      expect(() => resolveCredentialEnv([{ name, value: "host-only-secret" }])).toThrow(
        /could alter or prevent agent commands/,
      );
      expect(() =>
        buildMcpBridgeProviderArgs("create", "provider", [{ name }], {
          [name]: "host-only-secret",
        }),
      ).toThrow(/reserved for sandbox runtime control/);
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
    for (const token of [
      "nvapi-abcdefghijklmnop",
      "ghp_abcdefghijklmnop",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "sk-abcdefghijklmnopqrstuvwxyz.json",
      `bot1234567890:${"A".repeat(35)}`,
      `bot1234567890:${"A".repeat(34)}-`,
      `1234567890:${"B".repeat(35)}`,
      `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(26)}-`,
    ]) {
      expect(() => normalizeMcpServerUrl(`https://mcp.example.test/mcp/${token}`)).toThrow(
        /paths must not contain secret-shaped credential material.*full URL is persisted/i,
      );
    }
    for (const path of ["/botanical/mcp", "/bottom/mcp", "/api/bots/mcp"]) {
      expect(normalizeMcpServerUrl(`https://mcp.example.test${path}`)).toBe(
        `https://mcp.example.test${path}`,
      );
    }
    expect(() => normalizeMcpServerUrl("https://*.example.test/mcp")).toThrow(
      /hosts must be literal/,
    );
    expect(() => normalizeMcpServerUrl("https://mcp.example.test:0/mcp")).toThrow(
      /port must be between 1 and 65535/,
    );
    for (const hostname of [
      "mcp_bad.example.test",
      "-mcp.example.test",
      "mcp-.example.test",
      "mcp..example.test",
      `${"a".repeat(64)}.example.test`,
      `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
    ]) {
      expect(() => normalizeMcpServerUrl(`https://${hostname}/mcp`)).toThrow(
        /canonical DNS labels/,
      );
    }
    expect(normalizeMcpServerUrl(`https://${"a".repeat(63)}.example.test/mcp`)).toBe(
      `https://${"a".repeat(63)}.example.test/mcp`,
    );
    for (const path of [
      "/mcp/**",
      "/mcp/%2A%2A",
      "/a/%2e%2e/mcp",
      "/mcp/%2fadmin",
      "/mcp/%",
      "/mcp/%GG",
      "/mcp/%2",
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
});
