// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runSshBuffered = vi.hoisted(() => vi.fn());
const executePrivilegedSandboxCommand = vi.hoisted(() => vi.fn());
const runBuffered = vi.hoisted(() => vi.fn());

vi.mock("../../adapters/openshell/sandbox-command-cli", () => ({
  runCliOpenShellBufferedCommand: runSshBuffered,
  createCliOpenShellSandboxCommandExecutor: vi.fn(() => ({ runBuffered })),
}));

vi.mock("../../adapters/openshell/resolve", () => ({
  resolveOpenshell: () => "openshell",
}));

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  captureOpenshell: vi.fn(),
  captureOpenshellForStatus: vi.fn(),
  getOpenshellBinary: vi.fn(() => "openshell"),
  isCommandTimeout: vi.fn(() => false),
  runOpenshell: vi.fn(),
}));

vi.mock("../../sandbox/privileged-exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sandbox/privileged-exec")>()),
  executePrivilegedSandboxCommand,
}));

vi.mock("../../runner", () => ({
  ROOT: "/repo",
  shellQuote: (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`,
}));

import { executeSandboxCommand, executeSandboxExecCommand } from "./process-recovery";

describe("executeSandboxCommand temp SSH config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runSshBuffered.mockReset();
    runBuffered.mockResolvedValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "",
      stderr: "",
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins SSH config and command execution to one authority-derived mTLS target (#10514)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    runSshBuffered
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        status: 0,
        stderr: "",
        stdout: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
      });
    runSshBuffered.mockResolvedValueOnce({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    expect(
      await executeSandboxCommand("alpha", "echo ok", {
        runtimeSelection: {
          gatewayName: "nemoclaw-8091",
          localTlsDir: "/authority/tls",
          workspace: "default",
        },
      }),
    ).toEqual({ status: 0, stdout: "ok", stderr: "" });

    const captureOptions = runSshBuffered.mock.calls[1]?.[2];
    expect(captureOptions).toMatchObject({
      environment: {
        OPENSHELL_GATEWAY: "nemoclaw-8091",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        OPENSHELL_WORKSPACE: "default",
      },
    });
    expect(captureOptions?.environment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(captureOptions?.environment).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
    expect(captureOptions?.environment).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(runSshBuffered.mock.calls[2]?.[2]?.environment).toEqual(captureOptions?.environment);
  });

  it("removes ambient mTLS when the selected gateway does not use it (#10514)", async () => {
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    runSshBuffered
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        status: 0,
        stderr: "",
        stdout: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
      });
    runSshBuffered.mockResolvedValueOnce({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    await executeSandboxCommand("alpha", "echo ok", {
      runtimeSelection: { gatewayName: "external-http", workspace: "default" },
    });

    expect(runSshBuffered.mock.calls[1]?.[2]?.environment).not.toHaveProperty(
      "OPENSHELL_LOCAL_TLS_DIR",
    );
    expect(runSshBuffered.mock.calls[2]?.[2]?.environment).not.toHaveProperty(
      "OPENSHELL_LOCAL_TLS_DIR",
    );
  });

  it("pins strict OpenShell exec to the same authority-derived target (#10514)", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    runBuffered.mockResolvedValue({
      outcome: { kind: "completed", exitCode: 0 },
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nrevision-1\n",
      stderr: "",
    });

    await expect(
      executeSandboxExecCommand("alpha", "printf revision-1", undefined, {
        runtimeSelection: {
          gatewayName: "nemoclaw-8091",
          localTlsDir: "/authority/tls",
          workspace: "default",
        },
      }),
    ).resolves.toEqual({ status: 0, stdout: "revision-1", stderr: "" });

    const request = runBuffered.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      sandboxName: "alpha",
      target: { kind: "named", gatewayName: "nemoclaw-8091" },
      command: ["sh", "-c", expect.stringContaining("printf revision-1")],
    });
    expect(request?.environment).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-8091",
      OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      OPENSHELL_WORKSPACE: "default",
    });
    expect(request?.environment).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(request?.environment).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
    expect(request?.environment).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("fails closed instead of using a same-name local sandbox for selected exec (#10514)", async () => {
    runBuffered.mockResolvedValue({
      outcome: { kind: "completed", exitCode: 1 },
      stdout: "selected gateway unavailable\n",
      stderr: "",
    });
    executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nlocal-same-name\n",
      stderr: "",
    });

    await expect(
      executeSandboxExecCommand("alpha", "printf selected", undefined, {
        localDockerFallbackPolicy: "read-only",
        runtimeSelection: {
          gatewayName: "recorded-gateway",
          localTlsDir: "/authority/tls",
          workspace: "default",
        },
      }),
    ).resolves.toBeNull();
    expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("uses the exact legacy alias while backing up a pre-upgrade sandbox", async () => {
    runSshBuffered
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        status: 0,
        stderr: "",
        stdout: "Host openshell-alpha\n  HostName 127.0.0.1\n",
      });
    runSshBuffered.mockResolvedValueOnce({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = await executeSandboxCommand("alpha", "echo ok");

    expect(result).toEqual({ status: 0, stdout: "ok", stderr: "" });
    const sshArgs = runSshBuffered.mock.calls[2]?.[1] as string[];
    const configFile = sshArgs[sshArgs.indexOf("-F") + 1];
    const configDir = path.dirname(configFile);
    expect(configDir).not.toBe(os.tmpdir());
    expect(path.basename(configDir)).toMatch(/^nemoclaw-ssh-/);
    expect(path.basename(configFile)).toBe("ssh_config");
    expect(sshArgs).toContain("openshell-alpha");
    expect(sshArgs).not.toContain("openshell-alpha.default");
    expect(fs.existsSync(configDir)).toBe(false);
  });

  it("uses the workspace-qualified alias emitted by OpenShell v0.0.99", async () => {
    runSshBuffered
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        status: 0,
        stderr: "",
        stdout: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
      });
    runSshBuffered.mockResolvedValueOnce({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    expect(await executeSandboxCommand("alpha", "echo ok")).toEqual({
      status: 0,
      stdout: "ok",
      stderr: "",
    });

    const sshArgs = runSshBuffered.mock.calls[2]?.[1] as string[];
    expect(sshArgs).toContain("openshell-alpha.default");
    expect(sshArgs).not.toContain("openshell-alpha");
  });

  it("returns null without creating an SSH process when config capture fails", async () => {
    runSshBuffered
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ status: 1, stdout: "", stderr: "" });

    expect(await executeSandboxCommand("alpha", "echo ok")).toBeNull();
    expect(runSshBuffered).toHaveBeenCalledTimes(2);
  });

  it("returns null when the captured config declares no exact sandbox alias", async () => {
    runSshBuffered
      .mockResolvedValueOnce({ status: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        status: 0,
        stderr: "",
        stdout: "Host openshell-*\n  HostName 127.0.0.1\n",
      });

    expect(await executeSandboxCommand("alpha", "echo ok")).toBeNull();
    expect(runSshBuffered).toHaveBeenCalledTimes(2);
  });
});
