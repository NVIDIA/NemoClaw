// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { TEST_SYSTEM_PATH, writeExecutable } from "./helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "install.sh");

function runInstallHelper(tmp: string, body: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    ["-c", ["set -euo pipefail", `source ${JSON.stringify(INSTALLER)}`, body].join("\n")],
    {
      cwd: tmp,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmp,
        PATH: TEST_SYSTEM_PATH,
        XDG_CONFIG_HOME: "",
        NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
        ...env,
      },
    },
  );
}

describe("install.sh OpenShell gateway service", () => {
  it("stages a Linux OpenShell gateway user service from the installer wrapper", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      tmp,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      );

      const unit = fs.readFileSync(servicePath, "utf-8");
      expect(result.status).toBe(0);
      expect(unit).toContain("# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1");
      expect(unit).toContain("After=default.target");
      expect(unit).toContain("Environment=OPENSHELL_LOCAL_TLS_DIR=%h/.local/state/openshell/tls");
      expect(unit).toContain(
        `ExecStartPre=${gatewayBin} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal --server-san localhost --server-san 127.0.0.1`,
      );
      expect(unit).toContain(`ExecStart=${gatewayBin}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reconciles the service when OpenShell already exists in if-missing mode", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      tmp,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const eventsPath = path.join(tmp, "events.log");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          'command_exists() { [[ "$1" == openshell ]]; }',
          `spin() { printf 'spin\\n' >>${JSON.stringify(eventsPath)}; return 1; }`,
          `prefer_user_local_openshell() { printf 'prefer\\n' >>${JSON.stringify(eventsPath)}; }`,
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "maybe_install_openshell_during_install if-missing",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
      expect(fs.readFileSync(eventsPath, "utf-8")).toBe("prefer\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips OpenShell reinstall on macOS when the Homebrew service is present", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const eventsPath = path.join(tmp, "events.log");

    try {
      const result = runInstallHelper(
        tmp,
        [
          'uname() { [[ "${1:-}" == "-s" ]] && printf "Darwin\\n" || printf "arm64\\n"; }',
          'command_exists() { [[ "$1" == openshell ]]; }',
          'brew() { case "$*" in "list --formula openshell") return 0 ;; "info --json=v2 openshell") printf \'%s\\n\' \'{"formulae":[{"name":"openshell","tap":"nvidia/openshell"}]}\' ;; *) return 1 ;; esac; }',
          `spin() { printf 'spin\\n' >>${JSON.stringify(eventsPath)}; return 1; }`,
          `prefer_user_local_openshell() { printf 'prefer\\n' >>${JSON.stringify(eventsPath)}; }`,
          `install_nemoclaw_openshell_gateway_user_service() { printf 'service\\n' >>${JSON.stringify(eventsPath)}; }`,
          "maybe_install_openshell_during_install if-missing",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(eventsPath, "utf-8")).toBe("prefer\nservice\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("installs OpenShell on macOS when only the CLI exists and the Homebrew service is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const eventsPath = path.join(tmp, "events.log");

    try {
      const result = runInstallHelper(
        tmp,
        [
          'uname() { [[ "${1:-}" == "-s" ]] && printf "Darwin\\n" || printf "arm64\\n"; }',
          'command_exists() { [[ "$1" == openshell ]]; }',
          'brew() { [[ "$*" == "list --formula openshell" ]] && return 1; return 0; }',
          `spin() { printf 'spin:%s\\n' "$*" >>${JSON.stringify(eventsPath)}; return 0; }`,
          `prefer_user_local_openshell() { printf 'prefer\\n' >>${JSON.stringify(eventsPath)}; }`,
          `install_nemoclaw_openshell_gateway_user_service() { printf 'service\\n' >>${JSON.stringify(eventsPath)}; }`,
          "maybe_install_openshell_during_install if-missing",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "OpenShell CLI exists but the macOS Homebrew gateway service is missing.",
      );
      const events = fs.readFileSync(eventsPath, "utf-8");
      expect(events).toContain("spin:Installing OpenShell CLI bash ");
      expect(events).toContain("/scripts/install-openshell.sh\n");
      expect(events).toContain("prefer\nservice\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses absolute XDG_CONFIG_HOME for the Linux user service path", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const configHome = path.join(tmp, "xdg-config");
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      configHome,
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
        { XDG_CONFIG_HOME: configHome },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(servicePath, "utf-8")).toContain(`ExecStart=${gatewayBin}`);
      expect(fs.existsSync(path.join(tmp, ".config", "systemd", "user"))).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not stage the default service for a custom gateway port", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      tmp,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
        { NEMOCLAW_GATEWAY_PORT: "18080" },
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects relative gateway binary paths for the default managed service", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const servicePath = path.join(
      tmp,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    writeExecutable(path.join(tmp, "openshell-gateway"), "#!/usr/bin/env bash\nexit 0\n");

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
        { NEMOCLAW_OPENSHELL_GATEWAY_BIN: "./openshell-gateway" },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("binary path is not absolute");
      expect(fs.existsSync(servicePath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("defers marked-unit reconciliation to onboarding when an upstream unit exists", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const servicePath = path.join(
      tmp,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    fs.writeFileSync(
      servicePath,
      "# NemoClaw-managed OpenShell gateway user service\n# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n",
    );

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 0; }",
          "resolve_openshell_gateway_bin_for_service() { return 1; }",
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      );

      expect(result.status).toBe(0);
      expect(fs.existsSync(servicePath)).toBe(true);
      expect(result.stdout).toContain(
        "OpenShell upstream gateway user service is staged; onboarding will select and start it.",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not overwrite a foreign user service containing the marker text", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      tmp,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const originalUnit = "# foreign unit\n# not NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1\n";
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.writeFileSync(servicePath, originalUnit);

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Refusing to replace non-NemoClaw OpenShell gateway user service",
      );
      expect(fs.readFileSync(servicePath, "utf-8")).toBe(originalUnit);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects a symlinked user service", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-install-gateway-service-"));
    const gatewayBin = path.join(tmp, ".local", "bin", "openshell-gateway");
    const servicePath = path.join(
      tmp,
      ".config",
      "systemd",
      "user",
      "nemoclaw-openshell-gateway.service",
    );
    const targetPath = path.join(tmp, "foreign.service");
    fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
    fs.mkdirSync(path.dirname(servicePath), { recursive: true });
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    fs.writeFileSync(targetPath, "# foreign unit\n");
    fs.symlinkSync(targetPath, servicePath);

    try {
      const result = runInstallHelper(
        tmp,
        [
          "upstream_openshell_gateway_user_service_installed() { return 1; }",
          `resolve_openshell_gateway_bin_for_service() { printf '%s\\n' ${JSON.stringify(gatewayBin)}; }`,
          "install_nemoclaw_openshell_gateway_user_service",
        ].join("\n"),
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Refusing to replace symlinked OpenShell gateway user service",
      );
      expect(fs.lstatSync(servicePath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(targetPath, "utf-8")).toBe("# foreign unit\n");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
