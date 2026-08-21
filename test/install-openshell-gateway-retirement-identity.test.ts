// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, it } from "vitest";

import { TEST_SYSTEM_PATH, writeExecutable } from "./helpers/installer-sourced-env";

const INSTALLER = path.join(import.meta.dirname, "..", "scripts", "install.sh");
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function runInstallerBody(home: string, body: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bash", ["-c", `source ${JSON.stringify(INSTALLER)} >/dev/null 2>&1\n${body}`], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
      NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
      ...env,
    },
    timeout: 30_000,
  });
}

async function spawnTaggedGateway(home: string, gatewayPort: number, args: string[] = []) {
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.copyFileSync("/usr/bin/yes", gatewayBin);
  fs.chmodSync(gatewayBin, 0o755);
  const gatewayName = gatewayPort === 8080 ? "nemoclaw" : `nemoclaw-${gatewayPort}`;
  const taggedArgv0 = `openshell-gateway[nemoclaw=${gatewayName};port=${gatewayPort}]`;
  const supervisor = spawn(gatewayBin, args, { argv0: taggedArgv0, stdio: "ignore" });
  await once(supervisor, "spawn");
  const pid = supervisor.pid;
  assert(pid !== undefined && Number.isSafeInteger(pid) && pid > 0, "gateway returned no PID");
  return { gatewayBin, pid, supervisor };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type MutationPoint =
  | "before-named-destroy"
  | "between-destroy-commands"
  | "before-service-stop"
  | "before-pid-fallback";

function runRetirementWithIdentityMutation(mutationPoint: MutationPoint) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-identity-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const registry = path.join(home, ".nemoclaw", "sandboxes.json");
  const identity = path.join(root, "canonical-service-identity");
  const qualificationCount = path.join(root, "qualification-count");
  const lifecycleLog = path.join(root, "lifecycle.log");
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(registry, '{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
  fs.writeFileSync(identity, "stable\n");
  writeExecutable(
    path.join(bin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> ${JSON.stringify(lifecycleLog)}`,
      'case "$*" in',
      '  "gateway destroy -g nemoclaw")',
      ...(mutationPoint === "between-destroy-commands"
        ? [`    printf 'changed\\n' > ${JSON.stringify(identity)}`]
        : []),
      "    exit 5",
      "    ;;",
      '  "gateway destroy")',
      ...(mutationPoint === "before-service-stop"
        ? [`    printf 'changed\\n' > ${JSON.stringify(identity)}`]
        : []),
      "    exit 5",
      "    ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );

  const body = [
    "set -euo pipefail",
    `source ${JSON.stringify(INSTALLER)} >/dev/null 2>&1`,
    `HOME=${JSON.stringify(home)}`,
    `mutation_point=${JSON.stringify(mutationPoint)}`,
    "info() { :; }",
    "warn() { :; }",
    "require_stable_installer_gateway_management() { _NEMOCLAW_INSTALL_GATEWAY_MANAGEMENT_MODE=managed; }",
    `nemoclaw_state_dir() { printf '%s\\n' ${JSON.stringify(path.join(home, ".nemoclaw"))}; }`,
    "nemoclaw_gateway_name() { printf 'nemoclaw\\n'; }",
    "resolve_nemoclaw_gateway_port() { printf '8080\\n'; }",
    "registered_sandbox_count() { printf '1\\n'; }",
    "require_openshell_compatible_sandbox_names() { :; }",
    "confirm_legacy_managed_image_recovery() { :; }",
    "installed_openshell_version() { printf '0.0.84\\n'; }",
    "legacy_openshell_gateway_upgrade_needed() { return 1; }",
    "run_preupgrade_backup() { :; }",
    "resolve_current_openshell_version_range() { printf '0.0.85 0.0.85\\n'; }",
    "require_no_competing_openshell_gateway_user_service() {",
    `  count=$(($(cat ${JSON.stringify(qualificationCount)} 2>/dev/null || printf 0) + 1))`,
    `  printf '%s\\n' "$count" > ${JSON.stringify(qualificationCount)}`,
    '  if [[ "$mutation_point" == "before-named-destroy" && "$count" -ge 2 ]]; then',
    `    printf 'changed\\n' > ${JSON.stringify(identity)}`,
    "  fi",
    `  OPENSHELL_GATEWAY_CANONICAL_SERVICE_SET_IDENTITY="$(cat ${JSON.stringify(identity)})"`,
    "  OPENSHELL_GATEWAY_CANONICAL_SERVICE_SET_IDENTITY_AVAILABLE=true",
    "}",
    "stop_nemoclaw_openshell_gateway_user_service() {",
    `  printf 'gateway service-stop\\n' >> ${JSON.stringify(lifecycleLog)}`,
    '  if [[ "$mutation_point" == "before-pid-fallback" ]]; then',
    `    printf 'changed\\n' > ${JSON.stringify(identity)}`,
    "  fi",
    "  return 1",
    "}",
    "stop_legacy_openshell_gateway_process() {",
    `  printf 'gateway pid-stop\\n' >> ${JSON.stringify(lifecycleLog)}`,
    "}",
    "preinstall_backup_and_retire_legacy_gateway",
  ].join("\n");
  const result = spawnSync("bash", ["-c", body], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}`,
      NEMOCLAW_REPO_ROOT: path.dirname(INSTALLER),
    },
    timeout: 30_000,
  });

  return {
    lifecycle: fs.existsSync(lifecycleLog)
      ? fs.readFileSync(lifecycleLog, "utf-8").trim().split(/\r?\n/u)
      : [],
    result,
  };
}

