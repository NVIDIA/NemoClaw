// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { McpBridgeEntry, SandboxEntry } from "../../state/registry";

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  runOpenshellProviderCommand: vi.fn(),
}));

vi.mock("../../state/registry", () => ({
  getSandbox: mocks.getSandbox,
}));

vi.mock("../../actions/global", () => ({
  runOpenshellProviderCommand: mocks.runOpenshellProviderCommand,
}));

import {
  assertHermesMcpRuntimeIntent,
  inspectHermesMcpRuntimeIntent,
} from "./mcp-bridge-hermes-reconciliation";

const entry: McpBridgeEntry = {
  server: "github",
  agent: "hermes",
  adapter: "hermes-config",
  url: "https://api.githubcopilot.com/mcp/",
  env: ["GITHUB_TOKEN"],
  providerName: "alpha-mcp-github",
  providerId: "11111111-2222-4333-8444-555555555555",
  policyName: "mcp-bridge-github",
  addedAt: new Date(0).toISOString(),
};

function sandbox(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "alpha",
    agent: "hermes",
    mcp: {
      bridges: { github: entry },
      managedServerNames: ["github", "retired"],
    },
    ...overrides,
  };
}

describe("Hermes MCP host reconciliation", () => {
  beforeEach(() => {
    mocks.getSandbox.mockReset().mockReturnValue(sandbox());
    mocks.runOpenshellProviderCommand.mockReset().mockReturnValue({
      status: 0,
      stdout: '{"ok":true,"state":"matched"}\n',
      stderr: "",
    });
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  it("sends the complete credential-safe present and absent projection", () => {
    expect(inspectHermesMcpRuntimeIntent("alpha")).toEqual({ ok: true, state: "matched" });

    const [args, options] = mocks.runOpenshellProviderCommand.mock.calls[0];
    expect(args.slice(0, 8)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--timeout",
      "45",
      "--no-tty",
      "--",
    ]);
    expect(args.slice(8, 11)).toEqual([
      "/usr/local/lib/nemoclaw/hermes-mcp-config-transaction.py",
      "inspect",
      "--payload",
    ]);
    expect(JSON.parse(args[11])).toEqual({
      present: {
        github: {
          url: "https://api.githubcopilot.com/mcp/",
          enabled: true,
          timeout: 120,
          connect_timeout: 60,
          tools: { resources: true, prompts: true },
          headers: { Authorization: "Bearer openshell:resolve:env:GITHUB_TOKEN" },
        },
      },
      absent: ["retired"],
    });
    expect(JSON.stringify(args)).not.toContain("host-only-secret");
    expect(options).toMatchObject({ ignoreError: true, timeout: 60_000 });
  });

  it("can inspect a removal intent while retaining the removed name as a tombstone", () => {
    expect(
      inspectHermesMcpRuntimeIntent("alpha", {
        entries: [],
        managedServerNames: ["github", "retired"],
      }),
    ).toEqual({ ok: true, state: "matched" });

    expect(JSON.parse(mocks.runOpenshellProviderCommand.mock.calls[0][0][11])).toEqual({
      present: {},
      absent: ["github", "retired"],
    });
  });

  it("fails closed and sanitizes helper stdout and stderr", () => {
    process.env.GITHUB_TOKEN = "host-only-secret";
    mocks.runOpenshellProviderCommand.mockReturnValue({
      status: 2,
      stdout: "\x1b[32mFORGED SUCCESS\x1b[0m\ngeneric ghp_0123456789abcdefghij",
      stderr: "Hermes MCP config drifted: host-only-secret\r\n\x1b]0;spoof\x07SECOND",
    });

    expect(inspectHermesMcpRuntimeIntent("alpha")).toEqual({
      ok: false,
      state: "mismatch",
      detail: "Hermes MCP config drifted: ***REDACTED*** SECOND FORGED SUCCESS generic <REDACTED>",
    });
    expect(() => assertHermesMcpRuntimeIntent("alpha")).toThrow(
      /does not match the persisted managed intent/,
    );
  });

  it("sanitizes thrown helper failures before returning or throwing them", () => {
    process.env.GITHUB_TOKEN = "host-only-secret";
    mocks.runOpenshellProviderCommand.mockImplementation(() => {
      throw new Error(
        "\x1b[31mhelper failed\x1b[0m\nFORGED READY host-only-secret sk-proj-0123456789abcdef",
      );
    });

    expect(inspectHermesMcpRuntimeIntent("alpha")).toEqual({
      ok: false,
      state: "error",
      detail: "helper failed FORGED READY ***REDACTED*** <REDACTED>",
    });

    let thrown: unknown;
    try {
      assertHermesMcpRuntimeIntent("alpha");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toMatch(/[\r\n\x1b]/);
    expect((thrown as Error).message).not.toContain("host-only-secret");
    expect((thrown as Error).message).not.toContain("sk-proj-0123456789abcdef");
    expect((thrown as Error).message).toContain(
      "helper failed FORGED READY ***REDACTED*** <REDACTED>",
    );
  });

  it("does not execute the Hermes helper for an untracked non-Hermes sandbox", () => {
    mocks.getSandbox.mockReturnValue({ name: "alpha", agent: "openclaw" });

    expect(inspectHermesMcpRuntimeIntent("alpha")).toEqual({
      ok: true,
      state: "not-applicable",
    });
    expect(mocks.runOpenshellProviderCommand).not.toHaveBeenCalled();
  });

  it("fails closed when a Hermes bridge is attached to another explicit agent", () => {
    mocks.getSandbox.mockReturnValue(sandbox({ agent: "openclaw" }));

    expect(inspectHermesMcpRuntimeIntent("alpha")).toEqual({
      ok: false,
      state: "error",
      detail: "Registry entry agent mismatch for Hermes MCP sandbox 'alpha'.",
    });
    expect(mocks.runOpenshellProviderCommand).not.toHaveBeenCalled();
  });

  it("retains the Hermes adapter fallback for legacy entries without an agent", () => {
    mocks.getSandbox.mockReturnValue(sandbox({ agent: null }));

    expect(inspectHermesMcpRuntimeIntent("alpha")).toEqual({ ok: true, state: "matched" });
    expect(mocks.runOpenshellProviderCommand).toHaveBeenCalledOnce();
  });

  it("fails closed when a corrupted registry key returns another sandbox name", () => {
    mocks.getSandbox.mockReturnValue(sandbox({ name: "other" }));

    expect(inspectHermesMcpRuntimeIntent("alpha")).toEqual({
      ok: false,
      state: "error",
      detail: "Registry entry name mismatch for sandbox 'alpha'.",
    });
    expect(mocks.runOpenshellProviderCommand).not.toHaveBeenCalled();
  });
});
