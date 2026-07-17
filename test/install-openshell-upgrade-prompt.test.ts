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
    currentBackupSucceeds?: boolean;
    currentCliAvailable?: boolean;
    currentMinOpenshellVersion?: string;
    gatewayDestroySucceeds?: boolean;
    gatewayProcessStopSucceeds?: boolean;
    gatewayRemoveSucceeds?: boolean;
    hasOldCli?: boolean;
    openshellOnPath?: boolean;
    openshellVersion?: string;
    registryJson?: string;
    userLocalOpenshell?: boolean;
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-upgrade-prompt-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const cliLog = path.join(tmp, "cli.log");
  const openshellLog = path.join(tmp, "openshell.log");
  const oldCli = path.join(bin, "nemoclaw");
  const currentCli = path.join(bin, "nemoclaw-current");
  const preparedFlag = path.join(tmp, "prepared-current-cli");
  const currentSource = path.join(tmp, "current-source");

  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.mkdirSync(path.join(currentSource, "nemoclaw-blueprint"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(currentSource, "nemoclaw-blueprint", "blueprint.yaml"),
    `min_openshell_version: "${options.currentMinOpenshellVersion ?? "0.0.85"}"\nmax_openshell_version: "0.0.85"\n`,
  );
  fs.writeFileSync(
    path.join(home, ".nemoclaw", "sandboxes.json"),
    options.registryJson ?? '{"sandboxes":{"alpha":{"name":"alpha"}}}',
  );
  const currentCliAvailable = options.currentCliAvailable === false ? "0" : "1";
  const currentBackupSucceeds = options.currentBackupSucceeds === false ? "0" : "1";
  const openshellVersion = options.openshellVersion ?? "0.0.36";
  const gatewayDestroySucceeds = options.gatewayDestroySucceeds === true ? "1" : "0";
  const gatewayProcessStopSucceeds = options.gatewayProcessStopSucceeds === false ? "0" : "1";
  const gatewayRemoveSucceeds = options.gatewayRemoveSucceeds === false ? "0" : "1";

  writeExecutable(
    oldCli,
    `#!/usr/bin/env bash
printf 'old:%s\\n' "$*" >> "${cliLog}"
if [ "\${1:-}" = "--help" ]; then printf 'nemoclaw backup-all\\n'; fi
exit 0
`,
  );
  writeExecutable(
    currentCli,
    `#!/usr/bin/env bash
printf 'current:%s\\n' "$*" >> "${cliLog}"
printf 'require-all-env=%s\\n' "\${NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS:-}" >> "${cliLog}"
if [ "\${1:-}" = "--version" ]; then
  printf 'nemoclaw v0.1.0\\n'
  exit 0
fi
if [ "\${1:-}" = "backup-all" ] && [ "${currentBackupSucceeds}" != "1" ]; then
  exit 4
fi
exit 0
`,
  );
  const openshellScript = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${openshellLog}"
if [ "\${1:-} \${2:-}" = "gateway remove" ] && [ "${gatewayRemoveSucceeds}" != "1" ]; then
  exit 4
fi
if [ "\${1:-} \${2:-}" = "gateway destroy" ] && [ "${gatewayDestroySucceeds}" != "1" ]; then
  exit 5
fi
exit 0
`;
  const openshellTargets = [
    options.openshellOnPath !== false ? path.join(bin, "openshell") : null,
    options.userLocalOpenshell === true ? path.join(home, ".local", "bin", "openshell") : null,
  ].filter((target): target is string => target !== null);
  for (const target of openshellTargets) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeExecutable(target, openshellScript);
  }
  writeExecutable(path.join(bin, "python3"), "#!/usr/bin/env bash\nexit 127\n");

  const resolveCli =
    options.hasOldCli === false
      ? "return 1"
      : `[ -f "${preparedFlag}" ] && printf '%s' "${currentCli}" || printf '%s' "${oldCli}"`;
  const snippet = `
    source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
    info() { printf '[INFO] %s\\n' "$*"; }
    warn() { printf '[WARN] %s\\n' "$*"; }
    _CLI_BIN=nemoclaw
    HOME="${home}"
    NEMOCLAW_SOURCE_ROOT="${currentSource}"
    installed_openshell_version() { printf '${openshellVersion}'; }
    stop_legacy_openshell_gateway_process() {
      printf 'gateway process-stop\n' >> "${openshellLog}"
      [ "${gatewayProcessStopSucceeds}" = "1" ]
    }
    resolve_existing_cli_runner() { ${resolveCli}; }
    prepare_current_cli_for_preupgrade_backup() {
      printf 'prepare-current\\n' >> "${cliLog}"
      [ "${currentCliAvailable}" = "1" ] || return 1
      touch "${preparedFlag}"
      _CLI_PATH="${currentCli}"
      return 0
    }
    preinstall_backup_and_retire_legacy_gateway
    printf 'RESTORE=%s\\n' "\${NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE:-}"
    printf 'CONFIRMED_NAMES=%s\\n' "\${_LEGACY_MANAGED_RECOVERY_NAMES_JSON:-}"
  `;

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ...env,
  };
  const inheritedControlKeys = [
    "NON_INTERACTIVE",
    "NEMOCLAW_NON_INTERACTIVE",
    "NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE",
    "NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE",
    "NEMOCLAW_OPENSHELL_BIN",
    "NEMOCLAW_OPENSHELL_UPGRADE_PREPARED",
    "XDG_BIN_HOME",
  ].filter((key) => !(key in env));
  for (const key of inheritedControlKeys) delete childEnv[key];
  const result = spawnSync("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: childEnv,
  });

  return {
    result,
    cliLog: fs.existsSync(cliLog) ? fs.readFileSync(cliLog, "utf-8") : "",
    openshellLog: fs.existsSync(openshellLog) ? fs.readFileSync(openshellLog, "utf-8") : "",
  };
}

describe("install.sh OpenShell gateway upgrade guard", () => {
  it.skipIf(process.platform !== "linux")(
    "stops only the verified gateway process recorded in the owned runtime PID file",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-legacy-gateway-stop-"));
      const runtimeDir = path.join(tmp, "runtime");
      const gatewayBin = path.join(tmp, "openshell-gateway");
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.copyFileSync("/bin/sleep", gatewayBin);
      fs.chmodSync(gatewayBin, 0o755);

      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${runtimeDir}"
"${gatewayBin}" 60 &
gateway_pid=$!
printf '%s\\n' "$gateway_pid" >"${runtimeDir}/openshell-gateway.pid"
stop_legacy_openshell_gateway_process
wait "$gateway_pid" 2>/dev/null || true
if kill -0 "$gateway_pid" 2>/dev/null; then exit 9; fi
test ! -e "${runtimeDir}/openshell-gateway.pid"`,
        ],
        { encoding: "utf-8" },
      );

      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "clears a stale owned gateway PID file and continues retirement",
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-stale-gateway-pid-"));
      const pidFile = path.join(tmp, "openshell-gateway.pid");
      fs.writeFileSync(pidFile, "999999999\n");

      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${tmp}"
