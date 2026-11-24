// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
const { spawnSync, captureSandboxSshConfigCommand } = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  captureSandboxSshConfigCommand: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync,
}));
vi.mock("../openshell/command-execution", async (original) => ({
  ...(await original<typeof import("../openshell/command-execution")>()),
  captureSandboxSshConfigCommand,
}));
vi.mock("../openshell/resolve-shared", async (original) => ({
  ...(await original<typeof import("../openshell/resolve-shared")>()),
  resolveOpenshellBinaryOrNull: () => "/pinned/openshell",
}));
import { executeSandboxMaintenanceCommand } from "./command-transport";
const config = "Host openshell-alpha\n  HostName localhost\n  User sandbox\n";
const runtimeSelection = {
  gatewayName: "selected",
  localTlsDir: "/selected/tls",
  workspace: "default",
};

beforeEach(() => {
  captureSandboxSshConfigCommand.mockReset().mockReturnValue({ status: 0, output: config });
  spawnSync.mockReset().mockReturnValue({ status: 0, stdout: "ready\n", stderr: "", signal: null });
});

it("uses selected OpenShell SSH authority during maintenance and removes its private config (#12603)", async () => {
  vi.stubEnv("OPENSHELL_GATEWAY", "ambient");
  vi.stubEnv("OPENSHELL_TOKEN", "ambient-token");
  let configPath = "";
  spawnSync.mockImplementation((binary, argv, options) => {
    configPath = argv[1];
    expect(binary).toBe("ssh");
    expect(fs.readFileSync(configPath, "utf8")).toBe(config);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    expect(argv.at(-2)).toBe("openshell-alpha");
    expect(argv.at(-1)).toContain("--noprofile");
    expect(options.input).toBe("builtin unset OPENCLAW_GATEWAY_TOKEN\necho ready");
    expect(options.env).toMatchObject({
      OPENSHELL_GATEWAY: "selected",
      OPENSHELL_LOCAL_TLS_DIR: "/selected/tls",
    });
    expect(options.env).not.toHaveProperty("OPENSHELL_TOKEN");
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(2000);
    return { status: 0, stdout: "ready\n", stderr: "", signal: null };
  });
  await expect(
    executeSandboxMaintenanceCommand("alpha", "echo ready", 2000, { runtimeSelection }),
  ).resolves.toEqual({ status: 0, stdout: "ready", stderr: "" });
  expect(captureSandboxSshConfigCommand).toHaveBeenCalledWith(
    "/pinned/openshell",
    "alpha",
    expect.objectContaining({
      env: expect.objectContaining({ OPENSHELL_GATEWAY: "selected" }),
      replaceEnv: true,
    }),
  );
  expect(fs.existsSync(configPath)).toBe(false);
});

it.each([
  { status: 1, output: "unavailable" },
  { status: 0, output: "Host openshell-other\n  HostName localhost\n" },
])("does not execute with unavailable or mismatched SSH authority: %j", async (result) => {
  captureSandboxSshConfigCommand.mockReturnValue(result);
  await expect(executeSandboxMaintenanceCommand("alpha", "mutate", 1000)).resolves.toBeNull();
  expect(spawnSync).not.toHaveBeenCalled();
});

it.each([
  { status: 255 },
  { status: null, signal: "SIGKILL" },
  { status: 0, error: new Error("timeout") },
])("does not accept or retry an unconfirmed SSH command: %j", async (failure) => {
  spawnSync.mockReturnValue({ stdout: "partial", stderr: "", ...failure });
  await expect(executeSandboxMaintenanceCommand("alpha", "mutate", 1000)).resolves.toBeNull();
  expect(spawnSync).toHaveBeenCalledOnce();
  expect(fs.existsSync(spawnSync.mock.calls[0][1][1])).toBe(false);
});
