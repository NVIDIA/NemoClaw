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
import { deleteSandboxSession } from "./delete";

const ensureMock = ensureLiveSandboxOrExit as unknown as ReturnType<typeof vi.fn>;
const gatewayMock = callOpenclawGateway as unknown as ReturnType<typeof vi.fn>;

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

    expect(ensureMock).toHaveBeenCalledWith("sb-1", { allowNonReadyPhase: true });
    expect(gatewayMock).toHaveBeenCalledTimes(1);
    expect(gatewayMock.mock.calls[0]?.[0]).toMatchObject({
      sandboxName: "sb-1",
      method: "sessions.delete",
      params: { key: "agent:main:slot-1", deleteTranscript: true },
    });
    expect(result.removedTranscript).toBe(true);
    expect(result.key).toBe("agent:main:slot-1");
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
