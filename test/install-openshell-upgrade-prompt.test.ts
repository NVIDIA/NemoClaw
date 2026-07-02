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
  options: {
    backupSucceeds?: boolean;
    fallbackBackupSucceeds?: boolean;
    fallbackAvailable?: boolean;
    hasCli?: boolean;
    openshellVersion?: string;
    supportsBackupAll?: boolean;
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-upgrade-prompt-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const cliLog = path.join(tmp, "cli.log");
  const openshellLog = path.join(tmp, "openshell.log");
  const fakeCli = path.join(bin, "nemoclaw");
  const currentCli = path.join(bin, "nemoclaw-current");
  const preparedFlag = path.join(tmp, "prepared-current-cli");

  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(home, ".nemoclaw", "sandboxes.json"), '{"sandboxes":{"alpha":{}}}');
  const supportsBackupAll = options.supportsBackupAll === false ? "0" : "1";
  const backupSucceeds = options.backupSucceeds === false ? "0" : "1";
  const fallbackAvailable = options.fallbackAvailable === true ? "1" : "0";
  const fallbackBackupSucceeds = options.fallbackBackupSucceeds === false ? "0" : "1";
  const openshellVersion = options.openshellVersion ?? "0.0.36";
  writeExecutable(
    fakeCli,
    `#!/usr/bin/env bash
printf 'old:%s\\n' "$*" >> "${cliLog}"
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
  writeExecutable(
    currentCli,
    `#!/usr/bin/env bash
printf 'current:%s\\n' "$*" >> "${cliLog}"
# Record the skip env var so the installer-integration test can prove the
# installer propagates NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP into the
# current-CLI child. See #6188 / PRA-9.
printf 'skip-env=%s\\n' "\${NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP:-}" >> "${cliLog}"
if [ "$1" = "--version" ]; then
  printf 'nemoclaw v0.1.0\\n'
  exit 0
fi
if [ "$1" = "backup-all" ] && [ "${fallbackBackupSucceeds}" != "1" ]; then
  exit 4
fi
exit 0
`,
  );

  const resolveCli =
    options.hasCli === false
      ? "return 1"
      : `[ -f "${preparedFlag}" ] && printf '%s' "${currentCli}" || printf '%s' "${fakeCli}"`;
  const snippet = `
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
    info() { printf '[INFO] %s\\n' "$*"; }
    warn() { printf '[WARN] %s\\n' "$*"; }
    _CLI_BIN=nemoclaw
    HOME="${home}"
    registered_sandbox_count() { printf '1'; }
    command_exists() { [ "$1" = "openshell" ]; }
    installed_openshell_version() { printf '${openshellVersion}'; }
    resolve_existing_cli_runner() { ${resolveCli}; }
    prepare_current_cli_for_preupgrade_backup() {
      printf 'prepare-current\\n' >> "${cliLog}"
      [ "${fallbackAvailable}" = "1" ] || return 1
      touch "${preparedFlag}"
      _CLI_PATH="${currentCli}"
      return 0
    }
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
    expect(result.stdout + result.stderr).not.toContain(
      "Accepted experimental OpenShell gateway upgrade",
    );
    expect(result.stdout + result.stderr).not.toContain(
      "NemoClaw can run the new automatic upgrade path now",
    );
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
    expect(cliLog).toContain("old:backup-all");
    expect(openshellLog).toContain("gateway destroy -g nemoclaw");
  });

  it("retries legacy backup with the current CLI before retiring the gateway", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
      },
      { backupSucceeds: false, fallbackAvailable: true },
    );

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain("Retrying with the current NemoClaw CLI");
    expect(result.stdout).toContain("RESTORE=1");
    expect(cliLog.split(/\r?\n/)).toContain("old:backup-all");
    expect(cliLog.split(/\r?\n/)).toContain("prepare-current");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
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
    expect(cliLog.split(/\r?\n/)).toContain("old:backup-all");
    expect(cliLog.split(/\r?\n/)).toContain("prepare-current");
    expect(openshellLog).toBe("");
  });

  it("aborts current-gateway upgrades when pre-upgrade backup fails", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
      },
      { backupSucceeds: false, openshellVersion: "0.0.37" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "If the failures are running sandboxes whose in-sandbox SSH endpoint is unreachable, rerun the installer with NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP=1 to continue and recover them after the upgrade (any uncommitted state since the last successful backup will be lost); otherwise restore the affected sandbox or stop its container, then rerun 'nemoclaw backup-all'.",
    );
    expect(cliLog.split(/\r?\n/)).toContain("old:backup-all");
    expect(cliLog).not.toContain("--help");
    expect(cliLog.split(/\r?\n/)).toContain("prepare-current");
    expect(openshellLog).toBe("");
  });

  it("retries current-gateway backup with the current CLI when the old CLI fails", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
      },
      { backupSucceeds: false, fallbackAvailable: true, openshellVersion: "0.0.37" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain("Retrying with the current NemoClaw CLI");
    expect(result.stdout).toContain("RESTORE=1");
    expect(cliLog).toMatch(/old:backup-all[\s\S]*prepare-current[\s\S]*current:backup-all/);
    expect(openshellLog).toBe("");
  });

  it("propagates NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP into the current-CLI backup retry (#6188)", () => {
    // The skip flag is consumed by the CLI's backup-all path (maintenance.ts's
    // shouldSkipUnreachableSandboxBackup). The installer's job is to pass the
    // env var through unchanged when it retries with the current CLI so the
    // skip logic can actually activate. This asserts the env var reaches the
    // current-CLI child process — verified via the current-mock, which echoes
    // it into cli.log. See advisor PRA-9.
    const { result, cliLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_SKIP_UNREACHABLE_SANDBOX_BACKUP: "1",
      },
      { backupSucceeds: false, fallbackAvailable: true, openshellVersion: "0.0.37" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=1");
    // The current-CLI child must see the skip env var. Empty value (unset) or
    // a truthy value that's not exactly "1" would defeat the CLI-side check.
    expect(cliLog).toMatch(/current:backup-all[\s\S]*skip-env=1/);
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
