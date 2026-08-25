// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TEST_SYSTEM_PATH, writeExecutable } from "../helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "../..", "install.sh");
const SERVICE_TEMPLATE = path.join(
  import.meta.dirname,
  "../..",
  "scripts",
  "lib",
  "openshell-gateway.service.in",
);
const RUNNING_AS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
  tempRoots.push(root);
  return root;
}

function servicePath(home: string, configHome = path.join(home, ".config")): string {
  return path.join(configHome, "systemd", "user", "nemoclaw-openshell-gateway.service");
}

function userGatewayBin(home: string): string {
  const binary = path.join(home, ".local", "bin", "openshell-gateway");
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  writeExecutable(binary, "#!/usr/bin/env bash\nexit 0\n");
  return binary;
}

function runInstallHelper(home: string, body: string, env: NodeJS.ProcessEnv = {}) {
  const platformBin = path.join(home, "test-platform-bin");
  fs.mkdirSync(platformBin, { recursive: true });
  writeExecutable(path.join(platformBin, "uname"), "#!/usr/bin/env bash\nprintf 'Linux\\n'\n");
  const { PATH: injectedPath, ...injectedEnv } = env;
  return spawnSync(
    "bash",
    ["-c", ["set -euo pipefail", `source ${JSON.stringify(INSTALLER)}`, body].join("\n")],
    {
      cwd: home,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${platformBin}:${injectedPath ?? `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`}`,
        XDG_CONFIG_HOME: "",
        NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        ...injectedEnv,
      },
    },
  );
}

function stageService(home: string, gatewayBin: string, env: NodeJS.ProcessEnv = {}) {
  return runInstallHelper(
    home,
    [
      "upstream_openshell_gateway_user_service_installed() { return 1; }",
      `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
      "install_nemoclaw_openshell_gateway_user_service",
    ].join("\n"),
    env,
  );
}

