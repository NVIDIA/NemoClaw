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

  it("defers a marked unit when an upstream service exists (#6903)", () => {
    const home = makeTempRoot();
    const unitPath = servicePath(home);
    fs.mkdirSync(path.dirname(unitPath), { recursive: true });
    fs.writeFileSync(unitPath, "# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n");

    const result = runInstallHelper(
      home,
      [
        "upstream_openshell_gateway_user_service_installed() { return 0; }",
        "install_nemoclaw_openshell_gateway_user_service",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(fs.existsSync(unitPath)).toBe(true);
    expect(result.stdout).toContain("upstream gateway user service is staged");
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
