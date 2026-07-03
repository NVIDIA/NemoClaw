// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  addMcpBridge,
  buildMcpBridgeProviderArgs,
  dispatchMcpBridgeCommand,
  redactCredentialValuesForDisplay,
  resolveCredentialEnv,
} from "./mcp-bridge";

describe("MCP input runtime boundaries", () => {
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
