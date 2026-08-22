// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
}));

vi.mock("./gateway-rpc", () => ({
  callOpenclawGateway: vi.fn(),
  sandboxUsesHermesAgent: vi.fn(() => false),
}));

vi.mock("../exec", () => ({
  execSandbox: vi.fn(async () => undefined),
}));

const withLifecycleLockMock = vi.hoisted(() =>
  vi.fn(async (_sandboxName: string, operation: () => unknown) => await operation()),
);
vi.mock("../../../state/mcp-lifecycle-lock-acquisition", () => ({
  withMcpLifecycleLock: withLifecycleLockMock,
}));

import { execSandbox } from "../exec";
import { ensureLiveSandboxOrExit } from "../gateway-state";
import { deleteSandboxSession } from "./delete";
import { callOpenclawGateway, sandboxUsesHermesAgent } from "./gateway-rpc";

const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;
const gatewayMock = callOpenclawGateway as unknown as ReturnType<typeof vi.fn>;
const hermesAgentMock = sandboxUsesHermesAgent as unknown as ReturnType<typeof vi.fn>;
const execSandboxMock = execSandbox as unknown as ReturnType<typeof vi.fn>;

function successResult(key: string, extra: { removedTranscript?: boolean; entry?: unknown } = {}) {
  const payload = { ok: true as const, key, ...extra };
  return { payload, rawOutput: JSON.stringify(payload) };
}

function errorResult(code: string, message: string) {
  const payload = { ok: false as const, error: { code, message } };
  return { payload, rawOutput: JSON.stringify(payload) };
}

let processExitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ensureMock.mockClear();
  gatewayMock.mockReset();
  hermesAgentMock.mockReset();
  hermesAgentMock.mockReturnValue(false);
  execSandboxMock.mockReset();
  execSandboxMock.mockResolvedValue(undefined);
  withLifecycleLockMock.mockClear();
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit:${code ?? 0}`);
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
  consoleLogSpy.mockRestore();
});

describe("deleteSandboxSession", () => {
  it("dispatches sessions.delete with deleteTranscript=true by default", async () => {
    gatewayMock.mockReturnValue(successResult("agent:main:slot-1"));

    const result = await deleteSandboxSession("sb-1", {
      key: "agent:main:slot-1",
    });

    expect(ensureMock).toHaveBeenCalledWith("sb-1", {
      allowNonReadyPhase: true,
      exit: expect.any(Function),
    });
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock.mock.calls[0]?.[0]).toMatchObject({
      sandboxName: "sb-1",
      method: "sessions.delete",
      params: { key: "agent:main:slot-1", deleteTranscript: true },
    });
    expect(result.removedTranscript).toBe(true);
    expect(result.key).toBe("agent:main:slot-1");
  });

  it("defers an OpenClaw readiness exit through lifecycle authority (#9203)", async () => {
    ensureMock.mockImplementationOnce(async (_sandboxName, options) => options.exit(1));

    await expect(deleteSandboxSession("sb-1", { key: "agent:main:slot-1" })).rejects.toThrow(
      /process\.exit:1/,
    );

    expect(withLifecycleLockMock).toHaveBeenCalledOnce();
    expect(gatewayMock).not.toHaveBeenCalled();
  });

  it("translates --keep-transcript into deleteTranscript=false", async () => {
    gatewayMock.mockReturnValue(successResult("agent:main:slot-1", { removedTranscript: false }));

    const result = await deleteSandboxSession("sb-1", {
      key: "agent:main:slot-1",
      keepTranscript: true,
    });

    expect(gatewayMock.mock.calls[0]?.[0]?.params).toMatchObject({
      deleteTranscript: false,
    });
    expect(result.removedTranscript).toBe(false);
  });

  it("rejects --agent mismatch against the session-key agent", async () => {
    await expect(
      deleteSandboxSession("sb-1", {
        key: "agent:main:slot-1",
        agent: "research",
      }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(gatewayMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /Refusing to invoke sessions\.delete.*scoped to agent 'main', not 'research'/,
    );
  });

  it("surfaces a gateway failure payload and exits non-zero", async () => {
    gatewayMock.mockReturnValue(errorResult("E_LOCKED", "session locked"));

    await expect(deleteSandboxSession("sb-1", { key: "agent:main:slot-1" })).rejects.toThrow(
      /process\.exit:1/,
    );

    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /Gateway refused sessions\.delete.*\[E_LOCKED\] session locked/,
    );
  });

  it("rejects an unexpected payload (missing key) and exits non-zero", async () => {
    gatewayMock.mockReturnValue({
      payload: { ok: true, /* key missing */ removedTranscript: true },
      rawOutput: '{"ok":true,"removedTranscript":true}',
    });

    await expect(deleteSandboxSession("sb-1", { key: "agent:main:slot-1" })).rejects.toThrow(
      /process\.exit:1/,
    );

    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /unexpected sessions\.delete payload/,
    );
  });

  it("emits one JSON line when --json is set", async () => {
    gatewayMock.mockReturnValue(successResult("agent:main:slot-1", { entry: { id: "abc" } }));

    await deleteSandboxSession("sb-1", {
      key: "agent:main:slot-1",
      json: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const printed = String(consoleLogSpy.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(printed)).toEqual({
      key: "agent:main:slot-1",
      removedTranscript: true,
      entry: { id: "abc" },
    });
  });

  it("builds the canonical key under the requested agent when only --agent is provided", async () => {
    gatewayMock.mockReturnValue(successResult("agent:research:slot"));

    await deleteSandboxSession("sb-1", {
      key: "slot",
      agent: "research",
    });

    expect(gatewayMock.mock.calls[0]?.[0]?.params).toMatchObject({
      key: "agent:research:slot",
    });
  });

  it("falls back to deleteTranscript flag when gateway omits removedTranscript", async () => {
    gatewayMock.mockReturnValue(successResult("agent:main:slot-1"));

    const result = await deleteSandboxSession("sb-1", {
      key: "agent:main:slot-1",
      keepTranscript: true,
    });

    expect(result.removedTranscript).toBe(false);
  });
});

describe("deleteSandboxSession (hermes sandbox)", () => {
  beforeEach(() => {
    hermesAgentMock.mockReturnValue(true);
    // execSandbox streams the native output and exits the process with its
    // code; model that terminal behavior so the routing never returns a value.
    execSandboxMock.mockImplementation(async (_name, _command, _options, deps) => {
      deps.exit(0);
    });
  });

  it("routes to the native hermes sessions delete without the OpenClaw gateway (#7642)", async () => {
    await expect(deleteSandboxSession("sb-h", { key: "20260727_130357_cb2b61" })).rejects.toThrow(
      /process\.exit:0/,
    );

    expect(gatewayMock).not.toHaveBeenCalled();
    expect(ensureMock).toHaveBeenCalledWith("sb-h", {
      allowNonReadyPhase: true,
      exit: expect.any(Function),
    });
    expect(execSandboxMock).toHaveBeenCalledWith(
      "sb-h",
      ["hermes", "sessions", "delete", "20260727_130357_cb2b61", "--yes"],
      {},
      expect.objectContaining({ exit: expect.any(Function) }),
    );
  });

  it("passes the native hermes session id through without OpenClaw canonicalization (#7642)", async () => {
    await expect(deleteSandboxSession("sb-h", { key: "20260727_121145_238595" })).rejects.toThrow(
      /process\.exit:0/,
    );

    expect(execSandboxMock.mock.calls[0]?.[1]).toContain("20260727_121145_238595");
    expect(execSandboxMock.mock.calls[0]?.[1]?.join(" ")).not.toContain("agent:");
  });

  it("rejects the OpenClaw-only --agent flag on a hermes sandbox (#7642)", async () => {
    await expect(
      deleteSandboxSession("sb-h", { key: "20260727_130357_cb2b61", agent: "research" }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(execSandboxMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /--agent.*OpenClaw-only.*not supported on a Hermes sandbox/,
    );
  });

  it("rejects the OpenClaw-only --keep-transcript flag on a hermes sandbox (#7642)", async () => {
    await expect(
      deleteSandboxSession("sb-h", { key: "20260727_130357_cb2b61", keepTranscript: true }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(execSandboxMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /--keep-transcript.*OpenClaw-only.*not supported on a Hermes sandbox/,
    );
  });

  it("rejects --agent hermes instead of silently ignoring the OpenClaw-only flag (#7642)", async () => {
    await expect(
      deleteSandboxSession("sb-h", { key: "20260727_130357_cb2b61", agent: "hermes" }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(execSandboxMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /--agent hermes.*OpenClaw-only.*not supported on a Hermes sandbox/,
    );
  });

  it.each([
    ["json", { json: true }],
    ["verbose", { verbose: true }],
  ])("rejects the OpenClaw-only --%s flag on a hermes sandbox (#7642)", async (_flag, extra) => {
    await expect(
      deleteSandboxSession("sb-h", { key: "20260727_130357_cb2b61", ...extra }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(execSandboxMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /--json and --verbose.*OpenClaw-only/,
    );
  });

  it.each([
    ["a leading dash that could parse as a flag", "--yes"],
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["embedded whitespace", "2026 0727"],
  ])("rejects an invalid hermes session id (%s) (#7642)", async (_case, key) => {
    await expect(deleteSandboxSession("sb-h", { key })).rejects.toThrow(/process\.exit:1/);

    expect(execSandboxMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(/session id/i);
  });

});
