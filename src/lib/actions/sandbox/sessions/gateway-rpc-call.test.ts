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
    const command = captureMock.mock.calls[0]?.[0];
    expect(command).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "--",
      "bash",
      "-lc",
      expect.stringContaining("/tmp/nemoclaw-proxy-env.sh"),
      "nemoclaw-sessions-admin-rpc",
      expect.stringContaining("data:text/javascript;base64"),
      expect.any(String),
      "sessions.reset",
      Buffer.from('{"key":"agent:main:main","reason":"reset"}', "utf8").toString("base64"),
    ]);
    expect(command?.[7]).toContain("node --input-type=module");
    expect(command?.[7]).toContain("NEMOCLAW_GATEWAY_RPC_METHOD");
    expect(command?.[7]).toContain("NEMOCLAW_GATEWAY_RPC_PARAMS_B64");
    const script = Buffer.from(String(command?.[10] ?? ""), "base64").toString("utf8");
    expect(script).toContain("callGatewayFromCli");
    expect(script).toContain("url: `ws://127.0.0.1:${port}`");
    expect(script).toContain('clientName: "gateway-client"');
    expect(script).toContain('mode: "backend"');
    expect(script).toContain('scopes: ["operator.admin"]');
    expect(captureMock.mock.calls[0]?.[1]).toMatchObject({
      ignoreError: true,
      includeStderr: true,
    });
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