it.each([
  ["before-named-destroy", []],
  ["between-destroy-commands", ["gateway destroy -g nemoclaw"]],
  ["before-service-stop", ["gateway destroy -g nemoclaw", "gateway destroy"]],
  [
    "before-pid-fallback",
    ["gateway destroy -g nemoclaw", "gateway destroy", "gateway service-stop"],
  ],
] as const)(
  "blocks a canonical service mutation %s (#9705)",
  (mutationPoint, expectedLifecycle) => {
    const { lifecycle, result } = runRetirementWithIdentityMutation(mutationPoint);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("canonical service set changed before gateway retirement");
    expect(lifecycle).toEqual(expectedLifecycle);
    expect(lifecycle).not.toContain("gateway pid-stop");
  },
);

it.skipIf(process.platform !== "linux")(
  "stops only the target-bound selected-port PID-file gateway (#9705)",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-pid-target-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const runtimeDir = path.join(root, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const gateway = await spawnTaggedGateway(home, 8080);
    const pidFile = path.join(runtimeDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, `${String(gateway.pid)}\n`);

    try {
      const result = runInstallerBody(home, "stop_legacy_openshell_gateway_process", {
        NEMOCLAW_GATEWAY_PORT: "8080",
        NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: runtimeDir,
      });

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(fs.existsSync(pidFile)).toBe(false);
      expect(processExists(gateway.pid)).toBe(false);
    } finally {
      try {
        process.kill(gateway.pid, "SIGKILL");
      } catch {
        // The expected successful path already stopped the gateway.
      }
      gateway.supervisor.kill("SIGKILL");
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps a different-port PID-file gateway running (#9705)",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-pid-port-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const runtimeDir = path.join(root, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const gateway = await spawnTaggedGateway(home, 9090);
    const pidFile = path.join(runtimeDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, `${String(gateway.pid)}\n`);

    try {
      const result = runInstallerBody(home, "stop_legacy_openshell_gateway_process", {
        NEMOCLAW_GATEWAY_PORT: "8080",
        NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: runtimeDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PID-file or process identity is not target-bound");
      expect(result.stderr).not.toContain(gateway.gatewayBin);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(processExists(gateway.pid)).toBe(true);
    } finally {
      try {
        process.kill(gateway.pid, "SIGKILL");
      } catch {
        // The assertion above reports an unexpected early exit.
      }
      gateway.supervisor.kill("SIGKILL");
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps a tagged gateway that has arguments outside the owned launch contract (#9705)",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-pid-arguments-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const runtimeDir = path.join(root, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const gateway = await spawnTaggedGateway(home, 8080, ["--port", "9090"]);
    const pidFile = path.join(runtimeDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, `${String(gateway.pid)}\n`);

    try {
      const result = runInstallerBody(home, "stop_legacy_openshell_gateway_process", {
        NEMOCLAW_GATEWAY_PORT: "8080",
        NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: runtimeDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PID-file or process identity is not target-bound");
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(processExists(gateway.pid)).toBe(true);
    } finally {
      try {
        process.kill(gateway.pid, "SIGKILL");
      } catch {
        // The assertion above reports an unexpected early exit.
      }
      gateway.supervisor.kill("SIGKILL");
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps a target-bound gateway whose executable is group writable (#9705)",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-pid-mode-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const runtimeDir = path.join(root, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const gateway = await spawnTaggedGateway(home, 8080);
    const pidFile = path.join(runtimeDir, "openshell-gateway.pid");
    fs.writeFileSync(pidFile, `${String(gateway.pid)}\n`);
    fs.chmodSync(gateway.gatewayBin, 0o775);

    try {
      const result = runInstallerBody(home, "stop_legacy_openshell_gateway_process", {
        NEMOCLAW_GATEWAY_PORT: "8080",
        NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: runtimeDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PID-file or process identity is not target-bound");
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(processExists(gateway.pid)).toBe(true);
    } finally {
      try {
        process.kill(gateway.pid, "SIGKILL");
      } catch {
        // The assertion above reports an unexpected early exit.
      }
      gateway.supervisor.kill("SIGKILL");
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "keeps a selected-port gateway after its trusted binary path is replaced (#9705)",
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-pid-binary-"));
    tempRoots.push(root);
    const home = path.join(root, "home");
    const runtimeDir = path.join(root, "runtime");
    fs.mkdirSync(runtimeDir, { recursive: true });
    const gateway = await spawnTaggedGateway(home, 8080);
    const pidFile = path.join(runtimeDir, "openshell-gateway.pid");
    const replacement = `${gateway.gatewayBin}.replacement`;
    fs.writeFileSync(pidFile, `${String(gateway.pid)}\n`);
    fs.copyFileSync("/bin/cat", replacement);
    fs.chmodSync(replacement, 0o755);
    fs.renameSync(replacement, gateway.gatewayBin);

    try {
      const result = runInstallerBody(home, "stop_legacy_openshell_gateway_process", {
        NEMOCLAW_GATEWAY_PORT: "8080",
        NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: runtimeDir,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("PID-file or process identity is not target-bound");
      expect(result.stderr).not.toContain(gateway.gatewayBin);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(processExists(gateway.pid)).toBe(true);
    } finally {
      try {
        process.kill(gateway.pid, "SIGKILL");
      } catch {
        // The assertion above reports an unexpected early exit.
      }
      gateway.supervisor.kill("SIGKILL");
    }
  },
);

it("does not remove a replaced legacy gateway PID file (#9705)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-pid-replace-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const pidFile = path.join(root, "openshell-gateway.pid");
  fs.writeFileSync(pidFile, "12345\n");
  const identity = runInstallerBody(
    home,
    `trusted_gateway_service_file_identity ${JSON.stringify(pidFile)} "$EUID"`,
  );
  expect(identity.status, identity.stdout + identity.stderr).toBe(0);
  fs.rmSync(pidFile);
  fs.writeFileSync(pidFile, "replacement\n");

  const result = runInstallerBody(
    home,
    `remove_trusted_legacy_gateway_pid_file ${JSON.stringify(pidFile)} ${JSON.stringify(identity.stdout)}`,
  );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("changed during retirement");
  expect(fs.readFileSync(pidFile, "utf-8")).toBe("replacement\n");
});

it("preserves PID files that replace the trusted path during removal (#9705)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-retirement-pid-move-"));
  tempRoots.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const pidFile = path.join(root, "openshell-gateway.pid");
  const originalFile = path.join(root, "original-openshell-gateway.pid");
  const preload = path.join(root, "replace-before-pid-move.cjs");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(pidFile, "12345\n", { mode: 0o600 });
  const identity = runInstallerBody(
    home,
    `trusted_gateway_service_file_identity ${JSON.stringify(pidFile)} "$EUID"`,
  );
  expect(identity.status, identity.stdout + identity.stderr).toBe(0);

  fs.writeFileSync(
    preload,
    [
      'const fs = require("node:fs");',
      `const pidFile = ${JSON.stringify(pidFile)};`,
      `const originalFile = ${JSON.stringify(originalFile)};`,
      "const renameSync = fs.renameSync.bind(fs);",
      "let replaced = false;",
      "fs.renameSync = (source, destination) => {",
      '  if (!replaced && source === pidFile && destination.endsWith("/pid")) {',
      "    replaced = true;",
      "    renameSync(source, originalFile);",
      '    fs.writeFileSync(source, "replacement-before-move\\n", { mode: 0o600 });',
      "    renameSync(source, destination);",
      '    fs.writeFileSync(source, "replacement-after-move\\n", { mode: 0o600 });',
      "    return;",
      "  }",
      "  return renameSync(source, destination);",
      "};",
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(bin, "node"),
    [
      "#!/usr/bin/env bash",
      `export NODE_OPTIONS=${JSON.stringify(`--require=${preload}`)}`,
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      "",
    ].join("\n"),
  );

  const result = runInstallerBody(
    home,
    `remove_trusted_legacy_gateway_pid_file ${JSON.stringify(pidFile)} ${JSON.stringify(identity.stdout)}`,
    { PATH: `${bin}:${path.dirname(process.execPath)}:${TEST_SYSTEM_PATH}` },
  );
  const quarantineDirectories = fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) => entry.isDirectory() && entry.name.startsWith(".openshell-gateway.pid.retire-"),
    );

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("A replacement was preserved");
  expect(fs.readFileSync(originalFile, "utf-8")).toBe("12345\n");
  expect(fs.readFileSync(pidFile, "utf-8")).toBe("replacement-after-move\n");
  expect(quarantineDirectories).toHaveLength(1);
  expect(fs.readFileSync(path.join(root, quarantineDirectories[0].name, "pid"), "utf-8")).toBe(
    "replacement-before-move\n",
  );
});
