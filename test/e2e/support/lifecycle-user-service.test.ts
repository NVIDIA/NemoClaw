// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
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
  buildOpenShellGatewayUserServiceStopScript,
} from "../fixtures/phases/lifecycle.ts";

const installer = fileURLToPath(new URL("../../../scripts/install.sh", import.meta.url));
const upstreamServiceShow =
  "--user show openshell-gateway.service --property=FragmentPath --property=ExecStart";
const stoppedServicePrefix = "NEMOCLAW_E2E_STOPPED_GATEWAY_USER_SERVICE=";

function runStopScript(installerPath: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    "bash",
    ["-c", buildOpenShellGatewayUserServiceStopScript(), "stop-service", installerPath],
    { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 30_000 },
  );
}

function runRestartScript(installerPath: string, selection: string, env: NodeJS.ProcessEnv) {
  return spawnSync(
    "bash",
    [
      "-c",
      buildOpenShellGatewayUserServiceRestartScript(),
      "restart-service",
      installerPath,
      selection,
    ],
    { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 30_000 },
  );
}

function writeTrustedInstaller(
  root: string,
  trustedUnit: string,
  trustedGatewayBin: string,
): string {
  const trustedInstaller = path.join(root, "trusted-installer.sh");
  fs.writeFileSync(
    trustedInstaller,
    [
      `source ${JSON.stringify(installer)}`,
      `trusted_upstream_openshell_gateway_unit_for_service() { [ "$1" = ${JSON.stringify(trustedUnit)} ]; }`,
      `trusted_upstream_openshell_gateway_bin_for_service() { [ "$1" = ${JSON.stringify(trustedGatewayBin)} ]; }`,
      "upstream_openshell_gateway_user_service_installed() { return 0; }",
      "supported_openshell_gateway_user_service_candidate_exists() { return 0; }",
    ].join("\n"),
  );
  return trustedInstaller;
}

function writeCandidateInstaller(root: string, exists: boolean): string {
  const candidateInstaller = path.join(root, "candidate-installer.sh");
  fs.writeFileSync(
    candidateInstaller,
    [
      `source ${JSON.stringify(installer)}`,
      `upstream_openshell_gateway_user_service_installed() { return ${exists ? "0" : "1"}; }`,
      `supported_openshell_gateway_user_service_candidate_exists() { return ${exists ? "0" : "1"}; }`,
    ].join("\n"),
  );
  return candidateInstaller;
}

function writeNoUpstreamInstaller(root: string): string {
  const candidateInstaller = path.join(root, "no-upstream-installer.sh");
  fs.writeFileSync(
    candidateInstaller,
    [
      `source ${JSON.stringify(installer)}`,
      "upstream_openshell_gateway_user_service_installed() { return 1; }",
    ].join("\n"),
  );
  return candidateInstaller;
}