stop_legacy_openshell_gateway_process
test ! -e "${pidFile}"`,
        ],
        { encoding: "utf-8" },
      );

      expect(result.status, result.stdout + result.stderr).toBe(0);
    },
  );

  it("aborts non-interactive legacy gateway upgrades without explicit opt-in", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard({
      NON_INTERACTIVE: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("requires explicit opt-in");
    const output = result.stdout + result.stderr;
    expect(output).toContain(
      "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1 bash",
    );
    expect(output).not.toContain(
      "NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1 NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE=1",
    );
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("scopes non-default manual upgrade commands to the selected gateway", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_GATEWAY_PORT: "9123",
      },
      {
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","gatewayName":"nemoclaw-9123","gatewayPort":9123}}}',
      },
    );

    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(
      "NEMOCLAW_GATEWAY_PORT=9123 NEMOCLAW_REQUIRE_ALL_SANDBOX_BACKUPS=1 nemoclaw backup-all",
    );
    expect(output).toContain(
      "openshell gateway remove nemoclaw-9123 || openshell gateway destroy -g nemoclaw-9123",
    );
    expect(output).toContain(
      "curl -fsSL https://www.nvidia.com/nemoclaw.sh | NEMOCLAW_GATEWAY_PORT=9123 NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1 bash",
    );
    expect(output).toContain("NEMOCLAW_GATEWAY_PORT=9123 nemoclaw upgrade-sandboxes --check");
    expect(output).not.toContain("openshell gateway remove nemoclaw ||");
    expect(output).not.toContain("|| openshell gateway destroy\n");
    expect(output).not.toContain("pkill -f openshell-gateway");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("requires separate managed-image confirmation before preparing a backup (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard({
      NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Legacy sandbox recovery requires explicit confirmation",
    );
    expect(result.stdout + result.stderr).toContain('"alpha"');
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("uses only the current CLI for strict backup before legacy gateway retirement (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard({
      NON_INTERACTIVE: "1",
      NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
      NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=1");
    expect(result.stdout).toContain('CONFIRMED_NAMES=["alpha"]');
    expect(result.stdout).toContain('"alpha"');
    expect(cliLog.split(/\r?\n/)).toContain("prepare-current");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(cliLog).toContain("require-all-env=1");
    expect(cliLog).not.toContain("old:");
    expect(openshellLog).toContain("gateway remove nemoclaw");
  });

  it("aborts before gateway retirement when the current CLI cannot be prepared", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      { currentCliAvailable: false },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Pre-upgrade backup failed");
    expect(cliLog.split(/\r?\n/)).toContain("prepare-current");
    expect(cliLog).not.toContain("current:backup-all");
    expect(openshellLog).toBe("");
  });

  it("aborts before gateway retirement when the current backup fails", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      { currentBackupSucceeds: false },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("Pre-upgrade backup failed");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(cliLog).toContain("require-all-env=1");
    expect(cliLog).not.toContain("old:");
    expect(openshellLog).toBe("");
  });

  it("uses generic backup remediation outside the legacy gateway path (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      { currentBackupSucceeds: false, openshellVersion: "0.0.44" },
    );

    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(
      "Resolve every reported sandbox backup failure or skipped sandbox using the CLI output above",
    );
    expect(output).not.toContain("NEMOCLAW_OPENSHELL_UPGRADE_PREPARED");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toBe("");
  });

  it("handles the v0.0.55 OpenShell 0.0.44 shape without an old CLI (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      { hasOldCli: false, openshellVersion: "0.0.44" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=1");
    expect(result.stdout).toContain('CONFIRMED_NAMES=["alpha"]');
    expect(cliLog.split(/\r?\n/)).toContain("prepare-current");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(cliLog).toContain("require-all-env=1");
    expect(cliLog).not.toContain("old:");
    expect(openshellLog).toContain("gateway remove nemoclaw");
  });

  it("discovers a v0.0.55 user-local OpenShell before preparing recovery (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      {
        hasOldCli: false,
        openshellOnPath: false,
        openshellVersion: "0.0.44",
        userLocalOpenshell: true,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=1");
    expect(result.stdout).toContain('CONFIRMED_NAMES=["alpha"]');
    expect(cliLog.split(/\r?\n/)).toContain("prepare-current");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(cliLog).toContain("require-all-env=1");
    expect(openshellLog).toContain("gateway remove nemoclaw");
  });

  it("leaves recovery preparation untouched when OpenShell is not installed (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      { hasOldCli: false, openshellOnPath: false, openshellVersion: "0.0.44" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=");
    expect(result.stdout).toContain("CONFIRMED_NAMES=[]");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("confirms a normalized legacy row whose custom-image marker is null (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      {
        hasOldCli: false,
        openshellVersion: "0.0.44",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":null,"fromDockerfile":null}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('CONFIRMED_NAMES=["alpha"]');
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toContain("gateway remove nemoclaw");
  });

  it("keeps a backed-up gateway whose OpenShell version is already supported", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toBe("");
  });

  it("retires a backed-up gateway whose OpenShell version is above the supported range", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        hasOldCli: false,
        openshellVersion: "0.0.86",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toContain("gateway remove nemoclaw");
  });

  it("fails closed before gateway retirement when the supported range is invalid", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      {
        currentMinOpenshellVersion: "latest",
        hasOldCli: false,
        openshellVersion: "0.0.44",
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Could not resolve the current OpenShell version range",
    );
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toBe("");
  });

  it("fails closed after backup when the installed OpenShell version is unknown", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        hasOldCli: false,
        openshellVersion: "",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Could not determine the installed OpenShell version",
    );
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toBe("");
  });

  it("uses a supported legacy destroy verb without stopping a recorded host process", () => {
    const { result, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        gatewayDestroySucceeds: true,
        gatewayRemoveSucceeds: false,
        hasOldCli: false,
        openshellVersion: "0.0.86",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(openshellLog).toContain("gateway destroy -g nemoclaw");
    expect(openshellLog).not.toContain("gateway process-stop");
    expect(openshellLog).not.toContain("gateway remove nemoclaw");
  });

  it("fails closed after backup when no gateway retirement verb succeeds", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        gatewayDestroySucceeds: false,
        gatewayProcessStopSucceeds: false,
        gatewayRemoveSucceeds: false,
        hasOldCli: false,
        openshellVersion: "0.0.86",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Could not retire the legacy OpenShell gateway after backup",
    );
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog.split(/\r?\n/)).toEqual(
      expect.arrayContaining([
        "gateway destroy -g nemoclaw",
        "gateway destroy",
        "gateway process-stop",
      ]),
    );
  });

  it("rejects a managed-image confirmation that is not a JSON name array (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: "true",
      },
      { openshellVersion: "0.0.44" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "must be a JSON array containing the exact sandbox names",
    );
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("rejects a managed-image confirmation that does not match the listed names (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["beta"]',
      },
      { openshellVersion: "0.0.44" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("must exactly match the listed sandbox names");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it.each([
    ["malformed JSON", "not-json"],
    ["a non-object sandboxes field", '{"sandboxes":[]}'],
    ["a malformed sandbox row", '{"sandboxes":{"alpha":null}}'],
    ["a sandbox row without a name", '{"sandboxes":{"alpha":{}}}'],
    ["a sandbox row with a whitespace-only name", '{"sandboxes":{"   ":{"name":"   "}}}'],
    [
      "a sandbox row whose name differs from its registry key",
      '{"sandboxes":{"alpha":{"name":"beta"}}}',
    ],
  ])("fails closed when the registry contains %s (#6114)", (_case, registryJson) => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_ACCEPT_EXPERIMENTAL_OPENSHELL_UPGRADE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      { registryJson },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Could not inspect the existing sandbox registry",
    );
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("accepts a validated empty sandbox registry without requiring Python (#6114)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      { registryJson: '{"sandboxes":{}}' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("ignores a route-only reservation during pre-upgrade backup (#6500)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_SINGLE_SESSION: "1",
      },
      {
        registryJson:
          '{"sandboxes":{"tm":{"name":"tm","pendingRouteReservation":true,"provider":"nvidia-prod","model":"nemotron"}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=");
    expect(result.stdout).toContain("CONFIRMED_NAMES=");
    expect(result.stdout + result.stderr).not.toContain("managed-image");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("backs up only real sandboxes in a mixed reservation registry (#6500)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha","beta"]',
      },
      {
        hasOldCli: false,
        openshellVersion: "0.0.44",
        registryJson:
          '{"sandboxes":{"tm":{"name":"tm","pendingRouteReservation":true},"alpha":{"name":"alpha"},"beta":{"name":"beta","pendingRouteReservation":true,"createdAt":"2026-07-13T00:00:00.000Z"}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Backing up 2 sandbox(es)");
    expect(result.stdout).toContain('CONFIRMED_NAMES=["alpha","beta"]');
    expect(result.stdout + result.stderr).not.toContain('"tm"');
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(cliLog).toContain("require-all-env=1");
    expect(openshellLog).toContain("gateway remove nemoclaw");
  });

  it("continues after the user manually prepared the old gateway state", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_UPGRADE_PREPARED: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      { hasOldCli: false },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Using manually prepared OpenShell gateway upgrade state");
    expect(result.stdout).toContain("RESTORE=1");
    expect(result.stdout).toContain('CONFIRMED_NAMES=["alpha"]');
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });
});
