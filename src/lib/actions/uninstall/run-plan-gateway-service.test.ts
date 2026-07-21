// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  getOpenShellUserConfigHome,
  getNemoclawOpenShellGatewayUserServicePath,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
  NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER,
} from "../../onboard/docker-driver-gateway-service";
import { HOST_GATEWAY_PGREP_PATTERN } from "../../onboard/host-gateway-process";
import { type RunResult, runUninstallPlan } from "./run-plan";

function ok(stdout = ""): RunResult {
  return { status: 0, stdout, stderr: "" };
}

function homeEnv(home: string, xdgConfigHome = ""): NodeJS.ProcessEnv {
  return { HOME: home, XDG_CONFIG_HOME: xdgConfigHome } as NodeJS.ProcessEnv;
}

function writeManagedService(home: string, env?: NodeJS.ProcessEnv): string {
  const servicePath = getNemoclawOpenShellGatewayUserServicePath(home, env);
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.writeFileSync(
    servicePath,
    [
      "# NemoClaw-managed OpenShell gateway user service",
      `# ${NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE_MARKER}`,
      "[Service]",
      "ExecStart=/home/test/.local/bin/openshell-gateway",
      "",
    ].join("\n"),
  );
  return servicePath;
}

function writeGatewayEnv(home: string, env?: NodeJS.ProcessEnv): string {
  const envPath = path.join(getOpenShellUserConfigHome(home, env), "openshell", "gateway.env");
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, "OPENSHELL_SERVER_PORT=8080\n");
  return envPath;
}

describe("uninstall OpenShell gateway user service", () => {
  it("keeps OpenShell service and host gateway process when OpenShell is kept", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const tmpHome = path.join(tmpRoot, "home");
    const xdgConfigHome = path.join(tmpRoot, "xdg-config");
    fs.mkdirSync(tmpHome, { recursive: true });
    const env = homeEnv(tmpHome, xdgConfigHome);
    const servicePath = writeManagedService(tmpHome, env);
    const envPath = writeGatewayEnv(tmpHome, env);
    const run = vi.fn((_command: string, _args: string[]) => ok());

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: true },
        {
          commandExists: () => true,
          env,
          existsSync: (target) => String(target).startsWith(tmpRoot) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run,
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(fs.existsSync(envPath)).toBe(true);
      expect(run.mock.calls.map(([command, args]) => [command, ...args].join("\0"))).not.toContain(
        ["pgrep", "-f", HOST_GATEWAY_PGREP_PATTERN].join("\0"),
      );
      expect(run.mock.calls.some(([command]) => command === "pgrep")).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("removes the NemoClaw-managed Linux user service on full uninstall", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const tmpHome = path.join(tmpRoot, "home");
    const xdgConfigHome = path.join(tmpRoot, "xdg-config");
    fs.mkdirSync(tmpHome, { recursive: true });
    const env = homeEnv(tmpHome, xdgConfigHome);
    const servicePath = writeManagedService(tmpHome, env);
    const envPath = writeGatewayEnv(tmpHome, env);
    const runCalls: string[][] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env,
          existsSync: (target) => String(target).startsWith(tmpRoot) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn((command: string, args: string[]) => {
            runCalls.push([command, ...args]);
            return ok();
          }),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(false);
      expect(fs.existsSync(envPath)).toBe(false);
      expect(runCalls).toContainEqual([
        "systemctl",
        "--user",
        "disable",
        "--now",
        NEMOCLAW_OPENSHELL_GATEWAY_USER_SERVICE,
      ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("reports incomplete uninstall when disabling the service fails", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const errors: string[] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: homeEnv(tmpHome),
          error: (line) => errors.push(line),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn((command: string, args: string[]) =>
            command === "systemctl" && args.includes("disable")
              ? { status: 1, stdout: "", stderr: "failed\n" }
              : ok(),
          ),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(errors).toContain(
        "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports incomplete uninstall when the managed service cannot be read", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const errors: string[] = [];
    const originalReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      target: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      return String(target) === servicePath
        ? (() => {
            throw new Error("permission denied");
          })()
        : (originalReadFileSync(target, options as never) as ReturnType<typeof fs.readFileSync>);
    }) as typeof fs.readFileSync);

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: homeEnv(tmpHome),
          error: (line) => errors.push(line),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(errors).toContain(
        `Failed to read ${servicePath}; leaving gateway user service in place.`,
      );
      expect(errors).toContain(
        "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
      );
    } finally {
      readSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports incomplete uninstall when the managed service file cannot be removed", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const errors: string[] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: homeEnv(tmpHome),
          error: (line) => errors.push(line),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: vi.fn((target: fs.PathLike) =>
            String(target) === servicePath
              ? (() => {
                  throw new Error("permission denied");
                })()
              : fs.rmSync(target, { recursive: true, force: true }),
          ) as typeof fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(errors).toContain(`Failed to remove ${servicePath}: permission denied`);
      expect(errors).toContain(
        "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("reports incomplete uninstall when user systemd reload fails after removal", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-service-"));
    const servicePath = writeManagedService(tmpHome);
    const errors: string[] = [];

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: (command) => command === "systemctl",
          env: homeEnv(tmpHome),
          error: (line) => errors.push(line),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn((command: string, args: string[]) =>
            command === "systemctl" && args.includes("daemon-reload")
              ? { status: 1, stdout: "", stderr: "failed\n" }
              : ok(),
          ),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.existsSync(servicePath)).toBe(false);
      expect(errors).toContain("Failed to reload the user systemd manager.");
      expect(errors).toContain(
        "Uninstall completed with errors. Some state may remain on disk; see warnings above.",
      );
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("removes only managed gateway settings from gateway.env", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-env-"));
    const envPath = writeGatewayEnv(tmpHome);
    fs.writeFileSync(
      envPath,
      [
        "KEEP_ME=1",
        "OPENSHELL_SERVER_PORT=8080",
        "OPENSHELL_BIND_ADDRESS=127.0.0.1",
        "DOCKER_HOST='unix:///tmp/docker.sock'",
        "",
      ].join("\n"),
    );

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => false,
          env: homeEnv(tmpHome),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(envPath, "utf-8")).toBe("KEEP_ME=1\n");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("refuses to clean a symlinked gateway.env", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-gateway-env-"));
    const configDir = path.join(getOpenShellUserConfigHome(tmpHome), "openshell");
    const envPath = path.join(configDir, "gateway.env");
    const targetPath = path.join(tmpHome, "foreign.env");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(targetPath, "KEEP_ME=1\n");
    fs.symlinkSync(targetPath, envPath);

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => false,
          env: homeEnv(tmpHome),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "linux",
          rmSync: fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(fs.readFileSync(targetPath, "utf-8")).toBe("KEEP_ME=1\n");
      expect(fs.lstatSync(envPath).isSymbolicLink()).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("does not remove Linux user service units on macOS", () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-macos-service-"));
    const servicePath = writeManagedService(tmpHome);

    try {
      const result = runUninstallPlan(
        { assumeYes: true, deleteModels: false, keepOpenShell: false },
        {
          commandExists: () => true,
          env: homeEnv(tmpHome),
          existsSync: (target) => String(target).startsWith(tmpHome) && fs.existsSync(target),
          isTty: false,
          platform: "darwin",
          rmSync: fs.rmSync,
          run: vi.fn(() => ok()),
          runDocker: () => ok(""),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(true);
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
