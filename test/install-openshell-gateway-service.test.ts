// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { TEST_SYSTEM_PATH, writeExecutable } from "./helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");
const SERVICE_TEMPLATE = path.join(
  import.meta.dirname,
  "..",
  "scripts",
  "lib",
  "openshell-gateway.service.in",
);
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
        `resolve_upstream_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(upstreamGatewayBin)}; }`,
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
        `resolve_upstream_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(upstreamGatewayBin)}; }`,
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
    const systemctlBin = path.join(home, "systemctl-bin");
    fs.mkdirSync(path.dirname(conventionalGatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(overriddenGatewayBin), { recursive: true });
    fs.mkdirSync(systemctlBin);
    writeExecutable(conventionalGatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(overriddenGatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(
      path.join(systemctlBin, "systemctl"),
      `#!/usr/bin/env bash\nprintf '{ path=${overriddenGatewayBin} ; argv[]=${overriddenGatewayBin} ; ignore_errors=no ; }\\n'\n`,
    );

    const result = runInstallHelper(home, "resolve_upstream_openshell_gateway_bin_for_service", {
      PATH: `${systemctlBin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(overriddenGatewayBin);
    expect(result.stdout).not.toContain(conventionalGatewayBin);
  });

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
