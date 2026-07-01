// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { McpBridgeEntry } from "../../state/registry";
import { commandOutput, redactBridgeSecretsForDisplay } from "./mcp-bridge-output";

const baseEntry: McpBridgeEntry = {
  server: "github",
  agent: "openclaw",
  adapter: "mcporter",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

describe("MCP adapter output redaction", () => {
  it("redacts credential values from adapter display output", () => {
    const prior = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "real-host-secret";
    try {
      const redacted = redactBridgeSecretsForDisplay(
        "failed header Authorization=Bearer real-host-secret raw real-host-secret",
        baseEntry,
      );

      expect(redacted).toBe("failed header Authorization=Bearer ***REDACTED***");
    } finally {
      prior === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = prior);
    }
  });

  it("redacts inline credential values that were not exported in host env", () => {
    const prior = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const redacted = redactBridgeSecretsForDisplay(
        "adapter echoed Authorization=Bearer inline-provider-secret and inline-provider-secret",
        baseEntry,
        { GITHUB_TOKEN: "inline-provider-secret" },
      );

      expect(redacted).toBe("adapter echoed Authorization=Bearer ***REDACTED***");
    } finally {
      prior === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = prior);
    }
  });

  it("redacts resolved Authorization bearer values even without host env access", () => {
    const prior = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const redacted = redactBridgeSecretsForDisplay(
        '{"headers":{"Authorization":"Bearer resolved-provider-secret"},"raw":"Authorization: Bearer another-secret","status":"kept"}',
        baseEntry,
      );

      expect(redacted).toBe(
        '{"headers":{"Authorization":"Bearer ***REDACTED***"},"raw":"Authorization: Bearer ***REDACTED***","status":"kept"}',
      );
      expect(JSON.parse(redacted)).toMatchObject({ status: "kept" });
    } finally {
      prior === undefined ? delete process.env.GITHUB_TOKEN : (process.env.GITHUB_TOKEN = prior);
    }
  });

  it("redacts overlapping raw values longest-first and removes display controls", () => {
    const redacted = redactBridgeSecretsForDisplay(
      "Authorization: raw-long-secret raw-long-secret raw\u001b[31m",
      { env: ["LONG", "SHORT"] },
      { LONG: "raw-long-secret", SHORT: "raw" },
    );

    expect(redacted).toBe("Authorization: ***REDACTED***");
    expect(redacted).not.toContain("secret");
    expect(redacted).not.toContain("\u001b");
  });

  it("fully redacts generic bearer and authorization values", () => {
    const redacted = redactBridgeSecretsForDisplay(
      'Bearer opaque-value Authorization="second-value"',
    );

    expect(redacted).toBe('Bearer ***REDACTED*** Authorization="***REDACTED***"');
    expect(redacted).not.toContain("opaque-value");
    expect(redacted).not.toContain("second-value");
  });

  it("bounds generic values to one line while preserving quoted structured output", () => {
    const redacted = redactBridgeSecretsForDisplay(
      [
        "Authorization: Bearer alpha beta, gamma",
        "next line kept",
        '{"Authorization":"Bearer quoted secret,with,commas","status":"kept"}',
        "MCP_TOKEN='assignment secret,with commas' status=kept",
      ].join("\n"),
    );

    expect(redacted).toBe(
      [
        "Authorization: Bearer ***REDACTED***",
        "next line kept",
        '{"Authorization":"Bearer ***REDACTED***","status":"kept"}',
        "MCP_TOKEN='***REDACTED***' status=kept",
      ].join("\n"),
    );
  });

  it("removes display controls before recognizing and redacting sensitive keys", () => {
    const redacted = redactBridgeSecretsForDisplay(
      "Authori\u001bzation: Bearer alpha\u0000 beta\nnext line kept",
    );

    expect(redacted).toBe("Authorization: Bearer ***REDACTED***\nnext line kept");
    expect(redacted).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
  });

  it("strips ANSI before redacting split credential values from command output", () => {
    const secret = "ansi-split-secret";
    const redacted = commandOutput(
      {
        status: 0,
        stdout: `\u001b[2mId:\u001b[0m provider-id\nraw ${secret.slice(0, 5)}\u001b[31m${secret.slice(5)}\u001b[0m`,
        stderr: "",
      },
      { MCP_TOKEN: secret },
    );

    expect(redacted).toBe("Id: provider-id\nraw ***REDACTED***");
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain("\u001b");
  });
});
