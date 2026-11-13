// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile, type ExecFileOptionsWithStringEncoding } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "../..", "scripts", "install.sh");
const execFileAsync = promisify(execFile);

export async function runCommand(
  command: string,
  args: string[],
  options: ExecFileOptionsWithStringEncoding,
) {
  try {
    const { stderr, stdout } = await execFileAsync(command, args, options);
    return { status: 0, stderr, stdout };
  } catch (error) {
    const result = error as { code?: unknown; stderr?: string; stdout?: string };
    return {
      status: typeof result.code === "number" ? result.code : null,
      stderr: result.stderr ?? "",
      stdout: result.stdout ?? "",
    };
  }
}

export function writeExecutable(target: string, contents: string): void {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

export async function runPreinstallUpgradeGuard(
  env: Record<string, string> = {},
  options: {
    activeDirectoryUnsafe?: boolean;
    privateDirectoryUnsafe?: boolean;
    replacementPreparationUnsupported?: boolean;
    currentBackupSucceeds?: boolean;
    currentCliAvailable?: boolean;
    currentForwardRetirementSucceeds?: boolean;
    currentMaxOpenshellVersion?: string;
    currentMinOpenshellVersion?: string;
    finishDeferAsPlain?: boolean;
    finishGatewayPort?: string;
    finishGatewayServiceRestartSucceeds?: boolean;
    finishInstallMode?: "managed" | "source" | "unset";
    finishLinuxSystemdUserManager?: boolean;
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
  const tmp = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "nemoclaw-openshell-upgrade-prompt-"),
  );
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
  fs.mkdirSync(path.join(currentSource, "scripts"), { recursive: true });
  fs.copyFileSync(
    path.join(path.dirname(INSTALLER_PAYLOAD), "install-openshell.sh"),
    path.join(currentSource, "scripts", "install-openshell.sh"),
  );
  if (options.replacementPreparationUnsupported) {
    writeExecutable(
      path.join(currentSource, "scripts", "install-openshell.sh"),
      `#!/usr/bin/env bash\nprintf 'replacement-executed\\n' >> "${openshellLog}"\n`,
    );
  }
  if (options.activeDirectoryUnsafe) fs.chmodSync(bin, 0o775);
  if (options.privateDirectoryUnsafe) {
    fs.mkdirSync(path.join(home, ".local"), { recursive: true });
    fs.chmodSync(path.join(home, ".local"), 0o775);
  }

  fs.writeFileSync(
    path.join(currentSource, "nemoclaw-blueprint", "blueprint.yaml"),
    `min_openshell_version: "${options.currentMinOpenshellVersion ?? "0.0.85"}"\nmax_openshell_version: "${options.currentMaxOpenshellVersion ?? "0.0.85"}"\n`,
  );
  fs.writeFileSync(registry, options.registryJson ?? '{"sandboxes":{"alpha":{"name":"alpha"}}}');
  const currentCliAvailable = options.currentCliAvailable === false ? "0" : "1";
  const currentBackupSucceeds = options.currentBackupSucceeds === false ? "0" : "1";
  const currentForwardRetirementSucceeds =
    options.currentForwardRetirementSucceeds === false ? "0" : "1";
  const openshellVersion = options.openshellVersion ?? "0.0.36";
  const gatewayDestroySucceeds = options.gatewayDestroySucceeds === true ? "1" : "0";
  const gatewayProcessStopSucceeds = options.gatewayProcessStopSucceeds === false ? "0" : "1";
  const gatewayRemoveSucceeds = options.gatewayRemoveSucceeds === false ? "0" : "1";
  const gatewayServiceStopSucceeds = options.gatewayServiceStopSucceeds === true ? "1" : "0";
  const finishDeferAsPlain = options.finishDeferAsPlain === true ? "1" : "0";
  const finishGatewayPort = options.finishGatewayPort ?? "";
  const finishGatewayServiceRestartSucceeds =
    options.finishGatewayServiceRestartSucceeds === false ? "0" : "1";
  const finishInstallMode = options.finishInstallMode ?? "";
  const finishLinuxSystemdUserManager = options.finishLinuxSystemdUserManager === true ? "1" : "0";
  const finishPreparedInstallSucceeds = options.finishPreparedInstallSucceeds === false ? "0" : "1";
  const openshellVersionCommandFails = options.openshellVersionCommandFails === true ? "1" : "0";
  const installedOpenshellVersionOverride =
    options.openshellVersionCommandFails === true
      ? ""
      : `installed_openshell_version() { printf '${openshellVersion}'; }`;

  writeExecutable(path.join(bin, "uname"), '#!/usr/bin/env bash\nprintf "Linux\\n"\n');
  writeExecutable(path.join(bin, "npm"), "#!/usr/bin/env bash\nexit 99\n");
  writeExecutable(
    oldCli,
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then printf 'nemoclaw v0.0.99\\n'; exit 0; fi
printf 'old:%s\\n' "$*" >> "${cliLog}"
if [ "\${1:-}" = "--help" ]; then printf 'nemoclaw backup-all\\n'; fi
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
if [ "\${1:-} \${2:-}" = "backup-all --retire-legacy-forwards" ] && [ "${currentForwardRetirementSucceeds}" != "1" ]; then
  exit 5
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
      command_exists() {
        [ "$1" != "systemctl" ] && command -v "$1" >/dev/null 2>&1 && return 0
        [ "$1" = "systemctl" ] && [ "${finishLinuxSystemdUserManager}" = "1" ]
      }
      if [ "${finishLinuxSystemdUserManager}" = "1" ]; then
        uname() { printf 'Linux\n'; }
        systemctl() { [ "$*" = "--user show-environment" ]; }
        restart_selected_openshell_gateway_user_service() {
          printf 'gateway service-restart %s\n' "$1" >> "${openshellLog}"
          [ "${finishGatewayServiceRestartSucceeds}" = "1" ]
        }
      fi
      refresh_path() { :; }
      ensure_nemoclaw_shim() { :; }
      [ -z "${finishGatewayPort}" ] || NEMOCLAW_GATEWAY_PORT="${finishGatewayPort}"
      finish_nemoclaw_install
    fi
    printf 'PREPARED_OPENSHELL_DIR=%s\\n' "\${_NEMOCLAW_PREPARED_OPENSHELL_INSTALL_DIR:-}"
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
  const result = await runCommand("bash", ["-c", snippet], {
    encoding: "utf-8",
    env: childEnv,
  });

  return {
    result,
    cliLog: fs.existsSync(cliLog) ? fs.readFileSync(cliLog, "utf-8") : "",
    openshellLog: fs.existsSync(openshellLog) ? fs.readFileSync(openshellLog, "utf-8") : "",
    registry: fs.readFileSync(registry, "utf-8"),
    activeDirectory: bin,
    privateDirectory: path.join(home, ".local", "bin"),
  };
}
