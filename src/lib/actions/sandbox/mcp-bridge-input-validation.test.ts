// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

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
import childVisibleCredentialManifest from "./openshell-child-visible-credentials.v0.0.106.json";

const CHILD_VISIBLE_CREDENTIAL_CASES = [
  {
    names: childVisibleCredentialManifest.rawChildValueKeys,
    error: /materialized as a raw child-process value|preserve the host-only credential boundary/,
  },
  {
    names: childVisibleCredentialManifest.rewrittenChildValueKeys,
    error: /rewritten by OpenShell's Google Cloud metadata compatibility path/,
  },
].flatMap(({ names, error }) =>
  names.flatMap((name) => [
    { name, form: "--env NAME", envArgs: ["--env", name], error },
    { name, form: "-e NAME", envArgs: ["-e", name], error },
    { name, form: "--env=NAME", envArgs: [`--env=${name}`], error },
  ]),
);

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

  it("normalizes one exact trusted-private host from a repeated add option (#8267)", () => {
    expect(
      parseMcpAddArgs([
        "local",
        "--url",
        "https://10.20.30.40/mcp",
        "--env",
        "LOCAL_MCP_TOKEN",
        "--trusted-private-host",
        "10.20.30.40",
      ]),
    ).toEqual({
      server: "local",
      url: "https://10.20.30.40/mcp",
      env: [{ name: "LOCAL_MCP_TOKEN" }],
      trustedPrivateHosts: ["10.20.30.40"],
    });

    expect(() =>
      parseMcpAddArgs([
        "local",
        "--url",
        "https://mcp.corp.example/mcp",
        "--env",
        "LOCAL_MCP_TOKEN",
        "--trusted-private-host",
        "MCP.CORP.EXAMPLE.",
        "--trusted-private-host=mcp.corp.example",
      ]),
    ).toThrow(/Duplicate --trusted-private-host/);
  });

  it("uses generic trusted-private hosts without persisting unrelated entries (#8176)", () => {
    vi.stubEnv("NEMOCLAW_TRUSTED_PRIVATE_HOSTS", "unrelated.corp.example,10.20.30.40");

    expect(
      parseMcpAddArgs(["local", "--url", "https://10.20.30.40/mcp", "--env", "LOCAL_MCP_TOKEN"]),
    ).toEqual({
      server: "local",
      url: "https://10.20.30.40/mcp",
      env: [{ name: "LOCAL_MCP_TOKEN" }],
    });
  });

  it("rejects a trusted-private add option for a different URL host (#8267)", () => {
    expect(() =>
      parseMcpAddArgs([
        "local",
        "--url",
        "https://mcp.corp.example/mcp",
        "--env",
        "LOCAL_MCP_TOKEN",
        "--trusted-private-host",
        "other.corp.example",
      ]),
    ).toThrow(/does not match MCP server URL host/);
  });

  it("rejects inline env values that would leak through process arguments", () => {
    expect(() =>
      parseMcpAddArgs(["srv", "--url=https://mcp.example.test/rpc", "--env=TOKEN=a=b=c"]),
    ).toThrow(/process arguments and shell history/);
  });

  it.each(["v1_TOKEN", "v999999_very_unlikely", "v0_1"])(
    "rejects OpenShell revisioned placeholder name %s as an MCP credential (#6379)",
    (name) => {
      expect(() =>
        parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp", "--env", name]),
      ).toThrow(/reserved for OpenShell credential revisions/);
      expect(() => resolveCredentialEnv([{ name, value: "host-only-secret" }])).toThrow(
        /would be skipped instead of attached/,
      );
      expect(() =>
        buildMcpBridgeProviderArgs("create", "provider", [{ name }], {
          [name]: "host-only-secret",
        }),
      ).toThrow(/reserved for OpenShell credential revisions/);
    },
  );

  it.each(["v_TOKEN", "v10_", "versioned_token", "V10_TOKEN"])(
    "accepts non-revisioned MCP credential name %s (#6379)",
    (name) => {
      expect(() =>
        parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp", "--env", name]),
      ).not.toThrow();
    },
  );

  it.each(CHILD_VISIBLE_CREDENTIAL_CASES)(
    "rejects $name from $form at every MCP credential boundary",
    ({ name, envArgs, error }) => {
      expect(() =>
        parseMcpAddArgs(["github", "--url", "https://mcp.example.test/mcp", ...envArgs]),
      ).toThrow(error);
      expect(() => resolveCredentialEnv([{ name, value: "host-only-secret" }])).toThrow(error);
      expect(() =>
        buildMcpBridgeProviderArgs("create", "provider", [{ name }], {
          [name]: "host-only-secret",
        }),
      ).toThrow(error);
    },
  );

  it.each([
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
  ])("rejects sandbox runtime-control name %s as an MCP credential", (name) => {
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
    expect(normalizeMcpServerUrl(`https://${"a".repeat(63)}.example.test/mcp`)).toBe(
      `https://${"a".repeat(63)}.example.test/mcp`,
    );
  });

  it.each([
    "nvapi-abcdefghijklmnop",
    "ghp_abcdefghijklmnop",
    "sk-abcdefghijklmnopqrstuvwxyz",
    "sk-abcdefghijklmnopqrstuvwxyz.json",
    `bot1234567890:${"A".repeat(35)}`,
    `bot1234567890:${"A".repeat(34)}-`,
    `1234567890:${"B".repeat(35)}`,
    `${"A".repeat(24)}.${"B".repeat(6)}.${"C".repeat(26)}-`,
  ])("rejects secret-shaped MCP URL path token %#", (token) => {
    expect(() => normalizeMcpServerUrl(`https://mcp.example.test/mcp/${token}`)).toThrow(
      /paths must not contain secret-shaped credential material.*full URL is persisted/i,
    );
  });

  it.each(["/botanical/mcp", "/bottom/mcp", "/api/bots/mcp"])(
    "accepts credential-free MCP URL path %s",
    (path) => {
      expect(normalizeMcpServerUrl(`https://mcp.example.test${path}`)).toBe(
        `https://mcp.example.test${path}`,
      );
    },
  );

  it.each([
    "mcp_bad.example.test",
    "-mcp.example.test",
    "mcp-.example.test",
    "mcp..example.test",
    `${"a".repeat(64)}.example.test`,
    `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
  ])("rejects noncanonical MCP hostname %#", (hostname) => {
    expect(() => normalizeMcpServerUrl(`https://${hostname}/mcp`)).toThrow(/canonical DNS labels/);
  });

  it.each([
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
  ])("rejects noncanonical MCP URL path %#", (path) => {
    expect(() => normalizeMcpServerUrl(`https://mcp.example.test${path}`)).toThrow(
      /literal and canonical/,
    );
  });

  it.each([
    "https://qa-user:qa-pass-123@/mcp",
    "//qa-user:qa-pass-123@/mcp",
    "https:/qa-user:qa-pass-123@/mcp",
    "https://qa-user:qa-pass-123 extra@/mcp",
    "https://qa-user:qa-pass-123@/mcp/qa-pass-123",
  ])("rejects malformed credential-bearing URL vector %# without echoing it (#8698)", (rawUrl) => {
    const user = "qa-user";
    const password = "qa-pass-123";
    const captureMessage = (rawUrl: string): string => {
      try {
        normalizeMcpServerUrl(rawUrl);
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };

    const message = captureMessage(rawUrl);
    expect(message).toMatch(/must be an absolute https:\/\/ URL/);
    expect(message).not.toContain(user);
    expect(message).not.toContain(password);
    expect(message).not.toContain("/mcp");
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
