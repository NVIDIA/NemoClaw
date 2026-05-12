// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "scripts", "install.sh");

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function runPreinstallUpgradeGuard(
  env: Record<string, string> = {},
  options: { backupSucceeds?: boolean; hasCli?: boolean; supportsBackupAll?: boolean } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-upgrade-prompt-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const cliLog = path.join(tmp, "cli.log");
  const openshellLog = path.join(tmp, "openshell.log");
  const fakeCli = path.join(bin, "nemoclaw");

  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), '{"sandboxes":{"alpha":{}}}');
  const supportsBackupAll = options.supportsBackupAll === false ? "0" : "1";
  const backupSucceeds = options.backupSucceeds === false ? "0" : "1";
  writeExecutable(
    fakeCli,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${cliLog}"
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  if [ "${supportsBackupAll}" = "1" ]; then
    printf 'nemoclaw backup-all\\n'
  else
    printf 'nemoclaw onboard\\n'
  fi
  exit 0
fi
if [ "$1" = "backup-all" ] && [ "\${2:-}" != "--help" ] && [ "${backupSucceeds}" != "1" ]; then
  exit 3
fi
exit 0
`,
  );

  const resolveCli = options.hasCli === false ? "return 1" : `printf '%s' "${fakeCli}"`;
  const snippet = `
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
    info() { printf '[INFO] %s\\n' "$*"; }
    warn() { printf '[WARN] %s\\n' "$*"; }
    _CLI_BIN=nemoclaw
    HOME="${home}"
    registered_sandbox_count() { printf '1'; }
    command_exists() { [ "$1" = "openshell" ]; }
    installed_openshell_version() { printf '0.0.36'; }
    resolve_existing_cli_runner() { ${resolveCli}; }
    openshell() { printf '%s\\n' "$*" >> "${openshellLog}"; return 0; }
    preinstall_backup_and_retire_legacy_gateway
    printf 'RESTORE=%s\\n' "\${NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE:-}"
  `;

  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: { ...process.env, HOME: home, ...env },
  });

  return {
    result,
    cliLog: fs.existsSync(cliLog) ? fs.readFileSync(cliLog, "utf-8") : "",
    openshellLog: fs.existsSync(openshellLog) ? fs.readFileSync(openshellLog, "utf-8") : "",
  };
}

describe("install.sh OpenShell 0.0.37 gateway upgrade prompt", () => {
  it("aborts non-interactive legacy gateway upgrades without explicit opt-in", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard({
      NON_INTERACTIVE: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("requires explicit opt-in");
    expect(result.stdout + result.stderr).toContain(
      "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1 bash",
    );
    expect(cliLog).toContain("--help");
    expect(cliLog.split(/\r?\n/)).not.toContain("backup-all");
    expect(openshellLog).toBe("");
  });

  it("aborts before opt-in when the existing CLI cannot back up sandboxes", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
      },
      { supportsBackupAll: false },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("does not support 'nemoclaw backup-all'");
    expect(result.stdout + result.stderr).not.toContain("Accepted experimental OpenShell gateway upgrade");
    expect(result.stdout + result.stderr).not.toContain("NemoClaw can run the new automatic upgrade path now");
    expect(cliLog).toContain("--help");
    expect(cliLog.split(/\r?\n/)).not.toContain("backup-all");
    expect(openshellLog).toBe("");
  });

  it("runs the automatic backup and legacy gateway retirement when accepted", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard({
      NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Accepted experimental OpenShell gateway upgrade");
    expect(result.stdout).toContain("RESTORE=1");
    expect(cliLog).toContain("--help");
    expect(cliLog).toContain("backup-all");
    expect(openshellLog).toContain("gateway destroy -g nemoclaw");
  });

  it("aborts before retiring the legacy gateway when backup fails", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
      },
      { backupSucceeds: false },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Pre-upgrade backup failed");
    expect(cliLog).toContain("--help");
    expect(cliLog.split(/\r?\n/)).toContain("backup-all");
    expect(openshellLog).toBe("");
  });

  it("continues after the user manually prepared the old gateway state", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_UPGRADE_PREPARED: "1",
      },
      { hasCli: false },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Using manually prepared OpenShell gateway upgrade state");
    expect(result.stdout).toContain("RESTORE=1");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });
});