function writeMacServiceStubs(
  root: string,
  trustedProgram: boolean,
  serviceLabel = "sh.brew.openshell",
  trustedRestartedProgram = true,
) {
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const brewPrefix = path.join(root, "homebrew");
  const serviceDomain = `gui/501/${serviceLabel}`;
  const servicePath = path.join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`);
  const serviceProgram = path.join(
    brewPrefix,
    "opt",
    "openshell",
    "libexec",
    "openshell-gateway-homebrew-service",
  );
  const selectedProgram = trustedProgram ? serviceProgram : path.join(root, "foreign-gateway");
  const active = path.join(root, "homebrew-active");
  const restarted = path.join(root, "homebrew-restarted");
  const launchctlLog = path.join(root, "launchctl.log");
  const brewLog = path.join(root, "brew.log");

  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.mkdirSync(path.dirname(serviceProgram), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(servicePath, "test plist\n");
  fs.writeFileSync(serviceProgram, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(active, "active\n");
  fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Darwin\\n'\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "id"), "#!/bin/sh\nprintf '501\\n'\n", { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, "brew"),
    [
      "#!/bin/sh",
      `printf "%s\\n" "$*" >> ${JSON.stringify(brewLog)}`,
      `if [ "$*" = "--prefix" ]; then printf '%s\\n' ${JSON.stringify(brewPrefix)}; exit 0; fi`,
      `if [ "$*" = "list --formula openshell" ]; then exit 0; fi`,
      `if [ "$*" = "info --json=v2 openshell" ]; then printf '%s\\n' '{"formulae":[{"tap":"nvidia/openshell"}]}'; exit 0; fi`,
      "exit 97",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "plutil"),
    [
      "#!/bin/sh",
      `if [ "$2" = "Label" ]; then printf '%s\\n' ${JSON.stringify(serviceLabel)}; exit 0; fi`,
      `if [ "$2" = "ProgramArguments.0" ]; then printf '%s\\n' ${JSON.stringify(selectedProgram)}; exit 0; fi`,
      "exit 97",
    ].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "launchctl"),
    [
      "#!/bin/sh",
      `printf "%s\\n" "$*" >> ${JSON.stringify(launchctlLog)}`,
      `if [ "$1" = "print" ] && [ "$2" = ${JSON.stringify(serviceDomain)} ]; then`,
      `  test -f ${JSON.stringify(active)} || exit 1`,
      "  printf 'state = running\\n'",
      `  if [ -f ${JSON.stringify(restarted)} ]; then`,
      `    printf 'program = %s\\n' ${JSON.stringify(
        trustedRestartedProgram ? serviceProgram : path.join(root, "foreign-restarted-gateway"),
      )}`,
      "  else",
      `    printf 'program = %s\\n' ${JSON.stringify(serviceProgram)}`,
      "  fi",
      "  exit 0",
      "fi",
      `if [ "$1" = "bootout" ] && [ "$2" = ${JSON.stringify(serviceDomain)} ]; then rm -f ${JSON.stringify(active)}; exit 0; fi`,
      `if [ "$1" = "bootstrap" ] && [ "$2" = "gui/501" ] && [ "$3" = ${JSON.stringify(servicePath)} ]; then touch ${JSON.stringify(active)} ${JSON.stringify(restarted)}; exit 0; fi`,
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );

  return {
    active,
    bin,
    brewLog,
    home,
    launchctlLog,
    serviceDomain,
    serviceLabel,
    servicePath,
  };
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

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      env.NEMOCLAW_INSTALLER_STAGED = installerCleanupSentinel;
      const staged = execFileSync(
        "bash",
        ["-lc", buildOpenShellGatewayUserServiceStageScript(), "stage-service", installer],
        { encoding: "utf8", env, killSignal: "SIGKILL", timeout: 30_000 },
      );

      expect(staged).toContain("NEMOCLAW_E2E_GATEWAY_USER_SERVICE=staged");
      expect(fs.existsSync(installerCleanupSentinel)).toBe(true);
      expect(fs.readFileSync(unit, "utf8")).toContain(`ExecStart=${bin}/openshell-gateway`);
      expect(fs.statSync(unit).mode & 0o777).toBe(0o600);

      execFileSync("sh", ["-lc", buildOpenShellGatewayUserServiceRemovalScript()], {
        env,
        killSignal: "SIGKILL",
        timeout: 30_000,
      });

      expect(fs.existsSync(unit)).toBe(false);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
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
    fs.writeFileSync(path.join(bin, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      const output = execFileSync(
        "bash",
        ["-lc", buildOpenShellGatewayUserServiceStageScript(), "stage-service", installer],
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

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });

      expect(() =>
        execFileSync(
          "bash",
          ["-lc", buildOpenShellGatewayUserServiceStageScript(), "stage-service", installer],
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
      '#!/bin/sh\n[ "$*" = "--user cat openshell-gateway" ] && exit 1\nexit 0\n',
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });

      expect(() =>
        execFileSync(
          "bash",
          ["-lc", buildOpenShellGatewayUserServiceStageScript(), "stage-service", installer],
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
  it("restarts the marked service selected when the trusted upstream service is inactive (#10947)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-service-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unitDir = path.join(configHome, "systemd", "user");
    const unit = path.join(unitDir, "nemoclaw-openshell-gateway.service");
    const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
    const upstreamUnit = path.join(
      root,
      "usr",
      "lib",
      "systemd",
      "user",
      "openshell-gateway.service",
    );
    const upstreamGatewayBin = path.join(root, "usr", "bin", "openshell-gateway");
    const active = path.join(root, "managed-active");
    const trustedInstaller = writeTrustedInstaller(root, upstreamUnit, upstreamGatewayBin);

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(unitDir, { recursive: true });
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(upstreamGatewayBin), { recursive: true });
    fs.writeFileSync(unit, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
    fs.writeFileSync(gatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(upstreamGatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(active, "active\n");
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf 'FragmentPath=%s\\n' ${JSON.stringify(upstreamUnit)}`,
        `  printf 'ExecStart={ path=%s ; argv[]=%s ; }\\n' ${JSON.stringify(upstreamGatewayBin)} ${JSON.stringify(upstreamGatewayBin)}`,
        "  exit 0",
        "fi",
        'if [ "$*" = "--user is-active --quiet openshell-gateway.service" ]; then exit 3; fi',
        `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value" ]; then printf '%s\\n' ${JSON.stringify(unit)}; exit 0; fi`,
        `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value" ]; then printf '{ path=%s ; argv[]=%s ; }\\n' ${JSON.stringify(gatewayBin)} ${JSON.stringify(gatewayBin)}; exit 0; fi`,
        `if [ "$*" = "--user is-active --quiet nemoclaw-openshell-gateway.service" ]; then test -f ${JSON.stringify(active)} && exit 0; exit 3; fi`,
        `if [ "$*" = "--user stop nemoclaw-openshell-gateway.service" ]; then rm -f ${JSON.stringify(active)}; exit 0; fi`,
        `if [ "$*" = "--user restart nemoclaw-openshell-gateway.service" ]; then touch ${JSON.stringify(active)}; exit 0; fi`,
        'if [ "$*" = "--user show-environment" ] || [ "$*" = "--user daemon-reload" ]; then exit 0; fi',
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
        NEMOCLAW_GATEWAY_PORT: "8080",
      });
      const stopped = runStopScript(trustedInstaller, env);
      expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain(
        `${stoppedServicePrefix}systemd:nemoclaw-openshell-gateway.service`,
      );

      const restarted = runRestartScript(
        trustedInstaller,
        "systemd:nemoclaw-openshell-gateway.service",
        env,
      );
      expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);

      expect(env.XDG_CONFIG_HOME).toBe(configHome);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
        "--user is-active --quiet openshell-gateway.service",
        "--user is-active --quiet nemoclaw-openshell-gateway.service",
        "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
        "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value",
        "--user stop nemoclaw-openshell-gateway.service",
        "--user is-active --quiet nemoclaw-openshell-gateway.service",
        "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
        "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value",
        "--user daemon-reload",
        "--user restart nemoclaw-openshell-gateway.service",
      ]);
      expect(fs.existsSync(active)).toBe(true);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("managed OpenShell gateway user-service stop", () => {
  it("stops a marked NemoClaw unit from an absolute custom XDG config root (#10947)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-service-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unitDir = path.join(configHome, "systemd", "user");
    const unit = path.join(unitDir, "nemoclaw-openshell-gateway.service");
    const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
    const active = path.join(root, "managed-active");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(unitDir, { recursive: true });
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(unit, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
    fs.writeFileSync(gatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(active, "active\n");
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then exit 1; fi`,
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value" ]; then printf '%s\\n' ${JSON.stringify(unit)}; exit 0; fi`,
        `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value" ]; then printf '{ path=%s ; argv[]=%s ; }\\n' ${JSON.stringify(gatewayBin)} ${JSON.stringify(gatewayBin)}; exit 0; fi`,
        `if [ "$*" = "--user is-active --quiet nemoclaw-openshell-gateway.service" ]; then test -f ${JSON.stringify(active)} && exit 0; exit 3; fi`,
        `if [ "$*" = "--user stop nemoclaw-openshell-gateway.service" ]; then rm -f ${JSON.stringify(active)}; exit 0; fi`,
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
        NEMOCLAW_GATEWAY_PORT: "8080",
      });
      const result = runStopScript(writeNoUpstreamInstaller(root), env);

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `${stoppedServicePrefix}systemd:nemoclaw-openshell-gateway.service`,
      );
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        "--user is-active --quiet nemoclaw-openshell-gateway.service",
        "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
        "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value",
        "--user stop nemoclaw-openshell-gateway.service",
        "--user is-active --quiet nemoclaw-openshell-gateway.service",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("stops and restarts an active but disabled upstream OpenShell user service (#10947)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-upstream-"));
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unit = path.join(root, "usr", "lib", "systemd", "user", "openshell-gateway.service");
    const gatewayBin = path.join(root, "usr", "bin", "openshell-gateway");
    const active = path.join(root, "upstream-active");
    const trustedInstaller = writeTrustedInstaller(root, unit, gatewayBin);
    const metadata = [
      `FragmentPath=${unit}`,
      `ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ; }`,
    ].join("\n");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.writeFileSync(gatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(active, "active\n");
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf "%b\\n" ${JSON.stringify(metadata)}`,
        "  exit 0",
        "fi",
        `if [ "$*" = "--user is-active --quiet openshell-gateway.service" ]; then test -f ${JSON.stringify(active)} && exit 0; exit 3; fi`,
        `if [ "$*" = "--user stop openshell-gateway.service" ]; then rm -f ${JSON.stringify(active)}; exit 0; fi`,
        `if [ "$*" = "--user restart openshell-gateway.service" ]; then touch ${JSON.stringify(active)}; exit 0; fi`,
        'if [ "$*" = "--user is-enabled openshell-gateway.service" ]; then exit 1; fi',
        'if [ "$*" = "--user daemon-reload" ]; then exit 0; fi',
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const stopped = runStopScript(trustedInstaller, env);

      expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
      expect(stopped.stdout).toContain(`${stoppedServicePrefix}systemd:openshell-gateway.service`);
      expect(fs.existsSync(active)).toBe(false);

      const restarted = runRestartScript(
        trustedInstaller,
        "systemd:openshell-gateway.service",
        env,
      );
      expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);
      expect(fs.existsSync(active)).toBe(true);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
        "--user is-active --quiet openshell-gateway.service",
        "--user stop openshell-gateway.service",
        "--user is-active --quiet openshell-gateway.service",
        upstreamServiceShow,
        "--user daemon-reload",
        "--user restart openshell-gateway.service",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(["sh.brew.openshell", "homebrew.mxcl.openshell"])(
    "stops and restarts the exact NVIDIA OpenShell Homebrew service %s on macOS (#10947)",
    (serviceLabel) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-homebrew-"));
      const { active, bin, brewLog, home, launchctlLog, serviceDomain, servicePath } =
        writeMacServiceStubs(root, true, serviceLabel);

      try {
        const env = buildAvailabilityProbeEnv({
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          NEMOCLAW_GATEWAY_PORT: "8080",
        });
        const result = runStopScript(installer, env);

        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain(`${stoppedServicePrefix}homebrew:${serviceLabel}`);
        expect(fs.readFileSync(launchctlLog, "utf8").trim().split("\n")).toEqual([
          "print gui/501/sh.brew.openshell",
          "print gui/501/homebrew.mxcl.openshell",
          `print ${serviceDomain}`,
          `bootout ${serviceDomain}`,
          `print ${serviceDomain}`,
        ]);
        expect(fs.existsSync(active)).toBe(false);

        const restarted = runRestartScript(installer, `homebrew:${serviceLabel}`, env);
        expect(restarted.status, restarted.stdout + restarted.stderr).toBe(0);
        expect(fs.readFileSync(brewLog, "utf8").trim().split("\n")).toEqual([
          "--prefix",
          "--prefix",
          "list --formula openshell",
          "info --json=v2 openshell",
          "--prefix",
        ]);
        expect(fs.readFileSync(launchctlLog, "utf8").trim().split("\n")).toEqual([
          "print gui/501/sh.brew.openshell",
          "print gui/501/homebrew.mxcl.openshell",
          `print ${serviceDomain}`,
          `bootout ${serviceDomain}`,
          `print ${serviceDomain}`,
          `bootstrap gui/501 ${servicePath}`,
          `print ${serviceDomain}`,
        ]);
        expect(fs.readFileSync(brewLog, "utf8")).not.toContain("services restart openshell");
        expect(fs.existsSync(active)).toBe(true);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("refuses to restart a selected Homebrew service after its LaunchAgent becomes a symlink (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-restart-homebrew-symlink-"),
    );
    const { active, bin, brewLog, home, launchctlLog, serviceLabel, servicePath } =
      writeMacServiceStubs(root, true);
    const replacement = path.join(root, "replacement.plist");

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        NEMOCLAW_GATEWAY_PORT: "8080",
      });
      const stopped = runStopScript(installer, env);
      expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);
      expect(fs.existsSync(active)).toBe(false);

      fs.renameSync(servicePath, replacement);
      fs.symlinkSync(replacement, servicePath);
      const restarted = runRestartScript(installer, `homebrew:${serviceLabel}`, env);

      expect(restarted.status).not.toBe(0);
      expect(restarted.stderr).toContain("untrusted macOS user service");
      expect(fs.existsSync(active)).toBe(false);
      expect(fs.readFileSync(brewLog, "utf8")).not.toContain("services restart openshell");
      expect(fs.readFileSync(launchctlLog, "utf8")).not.toContain("bootstrap");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("removes the selected Homebrew service when its restarted identity is untrusted (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-restart-homebrew-identity-"),
    );
    const { active, bin, home, launchctlLog, serviceDomain } = writeMacServiceStubs(
      root,
      true,
      "sh.brew.openshell",
      false,
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        NEMOCLAW_GATEWAY_PORT: "8080",
      });
      const stopped = runStopScript(installer, env);
      expect(stopped.status, stopped.stdout + stopped.stderr).toBe(0);

      const restarted = runRestartScript(installer, "homebrew:sh.brew.openshell", env);

      expect(restarted.status).not.toBe(0);
      expect(restarted.stderr).toContain("did not restart with its expected identity");
      expect(fs.existsSync(active)).toBe(false);
      expect(fs.readFileSync(launchctlLog, "utf8").trim().split("\n").at(-1)).toBe(
        `bootout ${serviceDomain}`,
      );
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an untrusted OpenShell Homebrew service without stopping it (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-homebrew-foreign-"),
    );
    const { active, bin, home, launchctlLog } = writeMacServiceStubs(root, false);

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        NEMOCLAW_GATEWAY_PORT: "8080",
      });
      const result = runStopScript(installer, env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("untrusted executable");
      expect(fs.readFileSync(launchctlLog, "utf8")).not.toContain("bootout");
      expect(fs.existsSync(active)).toBe(true);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("reports no service without inspecting absent service definitions (#10947)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-absent-"));
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const candidateInstaller = writeCandidateInstaller(root, false);

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const result = runStopScript(candidateInstaller, env);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`${stoppedServicePrefix}unavailable`);
      expect(fs.readFileSync(log, "utf8").trim()).toBe("--user show-environment");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an untrusted upstream OpenShell user service without stopping it (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-upstream-foreign-"),
    );
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const untrustedMetadata = [
      `FragmentPath=${home}/.config/systemd/user/openshell-gateway.service`,
      "ExecStart={ path=/usr/bin/openshell-gateway ; argv[]=/usr/bin/openshell-gateway ; }",
    ].join("\n");
    const candidateInstaller = writeCandidateInstaller(root, true);

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf "%b\\n" ${JSON.stringify(untrustedMetadata)}`,
        "  exit 0",
        "fi",
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const result = runStopScript(candidateInstaller, env);

      expect(result.status).toBe(75);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects an untrusted upstream executable independently of its trusted unit (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-upstream-executable-foreign-"),
    );
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const metadata = [
      "FragmentPath=/usr/lib/systemd/user/openshell-gateway.service",
      "ExecStart={ path=/tmp/foreign/openshell-gateway ; argv[]=/tmp/foreign/openshell-gateway ; }",
    ].join("\n");
    const candidateInstaller = writeCandidateInstaller(root, true);

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf "%b\\n" ${JSON.stringify(metadata)}`,
        "  exit 0",
        "fi",
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const result = runStopScript(candidateInstaller, env);

      expect(result.status).toBe(75);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects trusted upstream metadata when the selected executable is unavailable (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-upstream-executable-missing-"),
    );
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unit = path.join(root, "usr", "lib", "systemd", "user", "openshell-gateway.service");
    const missingGatewayBin = path.join(root, "usr", "bin", "openshell-gateway");
    const trustedInstaller = writeTrustedInstaller(root, unit, missingGatewayBin);
    const metadata = [
      `FragmentPath=${unit}`,
      `ExecStart={ path=${missingGatewayBin} ; argv[]=${missingGatewayBin} ; }`,
    ].join("\n");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf "%b\\n" ${JSON.stringify(metadata)}`,
        "  exit 0",
        "fi",
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const result = runStopScript(trustedInstaller, env);

      expect(result.status).toBe(75);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("falls back to an active marked service when the trusted upstream service is inactive (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-upstream-inactive-"),
    );
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unit = path.join(configHome, "systemd", "user", "nemoclaw-openshell-gateway.service");
    const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
    const upstreamUnit = path.join(
      root,
      "usr",
      "lib",
      "systemd",
      "user",
      "openshell-gateway.service",
    );
    const upstreamGatewayBin = path.join(root, "usr", "bin", "openshell-gateway");
    const active = path.join(root, "managed-active");
    const trustedInstaller = writeTrustedInstaller(root, upstreamUnit, upstreamGatewayBin);
    const metadata = [
      `FragmentPath=${upstreamUnit}`,
      `ExecStart={ path=${upstreamGatewayBin} ; argv[]=${upstreamGatewayBin} ; }`,
    ].join("\n");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(upstreamGatewayBin), { recursive: true });
    fs.writeFileSync(unit, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
    fs.writeFileSync(gatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(upstreamGatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(active, "active\n");
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf "%b\\n" ${JSON.stringify(metadata)}`,
        "  exit 0",
        "fi",
        'if [ "$*" = "--user is-active --quiet openshell-gateway.service" ]; then exit 3; fi',
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value" ]; then printf '%s\\n' ${JSON.stringify(unit)}; exit 0; fi`,
        `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value" ]; then printf '{ path=%s ; argv[]=%s ; }\\n' ${JSON.stringify(gatewayBin)} ${JSON.stringify(gatewayBin)}; exit 0; fi`,
        `if [ "$*" = "--user is-active --quiet nemoclaw-openshell-gateway.service" ]; then test -f ${JSON.stringify(active)} && exit 0; exit 3; fi`,
        `if [ "$*" = "--user stop nemoclaw-openshell-gateway.service" ]; then rm -f ${JSON.stringify(active)}; exit 0; fi`,
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
        NEMOCLAW_GATEWAY_PORT: "8080",
      });
      const result = runStopScript(trustedInstaller, env);

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain(
        `${stoppedServicePrefix}systemd:nemoclaw-openshell-gateway.service`,
      );
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
        "--user is-active --quiet openshell-gateway.service",
        "--user is-active --quiet nemoclaw-openshell-gateway.service",
        "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
        "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value",
        "--user stop nemoclaw-openshell-gateway.service",
        "--user is-active --quiet nemoclaw-openshell-gateway.service",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("leaves a foreign NemoClaw-named unit untouched (#10947)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-foreign-"));
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unitDir = path.join(configHome, "systemd", "user");
    const unit = path.join(unitDir, "nemoclaw-openshell-gateway.service");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(unit, "[Service]\nExecStart=/tmp/foreign\n");
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then exit 1; fi`,
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
        NEMOCLAW_GATEWAY_PORT: "8080",
      });
      const result = runStopScript(writeNoUpstreamInstaller(root), env);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("non-NemoClaw user service");
      expect(fs.readFileSync(unit, "utf8")).toBe("[Service]\nExecStart=/tmp/foreign\n");
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual(["--user show-environment"]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves a user-manager failure while checking the upstream service state (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-upstream-state-manager-"),
    );
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unit = path.join(root, "usr", "lib", "systemd", "user", "openshell-gateway.service");
    const gatewayBin = path.join(root, "usr", "bin", "openshell-gateway");
    const markedUnit = path.join(
      configHome,
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const trustedInstaller = writeTrustedInstaller(root, unit, gatewayBin);
    const metadata = [
      `FragmentPath=${unit}`,
      `ExecStart={ path=${gatewayBin} ; argv[]=${gatewayBin} ; }`,
    ].join("\n");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(markedUnit), { recursive: true });
    fs.writeFileSync(gatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(markedUnit, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf "%b\\n" ${JSON.stringify(metadata)}`,
        "  exit 0",
        "fi",
        'if [ "$*" = "--user is-active --quiet openshell-gateway.service" ]; then',
        '  printf "Failed to connect to bus: Host is down\\n" >&2',
        "  exit 1",
        "fi",
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      const result = runStopScript(trustedInstaller, env);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Failed to connect to bus: Host is down");
      expect(result.stdout).not.toContain(stoppedServicePrefix);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
        "--user is-active --quiet openshell-gateway.service",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves a user-manager failure while checking the marked service state (#10947)", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-marked-state-manager-"),
    );
    const home = path.join(root, "home");
    const configHome = path.join(root, "config");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const unit = path.join(root, "usr", "lib", "systemd", "user", "openshell-gateway.service");
    const upstreamGatewayBin = path.join(root, "usr", "bin", "openshell-gateway");
    const markedUnit = path.join(
      configHome,
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const markedGatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
    const trustedInstaller = writeTrustedInstaller(root, unit, upstreamGatewayBin);
    const metadata = [
      `FragmentPath=${unit}`,
      `ExecStart={ path=${upstreamGatewayBin} ; argv[]=${upstreamGatewayBin} ; }`,
    ].join("\n");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(upstreamGatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(markedUnit), { recursive: true });
    fs.mkdirSync(path.dirname(markedGatewayBin), { recursive: true });
    fs.writeFileSync(upstreamGatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(markedUnit, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
    fs.writeFileSync(markedGatewayBin, "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf "%b\\n" ${JSON.stringify(metadata)}`,
        "  exit 0",
        "fi",
        'if [ "$*" = "--user is-active --quiet openshell-gateway.service" ]; then exit 3; fi',
        'if [ "$*" = "--user is-active --quiet nemoclaw-openshell-gateway.service" ]; then',
        '  printf "Failed to connect to bus: No medium found\\n" >&2',
        "  exit 1",
        "fi",
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        XDG_CONFIG_HOME: configHome,
      });
      const result = runStopScript(trustedInstaller, env);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Failed to connect to bus: No medium found");
      expect(result.stdout).not.toContain(stoppedServicePrefix);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
        "--user is-active --quiet openshell-gateway.service",
        "--user is-active --quiet nemoclaw-openshell-gateway.service",
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    {
      expectedDiagnostic: "Failed to connect to bus: Host is down",
      expectedStatus: 2,
      failedCommand:
        "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
      failure: "manager" as const,
      precedingPropertyCommands: [] as string[],
      property: "unit path",
    },
    {
      expectedDiagnostic: "Failed to connect to bus: Host is down",
      expectedStatus: 2,
      failedCommand: "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value",
      failure: "manager" as const,
      precedingPropertyCommands: [
        "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
      ],
      property: "executable",
    },
    {
      expectedDiagnostic: "user service executable metadata is invalid",
      expectedStatus: 1,
      failedCommand: "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value",
      failure: "metadata" as const,
      precedingPropertyCommands: [
        "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
      ],
      property: "executable metadata",
    },
  ])(
    "refuses to fall back when the marked service $property cannot be verified (#10947)",
    ({ expectedDiagnostic, expectedStatus, failedCommand, failure, precedingPropertyCommands }) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-marked-metadata-manager-"),
      );
      const home = path.join(root, "home");
      const configHome = path.join(root, "config");
      const bin = path.join(root, "bin");
      const log = path.join(root, "systemctl.log");
      const upstreamUnit = path.join(
        root,
        "usr",
        "lib",
        "systemd",
        "user",
        "openshell-gateway.service",
      );
      const upstreamGatewayBin = path.join(root, "usr", "bin", "openshell-gateway");
      const markedUnit = path.join(
        configHome,
        "systemd",
        "user",
        "nemoclaw-openshell-gateway.service",
      );
      const markedGatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
      const trustedInstaller = writeTrustedInstaller(root, upstreamUnit, upstreamGatewayBin);
      const upstreamMetadata = [
        `FragmentPath=${upstreamUnit}`,
        `ExecStart={ path=${upstreamGatewayBin} ; argv[]=${upstreamGatewayBin} ; }`,
      ].join("\n");

      fs.mkdirSync(home, { recursive: true });
      fs.mkdirSync(bin, { recursive: true });
      fs.mkdirSync(path.dirname(upstreamGatewayBin), { recursive: true });
      fs.mkdirSync(path.dirname(markedUnit), { recursive: true });
      fs.mkdirSync(path.dirname(markedGatewayBin), { recursive: true });
      fs.writeFileSync(upstreamGatewayBin, "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(markedUnit, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
      fs.writeFileSync(markedGatewayBin, "#!/bin/sh\n", { mode: 0o755 });
      fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", {
        mode: 0o755,
      });
      fs.writeFileSync(
        path.join(bin, "systemctl"),
        [
          "#!/bin/sh",
          `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
          'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
          `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
          `  printf "%b\\n" ${JSON.stringify(upstreamMetadata)}`,
          "  exit 0",
          "fi",
          'if [ "$*" = "--user is-active --quiet openshell-gateway.service" ]; then exit 3; fi',
          'if [ "$*" = "--user is-active --quiet nemoclaw-openshell-gateway.service" ]; then exit 0; fi',
          `if [ "$*" = ${JSON.stringify(failedCommand)} ]; then`,
          ...(failure === "manager"
            ? ['  printf "Failed to connect to bus: Host is down\\n" >&2', "  exit 1"]
            : ['  printf "ExecStart={}\\n"', "  exit 0"]),
          "fi",
          `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value" ]; then printf '%s\\n' ${JSON.stringify(markedUnit)}; exit 0; fi`,
          `if [ "$*" = "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value" ]; then printf '{ path=%s ; argv[]=%s ; }\\n' ${JSON.stringify(markedGatewayBin)} ${JSON.stringify(markedGatewayBin)}; exit 0; fi`,
          "exit 97",
        ].join("\n"),
        { mode: 0o755 },
      );

      try {
        const env = buildAvailabilityProbeEnv({
          HOME: home,
          PATH: `${bin}:/usr/bin:/bin`,
          XDG_CONFIG_HOME: configHome,
        });
        const result = runStopScript(trustedInstaller, env);

        expect(result.status).toBe(expectedStatus);
        expect(result.stderr).toContain(expectedDiagnostic);
        expect(result.stdout).not.toContain(stoppedServicePrefix);
        expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
          "--user show-environment",
          upstreamServiceShow,
          "--user is-active --quiet openshell-gateway.service",
          "--user is-active --quiet nemoclaw-openshell-gateway.service",
          ...precedingPropertyCommands,
          failedCommand,
        ]);
      } finally {
        fs.rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it.each([
    "Failed to connect to bus: No medium found",
    "Failed to inspect service: Access denied",
  ])("preserves an upstream service inspection failure: %s (#10947)", (diagnostic) => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-upstream-manager-"),
    );
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");
    const candidateInstaller = writeCandidateInstaller(root, true);

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        'if [ "$*" = "--user show-environment" ]; then exit 0; fi',
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then`,
        `  printf '%s\\n' ${JSON.stringify(diagnostic)} >&2`,
        "  exit 1",
        "fi",
        "exit 97",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const result = runStopScript(candidateInstaller, env);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain(diagnostic);
      expect(result.stdout).not.toContain(stoppedServicePrefix);
      expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "--user show-environment",
        upstreamServiceShow,
      ]);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves a user-manager failure before inspecting user services (#10947)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-lifecycle-stop-manager-"));
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    const log = path.join(root, "systemctl.log");

    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n", { mode: 0o755 });
    fs.writeFileSync(
      path.join(bin, "systemctl"),
      [
        "#!/bin/sh",
        `printf "%s\\n" "$*" >> ${JSON.stringify(log)}`,
        `if [ "$*" = ${JSON.stringify(upstreamServiceShow)} ]; then exit 1; fi`,
        'if [ "$*" = "--user show-environment" ]; then',
        '  printf "Failed to connect to bus\\n" >&2',
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    try {
      const env = buildAvailabilityProbeEnv({
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
      });
      const result = runStopScript(installer, env);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("Failed to connect to bus");
      expect(fs.readFileSync(log, "utf8").trim()).toBe("--user show-environment");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });
});
