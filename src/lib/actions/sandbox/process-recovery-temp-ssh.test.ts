// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureSandboxSshConfig = vi.hoisted(() => vi.fn());
const executePrivilegedSandboxCommand = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("../../adapters/openshell/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../adapters/openshell/runtime")>()),
  captureOpenshell: vi.fn(),
  captureOpenshellForStatus: vi.fn(),
  captureSandboxSshConfig,
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
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("pins SSH config and command execution to one authority-derived mTLS target (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    captureSandboxSshConfig.mockReturnValue({
      status: 0,
      output: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    expect(
      executeSandboxCommand("alpha", "echo ok", {
        runtimeSelection: {
          gatewayName: "nemoclaw-8091",
          localTlsDir: "/authority/tls",
          workspace: "default",
        },
      }),
    ).toEqual({ status: 0, stdout: "ok", stderr: "" });

    const captureOptions = captureSandboxSshConfig.mock.calls[0]?.[1];
    expect(captureOptions).toMatchObject({
      gatewayName: "nemoclaw-8091",
      replaceEnv: true,
      env: {
        OPENSHELL_GATEWAY: "nemoclaw-8091",
        OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
        OPENSHELL_WORKSPACE: "default",
      },
    });
    expect(captureOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(captureOptions?.env).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
    expect(captureOptions?.env).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.env).toEqual(captureOptions?.env);
  });

  it("removes ambient mTLS when the selected gateway does not use it (#10514)", () => {
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    captureSandboxSshConfig.mockReturnValue({
      status: 0,
      output: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    executeSandboxCommand("alpha", "echo ok", {
      runtimeSelection: { gatewayName: "external-http", workspace: "default" },
    });

    expect(captureSandboxSshConfig.mock.calls[0]?.[1]?.env).not.toHaveProperty(
      "OPENSHELL_LOCAL_TLS_DIR",
    );
    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.env).not.toHaveProperty(
      "OPENSHELL_LOCAL_TLS_DIR",
    );
  });

  it("pins strict OpenShell exec to the same authority-derived target (#10514)", () => {
    vi.stubEnv("OPENSHELL_GATEWAY", "ambient-gateway");
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://ambient.invalid");
    vi.stubEnv("OPENSHELL_GATEWAY_INSECURE", "true");
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", "/ambient/tls");
    vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
    vi.stubEnv("OPENSHELL_WORKSPACE", "ambient-workspace");
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nrevision-1\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    expect(
      executeSandboxExecCommand("alpha", "printf revision-1", undefined, {
        runtimeSelection: {
          gatewayName: "nemoclaw-8091",
          localTlsDir: "/authority/tls",
          workspace: "default",
        },
      }),
    ).toEqual({ status: 0, stdout: "revision-1", stderr: "" });

    const [command, args, options] = vi.mocked(spawnSync).mock.calls[0] ?? [];
    expect(command).toBe("openshell");
    expect(args).toEqual(
      expect.arrayContaining(["sandbox", "exec", "--name", "alpha", "-g", "nemoclaw-8091"]),
    );
    expect(options?.env).toMatchObject({
      OPENSHELL_GATEWAY: "nemoclaw-8091",
      OPENSHELL_LOCAL_TLS_DIR: "/authority/tls",
      OPENSHELL_WORKSPACE: "default",
    });
    expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_ENDPOINT");
    expect(options?.env).not.toHaveProperty("OPENSHELL_GATEWAY_INSECURE");
    expect(options?.env).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("fails closed instead of using a same-name local sandbox for selected exec (#10514)", () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: "selected gateway unavailable\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });
    executePrivilegedSandboxCommand.mockReturnValue({
      status: 0,
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nlocal-same-name\n",
      stderr: "",
    });

    expect(
      executeSandboxExecCommand("alpha", "printf selected", undefined, {
        allowLocalDockerFallback: true,
        runtimeSelection: {
          gatewayName: "recorded-gateway",
          localTlsDir: "/authority/tls",
          workspace: "default",
        },
      }),
    ).toBeNull();
    expect(executePrivilegedSandboxCommand).not.toHaveBeenCalled();
  });

  it("uses the exact legacy alias while backing up a pre-upgrade sandbox", () => {
    captureSandboxSshConfig.mockReturnValue({
      status: 0,
      output: "Host openshell-alpha\n  HostName 127.0.0.1\n",
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    const result = executeSandboxCommand("alpha", "echo ok");

    expect(result).toEqual({ status: 0, stdout: "ok", stderr: "" });
    const sshArgs = vi.mocked(spawnSync).mock.calls[0]?.[1] as string[];
    const configFile = sshArgs[sshArgs.indexOf("-F") + 1];
    const configDir = path.dirname(configFile);
    expect(configDir).not.toBe(os.tmpdir());
    expect(path.basename(configDir)).toMatch(/^nemoclaw-ssh-/);
    expect(path.basename(configFile)).toBe("ssh_config");
    expect(sshArgs).toContain("openshell-alpha");
    expect(sshArgs).not.toContain("openshell-alpha.default");
    expect(fs.existsSync(configDir)).toBe(false);
  });

  it("uses the workspace-qualified alias emitted by OpenShell v0.0.99", () => {
    captureSandboxSshConfig.mockReturnValue({
      status: 0,
      output: "Host openshell-alpha.default\n  HostName 127.0.0.1\n",
    });
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: "ok\n",
      stderr: "",
      pid: 1234,
      output: [],
      signal: null,
    });

    expect(executeSandboxCommand("alpha", "echo ok")).toEqual({
      status: 0,
      stdout: "ok",
      stderr: "",
    });

    const sshArgs = vi.mocked(spawnSync).mock.calls[0]?.[1] as string[];
    expect(sshArgs).toContain("openshell-alpha.default");
    expect(sshArgs).not.toContain("openshell-alpha");
  });

  it("returns null without creating an SSH process when config capture fails", () => {
    captureSandboxSshConfig.mockReturnValue({ status: 1, output: "" });

    expect(executeSandboxCommand("alpha", "echo ok")).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it("returns null when the captured config declares no exact sandbox alias", () => {
    captureSandboxSshConfig.mockReturnValue({
      status: 0,
      output: "Host openshell-*\n  HostName 127.0.0.1\n",
    });

    expect(executeSandboxCommand("alpha", "echo ok")).toBeNull();
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