function writeSystemctlStub(
  home: string,
  unitPath: string,
  gatewayBin: string,
  options: { failedMetadataProperty?: "ExecStart" | "FragmentPath"; fragmentPath?: string } = {},
) {
  const bin = path.join(home, "systemctl-bin");
  const log = path.join(home, "systemctl.log");
  const active = path.join(home, "gateway-service.active");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(active, "active\n");
  writeExecutable(
    path.join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      '  "--user is-active --quiet nemoclaw-openshell-gateway.service")',
      `    test -f ${JSON.stringify(active)}`,
      "    ;;",
      '  "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value")',
      options.failedMetadataProperty === "FragmentPath"
        ? "    exit 98"
        : `    printf '%s\\n' ${JSON.stringify(options.fragmentPath ?? unitPath)}`,
      "    ;;",
      '  "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value")',
      options.failedMetadataProperty === "ExecStart"
        ? "    exit 98"
        : `    printf '{ path=%s ; argv[]=%s ; ignore_errors=no ; }\\n' ${JSON.stringify(gatewayBin)} ${JSON.stringify(gatewayBin)}`,
      "    ;;",
      '  "--user stop nemoclaw-openshell-gateway.service")',
      `    rm -f ${JSON.stringify(active)}`,
      "    ;;",
      "  *) exit 97 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  return { bin, log };
}

function writeUpstreamSystemctlStub(
  home: string,
  options: {
    diagnostic?: string;
    execStart?: string;
    fragmentPath?: string;
    gatewayBin?: string;
    status?: number;
  },
) {
  const bin = path.join(home, "upstream-systemctl-bin");
  const log = path.join(home, "upstream-systemctl.log");
  const status = options.status ?? 0;
  fs.mkdirSync(bin, { recursive: true });
  const response =
    status === 0
      ? [
          `printf 'FragmentPath=%s\\n' ${JSON.stringify(options.fragmentPath ?? "")}`,
          options.execStart === undefined
            ? `printf 'ExecStart={ path=%s ; argv[]=%s ; ignore_errors=no ; }\\n' ${JSON.stringify(options.gatewayBin ?? "")} ${JSON.stringify(options.gatewayBin ?? "")}`
            : `printf 'ExecStart=%s\\n' ${JSON.stringify(options.execStart)}`,
        ]
      : [
          ...(options.diagnostic ?? "systemctl failed")
            .split(/\r?\n/)
            .map((line) => `printf '%s\\n' ${JSON.stringify(line)} >&2`),
          `exit ${status}`,
        ];
  writeExecutable(
    path.join(bin, "systemctl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      'case "$*" in',
      '  "--user show openshell-gateway.service --property=FragmentPath --property=ExecStart")',
      ...response.map((line) => `    ${line}`),
      "    ;;",
      "  *) exit 97 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  return { bin, log };
}

describe("install.sh OpenShell gateway service", () => {
  it.each([
    "user-local",
    "system-local",
  ])("stages the shared Linux template for a %s binary (#6903)", (installKind) => {
    const home = makeTempRoot();
    const configHome = path.join(home, "xdg-config");
    const gatewayBin =
      installKind === "user-local" ? userGatewayBin(home) : "/usr/local/bin/openshell-gateway";

    const result = stageService(home, gatewayBin, { XDG_CONFIG_HOME: configHome });
    const unit = fs.readFileSync(servicePath(home, configHome), "utf-8");

    expect(result.status).toBe(0);
    expect(unit).toBe(
      fs.readFileSync(SERVICE_TEMPLATE, "utf-8").replaceAll("@OPENSHELL_GATEWAY_BIN@", gatewayBin),
    );
    expect(unit).toContain("# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1");
    expect(unit).toContain("Environment=OPENSHELL_LOCAL_TLS_DIR=%S/openshell/tls");
    expect(unit).toContain(`ExecStart=${gatewayBin}`);
    expect(unit).not.toContain("@OPENSHELL_GATEWAY_BIN@");
    expect(fs.existsSync(path.join(home, ".config", "systemd", "user"))).toBe(false);
  });

  it("stages a user-local binary from an absolute XDG bin home (#6903)", () => {
    const home = makeTempRoot();
    const xdgBinHome = path.join(home, "custom-bin");
    const gatewayBin = path.join(xdgBinHome, "openshell-gateway");
    fs.mkdirSync(xdgBinHome, { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    const result = stageService(home, gatewayBin, { XDG_BIN_HOME: xdgBinHome });
    const unit = fs.readFileSync(servicePath(home), "utf-8");

    expect(result.status).toBe(0);
    expect(unit).toContain(`ExecStart=${gatewayBin}`);
  });

  it("leaves custom gateway ports on the detached lifecycle (#6903)", () => {
    const home = makeTempRoot();
    const result = stageService(home, userGatewayBin(home), { NEMOCLAW_GATEWAY_PORT: "18080" });

    expect(result.status).toBe(0);
    expect(fs.existsSync(servicePath(home))).toBe(false);
  });

  it("rejects a relative gateway binary path (#6903)", () => {
    const home = makeTempRoot();
    writeExecutable(path.join(home, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");
    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 1; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
      { NEMOCLAW_OPENSHELL_GATEWAY_BIN: "./openshell-gateway" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("binary path is not absolute");
    expect(fs.existsSync(servicePath(home))).toBe(false);
  });

  it("defers a marked unit when the upstream service version matches (#6903)", () => {
    const home = makeTempRoot();
    const unitPath = servicePath(home);
    const nemoclawGatewayBin = userGatewayBin(home);
    const upstreamGatewayBin = path.join(home, "usr", "bin", "openshell-gateway");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");
    fs.mkdirSync(path.dirname(upstreamGatewayBin), { recursive: true });
    writeExecutable(
      nemoclawGatewayBin,
      "#!/usr/bin/env bash\nprintf 'openshell-gateway 0.0.85\\n'\n",
    );
    writeExecutable(
      upstreamGatewayBin,
      "#!/usr/bin/env bash\nprintf 'openshell-gateway 0.0.85\\n'\n",
    );

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(nemoclawGatewayBin)}; }`,
        `inspect_upstream_openshell_gateway_user_service() { UPSTREAM_OPENSHELL_GATEWAY_SERVICE_BIN=${JSON.stringify(upstreamGatewayBin)}; return 0; }`,
        "trusted_openshell_gateway_bin_for_service() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(result.stdout).toContain("upstream gateway user service is staged");
  });

  it("stops before onboarding when the upstream service version differs (#8051)", () => {
    const home = makeTempRoot();
    const nemoclawGatewayBin = userGatewayBin(home);
    const upstreamGatewayBin = path.join(home, "usr", "bin", "openshell-gateway");
    fs.mkdirSync(path.dirname(upstreamGatewayBin), { recursive: true });
    writeExecutable(
      nemoclawGatewayBin,
      "#!/usr/bin/env bash\nprintf 'openshell-gateway 0.0.85\\n'\n",
    );
    writeExecutable(
      upstreamGatewayBin,
      "#!/usr/bin/env bash\nprintf 'openshell-gateway 0.0.91\\n'\n",
    );

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(nemoclawGatewayBin)}; }`,
        `inspect_upstream_openshell_gateway_user_service() { UPSTREAM_OPENSHELL_GATEWAY_SERVICE_BIN=${JSON.stringify(upstreamGatewayBin)}; return 0; }`,
        "trusted_openshell_gateway_bin_for_service() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("OpenShell gateway version mismatch");
    expect(result.stderr).toContain("0.0.85");
    expect(result.stderr).toContain("0.0.91");
    expect(result.stderr).toContain("sudo apt remove openshell");
    expect(result.stdout).not.toContain("upstream gateway user service is staged");
    expect(fs.existsSync(servicePath(home))).toBe(false);
  });

  it("resolves the gateway from the effective upstream ExecStart (#8051)", () => {
    const home = makeTempRoot();
    const conventionalGatewayBin = path.join(home, "usr", "bin", "openshell-gateway");
    const overriddenGatewayBin = path.join(home, "opt", "openshell", "openshell-gateway");
    const upstreamUnit = path.join(
      home,
      "usr",
      "lib",
      "systemd",
      "user",
      "openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(conventionalGatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(overriddenGatewayBin), { recursive: true });
    writeExecutable(conventionalGatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(overriddenGatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    const systemctl = writeUpstreamSystemctlStub(home, {
      fragmentPath: upstreamUnit,
      gatewayBin: overriddenGatewayBin,
    });

    const result = runInstallHelper(
      home,
      [
        `trusted_upstream_openshell_gateway_unit_for_service() { [[ "$1" == ${JSON.stringify(upstreamUnit)} ]]; }`,
        `trusted_upstream_openshell_gateway_bin_for_service() { [[ "$1" == ${JSON.stringify(overriddenGatewayBin)} ]]; }`,
        "resolve_upstream_openshell_gateway_bin_for_service",
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(overriddenGatewayBin);
    expect(result.stdout).not.toContain(conventionalGatewayBin);
  });

  it("rejects duplicate effective ExecStart records even when their paths match (#8926)", () => {
    const home = makeTempRoot();
    const gatewayBin = path.join(home, "usr", "bin", "openshell-gateway");
    const upstreamUnit = path.join(
      home,
      "usr",
      "lib",
      "systemd",
      "user",
      "openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    const systemctl = writeUpstreamSystemctlStub(home, {
      execStart: `{ path=${gatewayBin} ; }; { path=${gatewayBin} ; }`,
      fragmentPath: upstreamUnit,
    });

    const result = runInstallHelper(
      home,
      [
        `trusted_upstream_openshell_gateway_unit_for_service() { [[ "$1" == ${JSON.stringify(upstreamUnit)} ]]; }`,
        `trusted_upstream_openshell_gateway_bin_for_service() { [[ "$1" == ${JSON.stringify(gatewayBin)} ]]; }`,
        'inspect_upstream_openshell_gateway_user_service || { printf "%s\\n" "$UPSTREAM_OPENSHELL_GATEWAY_SERVICE_ERROR" >&2; exit 1; }',
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("did not return one executable path");
  });

  it("keeps the standalone gateway when the systemd user manager is unavailable (#8926)", () => {
    const home = makeTempRoot();
    const systemctl = writeUpstreamSystemctlStub(home, {
      diagnostic: "Failed to connect to bus: No medium found",
      status: 1,
    });

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("existing standalone gateway");
    expect(result.stdout).toContain("port 8080");
    expect(fs.existsSync(servicePath(home))).toBe(false);
    expect(fs.readFileSync(systemctl.log, "utf-8").trim()).toBe(
      "--user show openshell-gateway.service --property=FragmentPath --property=ExecStart",
    );
  });

  it.each([
    "openshell-gateway",
    "nemoclaw-openshell-gateway",
  ])("blocks standalone fallback when an enabled %s user service could claim port 8080 (#8926)", (serviceName) => {
    const home = makeTempRoot();
    const activationPath = path.join(
      home,
      ".config",
      "systemd",
      "user",
      "default.target.wants",
      `${serviceName}.service`,
    );
    fs.mkdirSync(path.dirname(activationPath), { recursive: true });
    fs.symlinkSync(path.join(home, "missing-package-unit.service"), activationPath);
    const systemctl = writeUpstreamSystemctlStub(home, {
      diagnostic: "Failed to connect to bus: No medium found",
      status: 1,
    });

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(activationPath);
    expect(result.stderr).toContain("claim port 8080");
    expect(result.stderr).toContain("Restore the systemd user manager");
    expect(fs.lstatSync(activationPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(servicePath(home))).toBe(false);
  });

  it.each([
    ["user data", ".local/share/systemd/user/session.target.wants"],
    ["user runtime", "runtime/systemd/user/default.target.wants"],
    ["user control", ".config/systemd/user.control/default.target.wants"],
    ["runtime control", "runtime/systemd/user.control/default.target.requires"],
    ["early generator", "runtime/systemd/generator.early/default.target.wants"],
    ["generator", "runtime/systemd/generator/default.target.requires"],
    ["late generator", "runtime/systemd/generator.late/default.target.wants"],
    ["transient", "runtime/systemd/transient/default.target.requires"],
    ["upheld", "xdg-data/systemd/user/default.target.upholds"],
    ["data directory", "xdg-data/systemd/user/default.target.requires"],
  ])("blocks standalone fallback for an activation link in the %s root (#8926)", (_root, relativeDirectory) => {
    const home = makeTempRoot();
    const activationDirectory = path.join(home, relativeDirectory);
    const activationPath = path.join(activationDirectory, "openshell-gateway.service");
    fs.mkdirSync(activationDirectory, { recursive: true });
    fs.symlinkSync(path.join(home, "missing-package-unit.service"), activationPath);
    const systemctl = writeUpstreamSystemctlStub(home, {
      diagnostic: "Failed to connect to bus: No medium found",
      status: 1,
    });
    const env: NodeJS.ProcessEnv = {
      PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
      ...(relativeDirectory.startsWith("runtime/")
        ? { XDG_RUNTIME_DIR: path.join(home, "runtime") }
        : {}),
      ...(relativeDirectory.startsWith("xdg-data/")
        ? { XDG_DATA_DIRS: path.join(home, "xdg-data") }
        : {}),
    };

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
      env,
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(activationPath);
    expect(fs.lstatSync(activationPath).isSymbolicLink()).toBe(true);
  });

  it("fails closed when the upstream service query returns an unknown error (#8926)", () => {
    const home = makeTempRoot();
    const systemctl = writeUpstreamSystemctlStub(home, {
      diagnostic:
        "Failed to connect to bus: No medium found\nFailed to connect to bus: Permission denied",
      status: 1,
    });

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Failed to connect to bus: Permission denied");
    expect(result.stdout).not.toContain("existing standalone gateway");
    expect(fs.existsSync(servicePath(home))).toBe(false);
  });

  it("fails closed when SYSTEMD_UNIT_PATH overrides the unit search path (#8926)", () => {
    const home = makeTempRoot();
    const systemdUnitPath = `${path.join(home, "custom-systemd", "user")}\nspoofed-log-line`;
    const systemctl = writeUpstreamSystemctlStub(home, {
      diagnostic: "Failed to connect to bus: No medium found",
      status: 1,
    });

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
      {
        PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
        SYSTEMD_UNIT_PATH: systemdUnitPath,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SYSTEMD_UNIT_PATH=");
    expect(result.stderr).toContain("\\nspoofed-log-line");
    expect(result.stderr).not.toContain("\nspoofed-log-line");
    expect(result.stdout).not.toContain("existing standalone gateway");
  });

  it.skipIf(RUNNING_AS_ROOT)(
    "fails closed when an activation root cannot be inspected (#8926)",
    () => {
      const home = makeTempRoot();
      const dataHome = path.join(home, "xdg-data");
      const activationRoot = path.join(dataHome, "systemd", "user");
      fs.mkdirSync(activationRoot, { recursive: true });
      fs.chmodSync(activationRoot, 0o000);
      const systemctl = writeUpstreamSystemctlStub(home, {
        diagnostic: "Failed to connect to bus: No medium found",
        status: 1,
      });

      let result: ReturnType<typeof runInstallHelper>;
      try {
        result = runInstallHelper(
          home,
          [
            "upstream_openshell_gateway_user_service_installed() { return 0; }",
            "install_nemoclaw_openshell_gateway_user_service",
          ].join("\n"),
          {
            PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
            XDG_DATA_HOME: dataHome,
          },
        );
      } finally {
        fs.chmodSync(activationRoot, 0o700);
      }

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("could not inspect");
      expect(result.stderr).toContain(activationRoot);
    },
  );

  it("stops an active trusted NemoClaw gateway user service during upgrade retirement (#8800)", () => {
    const home = makeTempRoot();
    const gatewayBin = userGatewayBin(home);
    const staged = stageService(home, gatewayBin);
    const unitPath = servicePath(home);
    const systemctl = writeSystemctlStub(home, unitPath, gatewayBin);

    expect(staged.status, staged.stdout + staged.stderr).toBe(0);

    const result = runInstallHelper(home, "stop_nemoclaw_openshell_gateway_user_service", {
      PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.readFileSync(systemctl.log, "utf-8").trim().split(/\r?\n/)).toEqual([
      "--user is-active --quiet nemoclaw-openshell-gateway.service",
      "--user show nemoclaw-openshell-gateway.service --property=FragmentPath --value",
      "--user show nemoclaw-openshell-gateway.service --property=ExecStart --value",
      "--user stop nemoclaw-openshell-gateway.service",
      "--user is-active --quiet nemoclaw-openshell-gateway.service",
    ]);
  });

  it.each([
    "FragmentPath",
    "ExecStart",
  ] as const)("returns control for the PID-file fallback when %s service metadata is unavailable (#8800)", (failedMetadataProperty) => {
    const home = makeTempRoot();
    const gatewayBin = userGatewayBin(home);
    const staged = stageService(home, gatewayBin);
    const systemctl = writeSystemctlStub(home, servicePath(home), gatewayBin, {
      failedMetadataProperty,
    });

    expect(staged.status, staged.stdout + staged.stderr).toBe(0);

    const result = runInstallHelper(
      home,
      "stop_nemoclaw_openshell_gateway_user_service || printf 'pid-file-fallback\\n'",
      { PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
    );
    const calls = fs.readFileSync(systemctl.log, "utf-8");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(calls).toContain(
      `--user show nemoclaw-openshell-gateway.service --property=${failedMetadataProperty} --value`,
    );
    expect(result.stdout).toContain("pid-file-fallback");
    expect(calls).not.toContain("--user stop nemoclaw-openshell-gateway.service");
  });

  it("does not stop a user service whose active fragment differs from the trusted unit (#8800)", () => {
    const home = makeTempRoot();
    const gatewayBin = userGatewayBin(home);
    const staged = stageService(home, gatewayBin);
    const systemctl = writeSystemctlStub(home, servicePath(home), gatewayBin, {
      fragmentPath: path.join(home, "foreign.service"),
    });

    expect(staged.status, staged.stdout + staged.stderr).toBe(0);

    const result = runInstallHelper(home, "stop_nemoclaw_openshell_gateway_user_service", {
      PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    });
    const calls = fs.readFileSync(systemctl.log, "utf-8");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("active user service does not match");
    expect(calls).not.toContain("--user stop nemoclaw-openshell-gateway.service");
  });

  it("does not stop a trusted unit whose active command uses an untrusted binary (#8800)", () => {
    const home = makeTempRoot();
    const gatewayBin = userGatewayBin(home);
    const foreignGatewayBin = path.join(home, "foreign", "openshell-gateway");
    fs.mkdirSync(path.dirname(foreignGatewayBin), { recursive: true });
    writeExecutable(foreignGatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    const staged = stageService(home, gatewayBin);
    const systemctl = writeSystemctlStub(home, servicePath(home), foreignGatewayBin);

    expect(staged.status, staged.stdout + staged.stderr).toBe(0);

    const result = runInstallHelper(home, "stop_nemoclaw_openshell_gateway_user_service", {
      PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    });
    const calls = fs.readFileSync(systemctl.log, "utf-8");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("user service with an untrusted binary");
    expect(calls).not.toContain("--user stop nemoclaw-openshell-gateway.service");
  });

  it("does not inspect the default gateway user service for a custom gateway port (#8800)", () => {
    const home = makeTempRoot();
    const gatewayBin = userGatewayBin(home);
    const staged = stageService(home, gatewayBin);
    const systemctl = writeSystemctlStub(home, servicePath(home), gatewayBin);

    expect(staged.status, staged.stdout + staged.stderr).toBe(0);

    const result = runInstallHelper(home, "stop_nemoclaw_openshell_gateway_user_service", {
      NEMOCLAW_GATEWAY_PORT: "18080",
      PATH: `${systemctl.bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    });

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(systemctl.log)).toBe(false);
  });

  it("does not overwrite a foreign unit at the NemoClaw path (#6903)", () => {
    const home = makeTempRoot();
    const unitPath = servicePath(home);
    const original = "# foreign unit\n# not NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n";
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, original);

    const result = stageService(home, userGatewayBin(home));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to replace non-NemoClaw");
    expect(fs.readFileSync(unitPath, "utf-8")).toBe(original);
  });

  it("does not follow a symlink at the NemoClaw unit path (#6903)", () => {
    const home = makeTempRoot();
    const unitPath = servicePath(home);
    const targetPath = path.join(home, "foreign.service");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(targetPath, "# foreign unit\n");
    fs.symlinkSync(targetPath, unitPath);

    const result = stageService(home, userGatewayBin(home));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to replace symlinked");
    expect(fs.lstatSync(unitPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("# foreign unit\n");
  });

  it("rejects a unit path swapped to a symlink after validation (#6903)", () => {
    const home = makeTempRoot();
    const unitPath = servicePath(home);
    const targetPath = path.join(home, "foreign.service");
    const raceBin = path.join(home, "race-bin");
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.mkdirSync(raceBin);
    fs.writeFileSync(targetPath, "# foreign unit\n");
    writeExecutable(
      path.join(raceBin, "node"),
      [
        "#!/usr/bin/env bash",
        `rm -f -- ${JSON.stringify(unitPath)}`,
        `ln -s -- ${JSON.stringify(targetPath)} ${JSON.stringify(unitPath)}`,
        `exec ${JSON.stringify(process.execPath)} "$@"`,
        "",
      ].join("\n"),
    );

    const result = stageService(home, userGatewayBin(home), {
      PATH: `${raceBin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Refusing to replace symlinked");
    expect(fs.lstatSync(unitPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, "utf-8")).toBe("# foreign unit\n");
  });
});
