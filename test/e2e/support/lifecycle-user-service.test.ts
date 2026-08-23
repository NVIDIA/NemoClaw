// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import {
  buildOpenShellGatewayUserServiceRemovalScript,
  buildOpenShellGatewayUserServiceRestartScript,
  buildOpenShellGatewayUserServiceStageScript,
} from "../fixtures/phases/lifecycle.ts";

const installer = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));

function prepareFixtureInstaller(root: string, env: NodeJS.ProcessEnv): string {
  const fixtureInstaller = path.join(root, "install-fixture.sh");
  fs.writeFileSync(
    fixtureInstaller,
    [
      `source ${JSON.stringify(installer)}`,
      "systemd_user_service_system_unit_roots() { :; }",
      "",
    ].join("\n"),
  );
  env.XDG_CONFIG_DIRS = path.join(root, "empty-xdg-config-dirs");
  env.XDG_DATA_DIRS = path.join(root, "empty-xdg-data-dirs");
  env.XDG_DATA_HOME = path.join(root, "data-home");
  env.XDG_RUNTIME_DIR = path.join(root, "runtime");
  return fixtureInstaller;
}

function writeUnitPathBusctl(bin: string, unitRoot: string): void {
  fs.writeFileSync(
    path.join(bin, "busctl"),
    [
      "#!/bin/sh",
      `printf '%s\n' ${JSON.stringify(JSON.stringify({ type: "as", data: [unitRoot] }))}`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function linuxFixtureCommand(script: string, env: NodeJS.ProcessEnv): string {
  return [
    `export PATH=${JSON.stringify(env.PATH ?? "")}`,
    "uname() { printf 'Linux\\n'; }",
    script,
  ].join("\n");
}

describe("reboot lifecycle OpenShell gateway user-service fixture", () => {
  it("stages, enables, and removes the repository service without installer cleanup", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-installer-lifecycle-stage-service-"),
    );
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(home, ".local", "bin");
    const log = path.join(root, "systemctl.log");
    const unit = path.join(configHome, "systemd", "user", "nemoclaw-openshell-gateway.service");
    const installerCleanupSentinel = path.join(root, "installer-cleanup-sentinel");

    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(installerCleanupSentinel, "fixture-owned\n");
    fs.writeFileSync(path.join(bin, "openshell-gateway"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        'if [ "$*" = "--user cat openshell-gateway" ]; then exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeUnitPathBusctl(bin, path.join(configHome, "systemd", "user"));

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      env.NEMOCLAW_INSTALLER_STAGED = installerCleanupSentinel;
      const fixtureInstaller = prepareFixtureInstaller(root, env);
      const staged = execFileSync(
        "bash",
        [
          "-lc",
          linuxFixtureCommand(buildOpenShellGatewayUserServiceStageScript(), env),
          "stage-service",
          fixtureInstaller,
        ],
        { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 30_000 },
      );

      expect(staged).toContain("NEMOCLAW_E2E_GATEWAY_USER_SERVICE=staged");
      expect(fs.existsSync(installerCleanupSentinel)).toBe(true);
      expect(fs.readFileSync(unit, "utf8")).toContain(`ExecStart=${bin}/openshell-gateway`);
      expect(fs.statSync(unit).mode & 0o777).toBe(0o600);

      execFileSync(
        "sh",
        ["-lc", linuxFixtureCommand(buildOpenShellGatewayUserServiceRemovalScript(), env)],
        {
          env,
          killSignal: "SIGKILL",
          timeout: 30_000,
        },
      );

      expect(fs.existsSync(unit)).toBe(false);
      const calls = fs.readFileSync(log, "utf8").trim().split("\n");
      expect(calls).toEqual([
        "--user list-units --type=service --state=active,activating,reloading,deactivating --no-legend --plain --no-pager",
        "--user daemon-reload",
        "--user daemon-reload",
        "--user cat openshell-gateway",
        "--user enable nemoclaw-openshell-gateway",
        "--user stop nemoclaw-openshell-gateway",
        "--user disable nemoclaw-openshell-gateway",
        "--user daemon-reload",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses an existing upstream service without staging a NemoClaw unit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-upstream-service-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "systemctl"), ["#!/bin/sh", "exit 0", ""].join("\n"), {
      mode: 0o755,
    });
    writeUnitPathBusctl(bin, path.join(configHome, "systemd", "user"));

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      const fixtureInstaller = prepareFixtureInstaller(root, env);
      const output = execFileSync(
        "bash",
        [
          "-lc",
          linuxFixtureCommand(buildOpenShellGatewayUserServiceStageScript(), env),
          "stage-service",
          fixtureInstaller,
        ],
        { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 30_000 },
      );

      expect(output).toContain("NEMOCLAW_E2E_GATEWAY_USER_SERVICE=upstream");
      expect(
        fs.existsSync(
          path.join(configHome, "systemd", "user", "nemoclaw-openshell-gateway.service"),
        ),
      ).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("removes a staged service when daemon reload fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-stage-failure-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(home, ".local", "bin");
    const unit = path.join(configHome, "systemd", "user", "nemoclaw-openshell-gateway.service");

    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "openshell-gateway"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        'if [ "$*" = "--user cat openshell-gateway" ]; then exit 1; fi',
        'if [ "$*" = "--user daemon-reload" ]; then exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    writeUnitPathBusctl(bin, path.join(configHome, "systemd", "user"));

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      const fixtureInstaller = prepareFixtureInstaller(root, env);

      expect(() =>
        execFileSync(
          "bash",
          [
            "-lc",
            linuxFixtureCommand(buildOpenShellGatewayUserServiceStageScript(), env),
            "stage-service",
            fixtureInstaller,
          ],
          { env, killSignal: "SIGKILL", stdio: "pipe", timeout: 30_000 },
        ),
      ).toThrow();
      expect(fs.existsSync(unit)).toBe(false);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("refuses to replace a foreign NemoClaw-named service", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-foreign-service-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(home, ".local", "bin");
    const unitDir = path.join(configHome, "systemd", "user");
    const unit = path.join(unitDir, "nemoclaw-openshell-gateway.service");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(unit, "[Service]\nExecStart=/tmp/foreign\n");
    fs.writeFileSync(path.join(bin, "openshell-gateway"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      ["#!/bin/sh", '[ "$*" = "--user cat openshell-gateway" ] && exit 1', "exit 0", ""].join("\n"),
      { mode: 0o755 },
    );
    writeUnitPathBusctl(bin, unitDir);

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      const fixtureInstaller = prepareFixtureInstaller(root, env);

      expect(() =>
        execFileSync(
          "bash",
          [
            "-lc",
            linuxFixtureCommand(buildOpenShellGatewayUserServiceStageScript(), env),
            "stage-service",
            fixtureInstaller,
          ],
          { env, killSignal: "SIGKILL", stdio: "pipe", timeout: 30_000 },
        ),
      ).toThrow();
      expect(fs.readFileSync(unit, "utf8")).toBe("[Service]\nExecStart=/tmp/foreign\n");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("managed OpenShell gateway user-service restart", () => {
  it("selects a marked unit from an absolute custom XDG config root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-service-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unitDir = path.join(configHome, "systemd", "user");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, "nemoclaw-openshell-gateway.service"),
      "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n",
    );
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        'if [ "$*" = "--user cat openshell-gateway" ]; then exit 1; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      execFileSync(
        "sh",
        ["-lc", linuxFixtureCommand(buildOpenShellGatewayUserServiceRestartScript(), env)],
        {
          env,
          killSignal: "SIGKILL",
          timeout: 30_000,
        },
      );

      expect(env.XDG_CONFIG_HOME).toBe(configHome);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user cat openshell-gateway",
        "--user is-enabled nemoclaw-openshell-gateway",
        "--user daemon-reload",
        "--user restart nemoclaw-openshell-gateway",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
