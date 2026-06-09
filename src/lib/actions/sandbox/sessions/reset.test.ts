// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../gateway-state", () => ({
  ensureLiveSandboxOrExit: vi.fn(async () => undefined),
}));

vi.mock("./gateway-rpc", () => ({
  callOpenclawGateway: vi.fn(),
}));

import { ensureLiveSandboxOrExit } from "../gateway-state";
import { callOpenclawGateway } from "./gateway-rpc";
import { resetSandboxSession } from "./reset";

const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;
const gatewayMock = callOpenclawGateway as unknown as ReturnType<typeof vi.fn>;

function successResult(key: string, entry: unknown = null) {
  const payload = { ok: true as const, key, entry };
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

describe("resetSandboxSession", () => {
  it("dispatches sessions.reset with the canonical key and default reason 'reset'", async () => {
    gatewayMock.mockReturnValue(successResult("agent:main:main"));

    const result = await resetSandboxSession("sb-1", {
      key: "agent:main:main",
    });

    expect(ensureMock).toHaveBeenCalledWith("sb-1", { allowNonReadyPhase: true });
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock.mock.calls[0]?.[0]).toMatchObject({
      sandboxName: "sb-1",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });
    expect(result).toEqual({ key: "agent:main:main", reason: "reset", entry: null });
  });

  it("forwards reason='new' when requested", async () => {
    gatewayMock.mockReturnValue(successResult("agent:main:main"));

    await resetSandboxSession("sb-1", {
      key: "agent:main:main",
      reason: "new",
    });

    expect(gatewayMock.mock.calls[0]?.[0]?.params).toMatchObject({ reason: "new" });
  });

  it("rejects --agent mismatch against the session-key agent", async () => {
    await expect(
      resetSandboxSession("sb-1", {
        key: "agent:main:main",
        agent: "research",
      }),
    ).rejects.toThrow(/process\.exit:1/);

    expect(gatewayMock).not.toHaveBeenCalled();
    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /Refusing to invoke sessions\.reset.*scoped to agent 'main', not 'research'/,
    );
  });

  it("surfaces a gateway failure payload and exits non-zero", async () => {
    gatewayMock.mockReturnValue(errorResult("E_NOT_FOUND", "no such session"));

    await expect(resetSandboxSession("sb-1", { key: "agent:main:main" })).rejects.toThrow(
      /process\.exit:1/,
    );

    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /Gateway refused sessions\.reset.*\[E_NOT_FOUND\] no such session/,
    );
  });

  it("rejects an unexpected payload (missing key) and exits non-zero", async () => {
    gatewayMock.mockReturnValue({
      payload: { ok: true, /* key missing */ entry: null },
      rawOutput: '{"ok":true,"entry":null}',
    });

    await expect(resetSandboxSession("sb-1", { key: "agent:main:main" })).rejects.toThrow(
      /process\.exit:1/,
    );

    expect(consoleErrorSpy.mock.calls.flat().join("\n")).toMatch(
      /unexpected sessions\.reset payload/,
    );
  });

  it("emits one JSON line when --json is set", async () => {
    gatewayMock.mockReturnValue(successResult("agent:main:main", { id: "abc" }));

    await resetSandboxSession("sb-1", {
      key: "agent:main:main",
      json: true,
    });

    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const printed = String(consoleLogSpy.mock.calls[0]?.[0] ?? "");
    expect(JSON.parse(printed)).toEqual({
      key: "agent:main:main",
      reason: "reset",
      entry: { id: "abc" },
    });
  });

  it("builds the canonical key under the requested agent when only --agent is provided", async () => {
    gatewayMock.mockReturnValue(successResult("agent:research:slot"));

    await resetSandboxSession("sb-1", {
      key: "slot",
      agent: "research",
    });

    expect(gatewayMock.mock.calls[0]?.[0]?.params).toMatchObject({
      key: "agent:research:slot",
    });
  });
});
