// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");

function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function runInstallerOpenshellVersionFlow(
  setupOpenshell: (bin: string) => void,
  installedOpenshellBody = '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell 0.0.85"\nexit 0\n',
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-version-flow-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const setupDir = path.join(tmp, "setup");
  const registry = path.join(home, ".nemoclaw", "sandboxes.json");
  const gatewayState = path.join(tmp, "gateway.state");
  const backupLog = path.join(tmp, "backup.log");
  const installLog = path.join(tmp, "install.log");
  const healthyOpenshell = path.join(tmp, "healthy-openshell");

  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(setupDir, "lib"), { recursive: true });
  fs.writeFileSync(registry, '{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
  fs.writeFileSync(gatewayState, "gateway-original\n");
  writeExecutable(path.join(setupDir, "setup-jetson.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    path.join(setupDir, "lib", "station-vllm-conflict.sh"),
    `#!/usr/bin/env bash
handle_station_vllm_conflict() { :; }
consume_station_local_vllm_resume() { return 1; }
`,
  );
  writeExecutable(healthyOpenshell, installedOpenshellBody);
  setupOpenshell(bin);

  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
SCRIPT_DIR="${setupDir}"
_CLI_PATH=""
_CLI_BIN="nemoclaw-test-missing"
resolve_nemoclaw_gateway_port() { printf '8080\\n'; }
preflight_explicit_express_flags() { :; }
print_banner() { :; }
preflight_usage_notice_prompt() { :; }
prepare_installer_host() { :; }
step() { :; }
install_nodejs() { :; }
ensure_supported_runtime() { :; }
fix_npm_permissions() { :; }
preinstall_backup_and_retire_legacy_gateway() {
  command_exists openshell || return 0
  printf 'backup\\n' >>"${backupLog}"
  [ -n "$(installed_openshell_version 2>/dev/null || true)" ] ||
    error "Could not determine the installed OpenShell version. The installer stopped after backup without retiring the gateway."
  printf 'gateway-retired\\n' >"${gatewayState}"
  printf '{"sandboxes":{}}\\n' >"${registry}"
}
install_nemoclaw() {
  printf 'install\\n' >>"${installLog}"
  if ! command_exists openshell; then
    cp "${healthyOpenshell}" "${bin}/openshell"
  fi
}
verify_nemoclaw() { :; }
print_done() { :; }
main --non-interactive --yes-i-accept-third-party-software`,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
    },
  );

  return {
    result,
    backupLog: fs.existsSync(backupLog) ? fs.readFileSync(backupLog, "utf-8") : "",
    gatewayState: fs.readFileSync(gatewayState, "utf-8"),
    registry: fs.readFileSync(registry, "utf-8"),
    installLog: fs.existsSync(installLog) ? fs.readFileSync(installLog, "utf-8") : "",
    openshellBody: fs.readFileSync(path.join(bin, "openshell"), "utf-8"),
  };
}

function runPreinstallUpgradeGuard(
  env: Record<string, string> = {},
  options: {
    currentBackupSucceeds?: boolean;
    currentCliAvailable?: boolean;
    currentMaxOpenshellVersion?: string;
    currentMinOpenshellVersion?: string;
    finishDeferAsPlain?: boolean;
    finishGatewayPort?: string;
    finishInstallMode?: "managed" | "source" | "unset";
    finishPreparedInstallSucceeds?: boolean;
    gatewayDestroySucceeds?: boolean;
    gatewayProcessStopSucceeds?: boolean;
    gatewayRemoveSucceeds?: boolean;
    gatewayServiceStopSucceeds?: boolean;
    hasOldCli?: boolean;
    openshellOnPath?: boolean;
    openshellVersion?: string;
    openshellVersionCommandFails?: boolean;
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
  const registry = path.join(home, ".nemoclaw", "sandboxes.json");

  fs.mkdirSync(path.join(home, ".nemoclaw"), { recursive: true });
  fs.mkdirSync(path.join(currentSource, "nemoclaw-blueprint"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(currentSource, "nemoclaw-blueprint", "blueprint.yaml"),
    `min_openshell_version: "${options.currentMinOpenshellVersion ?? "0.0.85"}"\nmax_openshell_version: "${options.currentMaxOpenshellVersion ?? "0.0.85"}"\n`,
  );
  fs.writeFileSync(registry, options.registryJson ?? '{"sandboxes":{"alpha":{"name":"alpha"}}}');
  const currentCliAvailable = options.currentCliAvailable === false ? "0" : "1";
  const currentBackupSucceeds = options.currentBackupSucceeds === false ? "0" : "1";
  const openshellVersion = options.openshellVersion ?? "0.0.36";
  const gatewayDestroySucceeds = options.gatewayDestroySucceeds === true ? "1" : "0";
  const gatewayProcessStopSucceeds = options.gatewayProcessStopSucceeds === false ? "0" : "1";
  const gatewayRemoveSucceeds = options.gatewayRemoveSucceeds === false ? "0" : "1";
  const gatewayServiceStopSucceeds = options.gatewayServiceStopSucceeds === true ? "1" : "0";
  const finishDeferAsPlain = options.finishDeferAsPlain === true ? "1" : "0";
  const finishGatewayPort = options.finishGatewayPort ?? "";
  const finishInstallMode = options.finishInstallMode ?? "";
  const finishPreparedInstallSucceeds = options.finishPreparedInstallSucceeds === false ? "0" : "1";
  const openshellVersionCommandFails = options.openshellVersionCommandFails === true ? "1" : "0";
  const installedOpenshellVersionOverride =
    options.openshellVersionCommandFails === true
      ? ""
      : `installed_openshell_version() { printf '${openshellVersion}'; }`;

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
if [ "\${1:-}" = "--version" ] && [ "${openshellVersionCommandFails}" = "1" ]; then
  exit 7
fi
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
    ${installedOpenshellVersionOverride}
    stop_legacy_openshell_gateway_process() {
      printf 'gateway process-stop\n' >> "${openshellLog}"
      [ "${gatewayProcessStopSucceeds}" = "1" ]
    }
    stop_nemoclaw_openshell_gateway_user_service() {
      printf 'gateway service-stop\n' >> "${openshellLog}"
      [ "${gatewayServiceStopSucceeds}" = "1" ]
    }
    resolve_existing_cli_runner() { ${resolveCli}; }
    prepare_current_cli_for_preupgrade_backup() {
      printf 'prepare-current\\n' >> "${cliLog}"
      [ "${currentCliAvailable}" = "1" ] || return 1
      touch "${preparedFlag}"
      _CLI_PATH="${currentCli}"
      return 0
    }
    if [ "${finishDeferAsPlain}" = "1" ] && [[ -n "\${NEMOCLAW_DEFER_OPENSHELL_INSTALL+1}" ]]; then
      export -n NEMOCLAW_DEFER_OPENSHELL_INSTALL
    fi
    preinstall_backup_and_retire_legacy_gateway
    if [ -n "${finishInstallMode}" ]; then
      if [ "${finishInstallMode}" = "unset" ]; then
        unset _NEMOCLAW_CLI_INSTALL_MODE
      else
        _NEMOCLAW_CLI_INSTALL_MODE="${finishInstallMode}"
      fi
      maybe_install_openshell_during_install() {
        printf 'openshell install-mode %s defer=%s\n' "$1" "\${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}" >> "${openshellLog}"
        [ "${finishPreparedInstallSucceeds}" = "1" ]
      }
      refresh_path() { :; }
      ensure_nemoclaw_shim() { :; }
      [ -z "${finishGatewayPort}" ] || NEMOCLAW_GATEWAY_PORT="${finishGatewayPort}"
      finish_nemoclaw_install
    fi
    printf 'DEFER=%s\\n' "\${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}"
    case "$(declare -p NEMOCLAW_DEFER_OPENSHELL_INSTALL 2>/dev/null || true)" in
      "declare -x "*) printf 'DEFER_EXPORTED=1\\n' ;;
      *) printf 'DEFER_EXPORTED=0\\n' ;;
    esac
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
    "NEMOCLAW_DEFER_OPENSHELL_INSTALL",
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
    registry: fs.readFileSync(registry, "utf-8"),
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
      fs.copyFileSync(process.execPath, gatewayBin);
      fs.chmodSync(gatewayBin, 0o755);

      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${runtimeDir}"
"${gatewayBin}" -e 'setTimeout(() => {}, 60000)' &
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

  function runOpenshellVersionGate(openshellBody: string, extraSetup = "") {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-version-gate-"));
    const bin = path.join(tmp, "bin");
    fs.mkdirSync(bin, { recursive: true });
    writeExecutable(path.join(bin, "openshell"), openshellBody);
    return spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
${extraSetup}
require_reportable_openshell_version`,
      ],
      { encoding: "utf-8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
  }

  const brokenOpenshell = "#!/usr/bin/env bash\nexit 1\n";
  const healthyOpenshell =
    '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell 0.0.85"\nexit 0\n';
  const invalidVersionOpenshell =
    '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell unknown"\nexit 0\n';
  const versionPrintingBrokenOpenshell =
    '#!/usr/bin/env bash\n[ "$1" = "--version" ] && echo "openshell 0.0.85"\nexit 1\n';

  it("backs up before rejecting a broken OpenShell without gateway or sandbox mutation (#7300)", () => {
    const { result, backupLog, gatewayState, registry, installLog } =
      runInstallerOpenshellVersionFlow((bin) => {
        writeExecutable(path.join(bin, "openshell"), brokenOpenshell);
      });

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("stopped after backup");
    expect(backupLog).toBe("backup\n");
    expect(gatewayState).toBe("gateway-original\n");
    expect(registry).toBe('{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
    expect(installLog).toBe("");
  });

  it("backs up before rejecting a failed OpenShell version command without mutation (#7300)", () => {
    const { result, backupLog, gatewayState, registry, installLog } =
      runInstallerOpenshellVersionFlow((bin) => {
        writeExecutable(path.join(bin, "openshell"), versionPrintingBrokenOpenshell);
      });

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("stopped after backup");
    expect(backupLog).toBe("backup\n");
    expect(gatewayState).toBe("gateway-original\n");
    expect(registry).toBe('{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
    expect(installLog).toBe("");
  });

  it("backs up before rejecting invalid OpenShell version output without mutation (#7300)", () => {
    const { result, backupLog, gatewayState, registry, installLog } =
      runInstallerOpenshellVersionFlow((bin) => {
        writeExecutable(path.join(bin, "openshell"), invalidVersionOpenshell);
      });

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("stopped after backup");
    expect(backupLog).toBe("backup\n");
    expect(gatewayState).toBe("gateway-original\n");
    expect(registry).toBe('{"sandboxes":{"alpha":{"name":"alpha"}}}\n');
    expect(installLog).toBe("");
  });

  it("preserves a reportable OpenShell through the installer flow (#7300)", () => {
    const { result, openshellBody } = runInstallerOpenshellVersionFlow((bin) => {
      writeExecutable(path.join(bin, "openshell"), healthyOpenshell);
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(openshellBody).toBe(healthyOpenshell);
  });

  it("installs OpenShell when no binary is present (#7300)", () => {
    const { result, installLog } = runInstallerOpenshellVersionFlow(() => undefined);

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(installLog).toBe("install\n");
  });

  it("rejects an installed OpenShell whose version command fails before onboarding (#7300)", () => {
    const { result, installLog, openshellBody } = runInstallerOpenshellVersionFlow(
      () => undefined,
      versionPrintingBrokenOpenshell,
    );

    expect(result.status, result.stdout + result.stderr).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("could not report its version");
    expect(installLog).toBe("install\n");
    expect(openshellBody).toBe(versionPrintingBrokenOpenshell);
  });

  it.skipIf(process.platform !== "linux")(
    "fails closed before onboarding when a present openshell cannot report its version (#7300)",
    () => {
      const result = runOpenshellVersionGate(brokenOpenshell);

      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("could not report its version");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "cannot be bypassed by NEMOCLAW_DEFER_OPENSHELL_INSTALL (#7300)",
    () => {
      const result = runOpenshellVersionGate(
        brokenOpenshell,
        "export NEMOCLAW_DEFER_OPENSHELL_INSTALL=1",
      );

      expect(result.status, result.stdout + result.stderr).not.toBe(0);
      expect(result.stderr + result.stdout).toContain("could not report its version");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "passes when the present openshell reports a version (#7300)",
    () => {
      const result = runOpenshellVersionGate(healthyOpenshell);

      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stderr + result.stdout).not.toContain("could not report its version");
    },
  );

  it("does not stage the gateway service after a forced OpenShell install fails (#8800)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openshell-install-failure-"));
    const sideEffectLog = path.join(tmp, "side-effects.log");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
NEMOCLAW_SOURCE_ROOT="${tmp}"
spin() { return 7; }
prefer_user_local_openshell() { printf 'preferred\\n' >>"${sideEffectLog}"; }
install_nemoclaw_openshell_gateway_user_service() { printf 'service-staged\\n' >>"${sideEffectLog}"; }
maybe_install_openshell_during_install force`,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, NEMOCLAW_DEFER_OPENSHELL_INSTALL: "" },
      },
    );

    expect(result.status).not.toBe(0);
    expect(fs.existsSync(sideEffectLog)).toBe(false);
  });

  it.each([
    {
      expectedExported: "0",
      expectedSet: "",
      expectedValue: "",
      initialState: "unset",
      setup: "unset NEMOCLAW_DEFER_OPENSHELL_INSTALL",
    },
    {
      expectedExported: "0",
      expectedSet: "1",
      expectedValue: "plain",
      initialState: "plain",
      setup: "NEMOCLAW_DEFER_OPENSHELL_INSTALL=plain",
    },
    {
      expectedExported: "1",
      expectedSet: "1",
      expectedValue: "exported",
      initialState: "exported",
      setup: "export NEMOCLAW_DEFER_OPENSHELL_INSTALL=exported",
    },
  ])("restores an $initialState deferral variable after CLI backup preparation (#8800)", ({
    expectedExported,
    expectedSet,
    expectedValue,
    setup,
  }) => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
info() { :; }
install_nemoclaw() { [ "\${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}" = "1" ]; }
verify_nemoclaw() { :; }
_CLI_DISPLAY=NemoClaw
${setup}
prepare_current_cli_for_preupgrade_backup
printf 'DEFER_SET=%s\\n' "\${NEMOCLAW_DEFER_OPENSHELL_INSTALL+1}"
printf 'DEFER_VALUE=%s\\n' "\${NEMOCLAW_DEFER_OPENSHELL_INSTALL:-}"
case "$(declare -p NEMOCLAW_DEFER_OPENSHELL_INSTALL 2>/dev/null || true)" in
  "declare -x "*) printf 'DEFER_EXPORTED=1\\n' ;;
  *) printf 'DEFER_EXPORTED=0\\n' ;;
esac`,
      ],
      { encoding: "utf-8", env: process.env },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`DEFER_SET=${expectedSet}\n`);
    expect(result.stdout).toContain(`DEFER_VALUE=${expectedValue}\n`);
    expect(result.stdout).toContain(`DEFER_EXPORTED=${expectedExported}\n`);
  });

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

  it("backs up before rejecting a broken user-local OpenShell without retiring the gateway (#7300)", () => {
    const registryJson =
      '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}';
    const { result, cliLog, openshellLog, registry } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        hasOldCli: false,
        openshellOnPath: false,
        openshellVersionCommandFails: true,
        registryJson,
        userLocalOpenshell: true,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("stopped after backup");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog.split(/\r?\n/)).toContain("--version");
    expect(openshellLog).not.toContain("gateway");
    expect(registry).toBe(registryJson);
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
        finishInstallMode: "source",
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toBe("openshell install-mode if-missing defer=\n");
  });

  it("forces OpenShell installation for a managed CLI install mode (#8800)", () => {
    const { result, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        finishInstallMode: "managed",
        registryJson: '{"sandboxes":{}}',
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(openshellLog).toBe("openshell install-mode force defer=\n");
  });

  it("rejects a prepared CLI that has no install mode (#8800)", () => {
    const { result, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        finishInstallMode: "unset",
        registryJson: '{"sandboxes":{}}',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("has no installation mode");
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

  it("retires an OpenShell 0.0.85 user-service gateway without a PID file before installing 0.0.101 (#8800)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NEMOCLAW_DEFER_OPENSHELL_INSTALL: "1", NON_INTERACTIVE: "1" },
      {
        currentMaxOpenshellVersion: "0.0.101",
        currentMinOpenshellVersion: "0.0.101",
        finishInstallMode: "source",
        gatewayDestroySucceeds: false,
        gatewayProcessStopSucceeds: false,
        gatewayServiceStopSucceeds: true,
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.105","fromDockerfile":false}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog.split(/\r?\n/)).toEqual(
      expect.arrayContaining([
        "gateway destroy -g nemoclaw",
        "gateway destroy",
        "gateway service-stop",
        "gateway remove nemoclaw",
        "openshell install-mode force defer=",
      ]),
    );
    expect(openshellLog.indexOf("gateway remove nemoclaw")).toBeLessThan(
      openshellLog.indexOf("openshell install-mode force defer="),
    );
    expect(result.stdout).toContain("DEFER=1");
    expect(result.stdout).toContain("DEFER_EXPORTED=1");
    expect(openshellLog).not.toContain("gateway process-stop");
  });

  it("restores a plain OpenShell installation deferral as a plain variable (#8800)", () => {
    const { result, openshellLog } = runPreinstallUpgradeGuard(
      {
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
        NEMOCLAW_DEFER_OPENSHELL_INSTALL: "1",
        NEMOCLAW_OPENSHELL_UPGRADE_PREPARED: "1",
        NON_INTERACTIVE: "1",
      },
      {
        finishDeferAsPlain: true,
        finishInstallMode: "source",
        hasOldCli: false,
        openshellVersion: "0.0.85",
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("DEFER=1");
    expect(result.stdout).toContain("DEFER_EXPORTED=0");
    expect(openshellLog).toBe("openshell install-mode force defer=\n");
  });

  it.each([
    {
      expectedRetry: "NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1",
      finishGatewayPort: undefined,
      forbiddenRetry: "NEMOCLAW_GATEWAY_PORT=",
      name: "the default gateway port",
    },
    {
      expectedRetry: "NEMOCLAW_GATEWAY_PORT=9123 NEMOCLAW_OPENSHELL_UPGRADE_PREPARED=1",
      finishGatewayPort: "9123",
      forbiddenRetry: "NEMOCLAW_GATEWAY_PORT=8080",
      name: "a selected non-default gateway port",
    },
  ])("preserves prepared backups and $name when OpenShell installation fails (#8800)", (testCase) => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        currentMaxOpenshellVersion: "0.0.101",
        currentMinOpenshellVersion: "0.0.101",
        finishPreparedInstallSucceeds: false,
        finishGatewayPort: testCase.finishGatewayPort,
        finishInstallMode: "source",
        gatewayDestroySucceeds: false,
        gatewayProcessStopSucceeds: false,
        gatewayServiceStopSucceeds: true,
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.105","fromDockerfile":false}}}',
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("preserved the sandbox backups");
    expect(result.stdout + result.stderr).toContain("did not start recovery");
    expect(result.stdout + result.stderr).toContain(testCase.expectedRetry);
    expect(result.stdout + result.stderr).not.toContain(testCase.forbiddenRetry);
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toContain("openshell install-mode force defer=");
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
    const registryJson =
      '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.85","fromDockerfile":false}}}';
    const { result, cliLog, openshellLog, registry } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        hasOldCli: false,
        openshellVersion: "",
        registryJson,
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "Could not determine the installed OpenShell version",
    );
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toBe("");
    expect(registry).toBe(registryJson);
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

  it("preserves the backup when neither a trusted service nor a PID can retire the gateway (#8800)", () => {
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
        "gateway service-stop",
        "gateway process-stop",
      ]),
    );
    expect(openshellLog).not.toContain("gateway remove nemoclaw");
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

  it("stops before upgrade mutations when a legacy sandbox name exceeds the OpenShell 0.0.99 limit (#8497)", () => {
    const incompatibleName = "abcdefghijklmnopqrst";
    const registryJson = JSON.stringify({
      sandboxes: {
        [incompatibleName]: {
          name: incompatibleName,
          nemoclawVersion: "0.0.89",
          fromDockerfile: false,
        },
      },
    });
    const { result, cliLog, openshellLog, registry } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        currentMaxOpenshellVersion: "0.0.99",
        currentMinOpenshellVersion: "0.0.99",
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson,
      },
    );

    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(JSON.stringify(incompatibleName));
    expect(output).toContain("1-19");
    expect(output).toContain("stopped before preparing the current CLI");
    expect(output).toContain("replacement sandbox with a compatible name");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
    expect(registry).toBe(registryJson);
  });

  it("continues the OpenShell 0.0.99 upgrade when an existing sandbox name is exactly 19 characters (#8497)", () => {
    const compatibleName = "abcdefghij123456789";
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        currentMaxOpenshellVersion: "0.0.99",
        currentMinOpenshellVersion: "0.0.99",
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson: JSON.stringify({
          sandboxes: {
            [compatibleName]: {
              name: compatibleName,
              nemoclawVersion: "0.0.89",
              fromDockerfile: false,
            },
          },
        }),
      },
    );

    expect(result.status).toBe(0);
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toContain("gateway remove nemoclaw");
  });

  it("escapes an incompatible legacy sandbox name before printing the OpenShell upgrade diagnostic (#8497)", () => {
    const incompatibleName = "bad\u202e::error::forged";
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        currentMaxOpenshellVersion: "0.0.99",
        currentMinOpenshellVersion: "0.0.99",
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson: JSON.stringify({
          sandboxes: {
            [incompatibleName]: {
              name: incompatibleName,
              nemoclawVersion: "0.0.89",
              fromDockerfile: false,
            },
          },
        }),
      },
    );

    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain('"bad\\u202e::error::forged"');
    expect(output).not.toContain(incompatibleName);
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("stops before upgrade mutations when a legacy sandbox name contains OpenShell's reserved double hyphen (#8497)", () => {
    const incompatibleName = "legacy--box";
    const registryJson = JSON.stringify({
      sandboxes: {
        [incompatibleName]: {
          name: incompatibleName,
          nemoclawVersion: "0.0.89",
          fromDockerfile: false,
        },
      },
    });
    const { result, cliLog, openshellLog, registry } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        currentMaxOpenshellVersion: "0.0.99",
        currentMinOpenshellVersion: "0.0.99",
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson,
      },
    );

    const output = result.stdout + result.stderr;
    expect(result.status).not.toBe(0);
    expect(output).toContain(JSON.stringify(incompatibleName));
    expect(output).toContain("rejects consecutive");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
    expect(registry).toBe(registryJson);
  });

  it("ignores an incompatible route-only reservation during the OpenShell name preflight (#8497)", () => {
    const routeOnlyName = "route-only-reservation-name";
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      { NON_INTERACTIVE: "1" },
      {
        currentMaxOpenshellVersion: "0.0.99",
        currentMinOpenshellVersion: "0.0.99",
        openshellVersion: "0.0.85",
        registryJson: JSON.stringify({
          sandboxes: {
            [routeOnlyName]: {
              name: routeOnlyName,
              pendingRouteReservation: true,
            },
          },
        }),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RESTORE=");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("");
  });

  it("ignores an incompatible legacy name owned by a different gateway during the OpenShell preflight (#8497)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NEMOCLAW_GATEWAY_PORT: "9123",
        NON_INTERACTIVE: "1",
      },
      {
        currentMaxOpenshellVersion: "0.0.99",
        currentMinOpenshellVersion: "0.0.99",
        hasOldCli: false,
        openshellVersion: "0.0.85",
        registryJson: JSON.stringify({
          sandboxes: {
            selected: {
              name: "selected",
              gatewayPort: 9123,
              gatewayName: "nemoclaw-9123",
              nemoclawVersion: "0.0.89",
              fromDockerfile: false,
            },
            "incompatible-sibling-name": {
              name: "incompatible-sibling-name",
              gatewayPort: 9124,
              gatewayName: "nemoclaw-9124",
              nemoclawVersion: "0.0.89",
              fromDockerfile: false,
            },
          },
        }),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain("incompatible-sibling-name");
    expect(cliLog.split(/\r?\n/)).toContain("current:backup-all");
    expect(openshellLog).toContain("gateway remove nemoclaw-9123");
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

  it("forces OpenShell installation from a manually prepared gateway upgrade state (#8800)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_UPGRADE_PREPARED: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      {
        currentMaxOpenshellVersion: "0.0.101",
        currentMinOpenshellVersion: "0.0.101",
        finishInstallMode: "source",
        hasOldCli: false,
        openshellVersion: "0.0.85",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Using manually prepared OpenShell gateway upgrade state");
    expect(result.stdout).toContain("RESTORE=1");
    expect(result.stdout).toContain('CONFIRMED_NAMES=["alpha"]');
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("openshell install-mode force defer=\n");
  });

  it("reuses prepared backups when a failed install left no OpenShell executable (#8800)", () => {
    const { result, cliLog, openshellLog } = runPreinstallUpgradeGuard(
      {
        NON_INTERACTIVE: "1",
        NEMOCLAW_OPENSHELL_UPGRADE_PREPARED: "1",
        NEMOCLAW_CONFIRM_LEGACY_MANAGED_RECREATE: '["alpha"]',
      },
      {
        finishInstallMode: "source",
        hasOldCli: false,
        openshellOnPath: false,
        registryJson:
          '{"sandboxes":{"alpha":{"name":"alpha","nemoclawVersion":"0.0.105","fromDockerfile":false}}}',
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Using manually prepared OpenShell gateway upgrade state");
    expect(result.stdout).toContain("RESTORE=1");
    expect(cliLog).toBe("");
    expect(openshellLog).toBe("openshell install-mode force defer=\n");
  });
});
