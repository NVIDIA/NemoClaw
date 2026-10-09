// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { runBuffered, runSshBuffered, executePrivilegedSandboxCommand } = vi.hoisted(() => ({
  runBuffered: vi.fn(),
  runSshBuffered: vi.fn(),
  executePrivilegedSandboxCommand: vi.fn(),
}));
vi.mock("../../adapters/openshell/sandbox-command-cli", () => ({
  runCliOpenShellBufferedCommand: runSshBuffered,
  createCliOpenShellSandboxCommandExecutor: () => ({ runBuffered }),
}));
vi.mock("../../sandbox/privileged-exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sandbox/privileged-exec")>()),
  executePrivilegedSandboxCommand,
}));
import { executeSandboxExecCommand } from "../../adapters/sandbox/command-transport";

describe("ordinary sandbox command execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runBuffered.mockReset().mockResolvedValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nok\n",
      stderr: "",
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("pins execution to the selected gateway and mTLS authority", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    const runtimeSelection = {
      gatewayName: "recorded-gateway",
      localTlsDir: "/authority/tls",
      workspace: "default",
    };
    const result = await executeSandboxExecCommand("alpha", "echo ok", 2000, {
      runtimeSelection,
    });
    expect(result).toEqual({ status: 0, stdout: "ok", stderr: "" });
    expect(runBuffered).toHaveBeenCalledOnce();
    const request = runBuffered.mock.calls[0][0];
    expect(request).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "recorded-gateway" },
      timeoutMilliseconds: 2000,
    });
    expect(request.environment).toMatchObject({
      OPENSHELL_GATEWAY: "recorded-gateway",
      OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      OPENSHELL_WORKSPACE: "default",
    });
    expect(request.environment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(request.environment).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
    expect(request.environment).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(request.command.slice(0, 5)).toEqual(["/bin/bash", "--noprofile", "--norc", "-p", "-c"]);
    expect(request.command[5]).toBe('builtin unset OPENCLAW_GATEWAY_TOKEN; builtin exec -- "$@"');
    expect(request.command.slice(7)).toEqual([
      "sh",
      "-c",
      "printf '%s\\n' '__NEMOCLAW_SANDBOX_EXEC_STARTED__'; echo ok",
    ]);
    expect(runSshBuffered).not.toHaveBeenCalled();
    expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("removes ambient mTLS when the selected gateway does not use it", async () => {
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    await executeSandboxExecCommand("alpha", "echo ok", undefined, {
      runtimeSelection: { gatewayName: "external-http", workspace: "default" },
    });
    expect(runBuffered.mock.calls[0][0].environment).not.toHaveProperty("OPENSHELL_LOCAL_TLS_DIR");
  });

  it.each(["cancelled", "timeout", "capture", "invocation", "unavailable", "malformed"])(
    "does not start SSH or privileged execution after %s",
    async (kind) => {
      runBuffered.mockResolvedValue({
        outcome:
          kind === "malformed"
            ? { kind: "completed", exitCode: 1 }
            : { kind: "failed", error: { kind, message: kind } },
        stdout: "untrusted partial output",
        stderr: "",
      });
      await expect(executeSandboxExecCommand("alpha", "mutate")).rejects.toMatchObject({ kind });
      expect(runBuffered).toHaveBeenCalledOnce();
      expect(runSshBuffered).not.toHaveBeenCalled();
      expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
    },
  );
});
