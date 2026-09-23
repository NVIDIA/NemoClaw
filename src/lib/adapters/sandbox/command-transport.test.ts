// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  OpenShellSandboxBufferedCommandCompletion,
  OpenShellSandboxBufferedCommandExecutor,
} from "../openshell/sandbox-command";
import { namedOpenShellGateway } from "../openshell/sandbox-observer";
import { executeSandboxExecCommandTransport } from "./command-transport";

function fixture(
  completion: OpenShellSandboxBufferedCommandCompletion = {
    outcome: { kind: "completed", exitCode: 0 },
    stdout: "ok",
    stderr: "",
  },
) {
  return {
    buildSandboxExecMarkedCommand: vi.fn((command: string) => `marked:${command}`),
    buildSubprocessEnv: vi.fn(() => ({ PATH: "/usr/bin" })),
    extractSandboxExecCommandStdout: vi.fn((output: string) => output),
    commandExecutor: {
      runBuffered: vi.fn<OpenShellSandboxBufferedCommandExecutor["runBuffered"]>(
        async () => completion,
      ),
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("native sandbox command transport", () => {
  it("preserves the named gateway, sanitized environment, command, and timeout", async () => {
    const deps = fixture();
    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "printf '%s' 'a b'", 9000, {
        gatewayName: "recorded-gateway",
        runtimeEnv: { PATH: "/pinned/bin" },
      }),
    ).resolves.toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(deps.commandExecutor.runBuffered).toHaveBeenCalledExactlyOnceWith({
      sandboxName: "alpha",
      target: namedOpenShellGateway("recorded-gateway"),
      command: ["sh", "-c", "marked:printf '%s' 'a b'"],
      environment: { PATH: "/pinned/bin" },
      timeoutMilliseconds: 9000,
    });
  });

  it.each([0, 7, 255])("returns remote exit %s without retrying", async (exitCode) => {
    const deps = fixture({
      outcome: { kind: "completed", exitCode },
      stdout: "out",
      stderr: "err\n",
    });
    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {}),
    ).resolves.toEqual({ status: exitCode, stdout: "out", stderr: "err" });
    expect(deps.commandExecutor.runBuffered).toHaveBeenCalledOnce();
  });

  it.each(["cancelled", "timeout", "capture", "invocation", "unavailable"] as const)(
    "reports %s distinctly without repeating the command",
    async (kind) => {
      const deps = fixture({
        outcome: { kind: "failed", error: { kind, message: "untrusted detail" } },
        stdout: "partial",
        stderr: "detail",
      });
      await expect(
        executeSandboxExecCommandTransport(deps, "alpha", "mutate", 9000, {}),
      ).rejects.toMatchObject({ name: "SandboxCommandTransportError", kind });
      expect(deps.commandExecutor.runBuffered).toHaveBeenCalledOnce();
      expect(deps.extractSandboxExecCommandStdout).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed output without repeating an ambiguous mutation", async () => {
    const deps = fixture();
    deps.extractSandboxExecCommandStdout = vi.fn(() => null) as never;
    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "mutate", 9000, {}),
    ).rejects.toMatchObject({ kind: "malformed" });
    expect(deps.commandExecutor.runBuffered).toHaveBeenCalledOnce();
  });

  it("propagates an authority refusal without retrying", async () => {
    const deps = fixture();
    const refusal = new Error("gateway authority refused");
    deps.commandExecutor.runBuffered.mockRejectedValue(refusal);
    await expect(
      executeSandboxExecCommandTransport(deps, "alpha", "mutate", 9000, {}),
    ).rejects.toBe(refusal);
    expect(deps.commandExecutor.runBuffered).toHaveBeenCalledOnce();
  });

  it.each([
    ["50", 50],
    ["invalid", 9000],
    ["0", 9000],
    ["-1", 9000],
  ])("uses timeout override %s only when positive", async (value, expected) => {
    vi.stubEnv("NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS", value);
    const deps = fixture();
    await executeSandboxExecCommandTransport(deps, "alpha", "id", 9000, {});
    expect(deps.commandExecutor.runBuffered).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMilliseconds: expected }),
    );
  });
  it("keeps a caller-owned deadline while ordinary commands retain the ambient override", async () => {
    vi.stubEnv("NEMOCLAW_SANDBOX_EXEC_TIMEOUT_MS", "60000");
    const deps = fixture();
    await executeSandboxExecCommandTransport(deps, "alpha", "id", 300, {
      honorCallerTimeout: true,
    });
    await executeSandboxExecCommandTransport(deps, "alpha", "id", 300, {});
    expect(
      deps.commandExecutor.runBuffered.mock.calls.map(([request]) => request.timeoutMilliseconds),
    ).toEqual([300, 60000]);
  });
});
