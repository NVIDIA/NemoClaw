// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../adapters/openshell/runtime", () => ({
  captureOpenshell: vi.fn(),
}));

vi.mock("../auto-pair-approval", () => ({
  runSandboxAutoPairApprovalPass: vi.fn(),
}));

import { captureOpenshell } from "../../../adapters/openshell/runtime";
import { runSandboxAutoPairApprovalPass } from "../auto-pair-approval";
import { callOpenclawGateway } from "./gateway-rpc";

const captureMock = captureOpenshell as unknown as ReturnType<typeof vi.fn>;
const autoPairMock = runSandboxAutoPairApprovalPass as unknown as ReturnType<typeof vi.fn>;

function captureResult(status: number, output: string) {
  return { status, output, error: undefined as Error | undefined };
}

let processExitSpy: ReturnType<typeof vi.spyOn>;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  captureMock.mockReset();
  autoPairMock.mockReset();
  processExitSpy = vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit:${code ?? 0}`);
  });
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  processExitSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

describe("callOpenclawGateway", () => {
  it("runs the bounded auto-pair pass before dispatching the gateway RPC", () => {
    captureMock.mockReturnValue(captureResult(0, '{"ok":true,"key":"agent:main:main"}'));

    const result = callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    expect(autoPairMock).toHaveBeenCalledTimes(1);
    expect(autoPairMock).toHaveBeenCalledWith("alpha");
    expect(captureMock).toHaveBeenCalledTimes(1);
    expect(captureMock.mock.calls[0]?.[0]).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "env",
      "-u",
      "OPENCLAW_GATEWAY_URL",
      "-u",
      "OPENCLAW_GATEWAY_PORT",
      "-u",
      "OPENCLAW_GATEWAY_TOKEN",
      "openclaw",
      "gateway",
      "call",
      "sessions.reset",
      "--params",
      '{"key":"agent:main:main","reason":"reset"}',
      "--json",
    ]);
    expect(result.payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });

  it("runs a second auto-pair pass and retries once for pairing-pending failures", () => {
    captureMock
      .mockReturnValueOnce(
        captureResult(
          1,
          "GatewayClientRequestError: scope upgrade pending approval (requestId: r-1)",
        ),
      )
      .mockReturnValueOnce(captureResult(0, '{"ok":true,"key":"agent:main:main"}'));

    const result = callOpenclawGateway({
      sandboxName: "alpha",
      method: "sessions.reset",
      params: { key: "agent:main:main", reason: "reset" },
    });

    expect(autoPairMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(result.payload).toMatchObject({ ok: true, key: "agent:main:main" });
  });

  it("does not retry unrelated gateway failures", () => {
    captureMock.mockReturnValue(captureResult(1, "openclaw gateway crashed"));

    expect(() =>
      callOpenclawGateway({
        sandboxName: "alpha",
        method: "sessions.reset",
        params: { key: "agent:main:main", reason: "reset" },
      }),
    ).toThrow(/process\.exit:1/);

    expect(autoPairMock).toHaveBeenCalledTimes(1);
    expect(captureMock).toHaveBeenCalledTimes(1);
  });
});
