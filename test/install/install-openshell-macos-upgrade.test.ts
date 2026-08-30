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

function runDarwinGatewayProcessStop(
  options: {
    lsofDiagnostic?: string;
    psDiagnostic?: string;
    reusePidBeforeKill?: boolean;
    trustedExecutable?: boolean;
    trustedIdentity?: boolean;
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-darwin-gateway-stop-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const runtimeDir = path.join(tmp, "runtime");
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const foreignGatewayBin = path.join(tmp, "foreign-gateway");
  const pidReused = path.join(tmp, "pid-reused");
  const signalLog = path.join(tmp, "signal.log");
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexec sleep 60\n");
  writeExecutable(foreignGatewayBin, "#!/usr/bin/env bash\nexec sleep 60\n");
  writeExecutable(path.join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
  writeExecutable(
    path.join(bin, "ps"),
    `#!/usr/bin/env bash
managed_pid="$(cat '${runtimeDir}/openshell-gateway.pid')" || exit 1
[ "\${2:-}" = "$managed_pid" ] || exit 1
case "\${4:-}" in
  args=)
    printf '%s\n' '${
      options.trustedIdentity === false
        ? "python"
        : "openshell-gateway[nemoclaw=nemoclaw-20369;port=20369]"
    }'
    [ -z '${options.psDiagnostic ?? ""}' ] || {
      printf '%s\n' '${options.psDiagnostic ?? ""}' >&2
      exit 2
    }
    ;;
  lstart=)
    if [ -f '${pidReused}' ]; then
      printf '%s\n' 'Fri Aug 28 13:00:01 2026'
    else
      printf '%s\n' 'Fri Aug 28 13:00:00 2026'
    fi
    ;;
  *) exit 2 ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "lsof"),
    `#!/usr/bin/env bash
managed_pid="$(cat '${runtimeDir}/openshell-gateway.pid')" || exit 1
[ "\${3:-}" = "$managed_pid" ] || exit 1
printf 'p%s\nn%s\n' "$managed_pid" '${options.trustedExecutable === false ? foreignGatewayBin : gatewayBin}'
[ -z '${options.lsofDiagnostic ?? ""}' ] || {
  printf '%s\n' '${options.lsofDiagnostic ?? ""}' >&2
  exit 2
}
`,
  );

  const rejectsProcess =
    options.trustedIdentity === false ||
    options.trustedExecutable === false ||
    options.psDiagnostic !== undefined ||
    options.lsofDiagnostic !== undefined;
  const pidReuseScript = `trap 'command kill "$gateway_pid" 2>/dev/null || true' EXIT
source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
HOME="${home}"
NEMOCLAW_GATEWAY_PORT=20369
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${runtimeDir}"
"${gatewayBin}" 60 &
gateway_pid=$!
sleep 0.1
printf '%s\n' "$gateway_pid" >"${runtimeDir}/openshell-gateway.pid"
kill() {
  case "\${1:-}" in
    -0) return 0 ;;
    -KILL) printf 'KILL\n' >>'${signalLog}'; return 0 ;;
    *) printf 'TERM\n' >>'${signalLog}'; touch '${pidReused}'; return 0 ;;
  esac
}
sleep() { :; }
if (stop_legacy_openshell_gateway_process); then exit 9; fi
grep -Fx 'TERM' '${signalLog}' >/dev/null
if grep -Fx 'KILL' '${signalLog}' >/dev/null; then exit 8; fi
test -e "${runtimeDir}/openshell-gateway.pid"
command kill "$gateway_pid"
wait "$gateway_pid" 2>/dev/null || true
trap - EXIT`;
  const rejectedProcessScript = `trap 'kill "$gateway_pid" 2>/dev/null || true' EXIT
source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
HOME="${home}"
NEMOCLAW_GATEWAY_PORT=20369
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${runtimeDir}"
"${gatewayBin}" 60 &
gateway_pid=$!
sleep 0.1
printf '%s\n' "$gateway_pid" >"${runtimeDir}/openshell-gateway.pid"
if (stop_legacy_openshell_gateway_process); then exit 9; fi
kill -0 "$gateway_pid"
test -e "${runtimeDir}/openshell-gateway.pid"
kill "$gateway_pid"
wait "$gateway_pid" 2>/dev/null || true
trap - EXIT`;
  const successfulStopScript = `trap 'kill "$gateway_pid" 2>/dev/null || true' EXIT
source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
HOME="${home}"
NEMOCLAW_GATEWAY_PORT=20369
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${runtimeDir}"
"${gatewayBin}" 60 &
gateway_pid=$!
sleep 0.1
kill -0 "$gateway_pid"
printf '%s\n' "$gateway_pid" >"${runtimeDir}/openshell-gateway.pid"
stop_legacy_openshell_gateway_process
wait "$gateway_pid" 2>/dev/null || true
if kill -0 "$gateway_pid" 2>/dev/null; then exit 9; fi
test ! -e "${runtimeDir}/openshell-gateway.pid"`;
  const script = options.reusePidBeforeKill
    ? pidReuseScript
    : rejectsProcess
      ? rejectedProcessScript
      : successfulStopScript;

  return spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: home,
      XDG_BIN_HOME: "",
      PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    },
  });
}

function runDarwinGatewayPidFile(
  contents: string,
  options: { lsofDiagnostic?: string; listenerPid?: string; symlink?: boolean } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-darwin-gateway-pid-file-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const runtimeDir = path.join(tmp, "runtime");
  const pidFile = path.join(runtimeDir, "openshell-gateway.pid");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  writeExecutable(path.join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
  writeExecutable(
    path.join(bin, "lsof"),
    `#!/usr/bin/env bash
if [ "\${1:-}" = "-nP" ] && [ "\${2:-}" = "-iTCP:8080" ] && [ "\${3:-}" = "-sTCP:LISTEN" ] && [ "\${4:-}" = "-t" ]; then
  [ -z '${options.lsofDiagnostic ?? ""}' ] || {
    printf '%s\\n' '${options.lsofDiagnostic ?? ""}' >&2
    exit 1
  }
  [ -z '${options.listenerPid ?? ""}' ] || {
    printf '%s\\n' '${options.listenerPid ?? ""}'
    exit 0
  }
  exit 1
fi
exit 2
`,
  );
  const writePidFile = options.symlink
    ? () => {
        const target = path.join(tmp, "pid-target");
        fs.writeFileSync(target, contents);
        fs.symlinkSync(target, pidFile);
      }
    : () => fs.writeFileSync(pidFile, contents);
  writePidFile();

  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
HOME="${home}"
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${runtimeDir}"
stop_legacy_openshell_gateway_process`,
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
  return { result, pidFile };
}

function runVerifiedHomebrewInstallSelection(
  options: { brewPrefixFailure?: boolean; missingGateway?: boolean } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-homebrew-install-selection-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const brewPrefix = path.join(tmp, "homebrew");
  const openshellBin = path.join(brewPrefix, "bin", "openshell");
  const gatewayBin = path.join(brewPrefix, "bin", "openshell-gateway");
  const staleOpenshellBin = path.join(home, ".local", "bin", "openshell");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.dirname(openshellBin), { recursive: true });
  fs.mkdirSync(path.dirname(staleOpenshellBin), { recursive: true });
  writeExecutable(openshellBin, "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    options.missingGateway ? `${gatewayBin}.missing` : gatewayBin,
    "#!/usr/bin/env bash\nexit 0\n",
  );
  writeExecutable(staleOpenshellBin, "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(path.join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
  writeExecutable(
    path.join(bin, "brew"),
    options.brewPrefixFailure
      ? `#!/usr/bin/env bash
[ "\${1:-}" = "--prefix" ] && printf '%s\n' '${brewPrefix}'
exit 2
`
      : `#!/usr/bin/env bash
[ "\${1:-}" = "--prefix" ] && printf '%s\n' '${brewPrefix}'
`,
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
spin() { [ "\${_NEMOCLAW_OPENSHELL_INSTALL_METHOD:-}" = "homebrew" ]; }
install_nemoclaw_openshell_gateway_user_service() { return 0; }
maybe_install_openshell_during_install force
printf 'openshell=%s\ngateway=%s\npath=%s\n' "$NEMOCLAW_OPENSHELL_BIN" "$NEMOCLAW_OPENSHELL_GATEWAY_BIN" "$(command -v openshell)"`,
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
  return { gatewayBin, openshellBin, result, staleOpenshellBin };
}

function runVerifiedStandaloneInstallSelection(
  options: { ambiguousMethod?: boolean; missingGateway?: boolean } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-standalone-install-selection-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const localBin = path.join(home, ".local", "bin");
  const openshellBin = path.join(localBin, "openshell");
  const gatewayBin = path.join(localBin, "openshell-gateway");
  const brewBin = path.join(bin, "brew");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(localBin, { recursive: true });
  writeExecutable(openshellBin, "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(
    options.missingGateway ? `${gatewayBin}.missing` : gatewayBin,
    "#!/usr/bin/env bash\nexit 0\n",
  );
  writeExecutable(path.join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");

  const changeInstallMethod = options.ambiguousMethod
    ? `printf '#!/usr/bin/env bash\\nexit 0\\n' >'${brewBin}'
chmod +x '${brewBin}'`
    : ":";
  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
spin() {
  [ "\${_NEMOCLAW_OPENSHELL_INSTALL_METHOD:-}" = "standalone" ] || return 1
  ${changeInstallMethod}
}
install_nemoclaw_openshell_gateway_user_service() { return 0; }
maybe_install_openshell_during_install force
printf 'openshell=%s\ngateway=%s\npath=%s\n' "$NEMOCLAW_OPENSHELL_BIN" "$NEMOCLAW_OPENSHELL_GATEWAY_BIN" "$(command -v openshell)"`,
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
  return { gatewayBin, openshellBin, result };
}

function runDarwinGatewayServiceStop(
  options: {
    trustedActiveProgram?: boolean;
    trustedLabel?: boolean;
    trustedProgram?: boolean;
  } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-darwin-gateway-service-stop-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const brewPrefix = path.join(tmp, "homebrew");
  const serviceLabel = "homebrew.mxcl.openshell";
  const servicePath = path.join(home, "Library", "LaunchAgents", `${serviceLabel}.plist`);
  const serviceProgram = path.join(
    brewPrefix,
    "opt",
    "openshell",
    "libexec",
    "openshell-gateway-homebrew-service",
  );
  const active = path.join(tmp, "active");
  const launchctlLog = path.join(tmp, "launchctl.log");
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  fs.mkdirSync(path.dirname(serviceProgram), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(servicePath, "test plist\n");
  fs.writeFileSync(active, "active\n");
  writeExecutable(serviceProgram, "#!/usr/bin/env bash\nexit 0\n");
  writeExecutable(path.join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
  writeExecutable(
    path.join(bin, "brew"),
    `#!/usr/bin/env bash
[ "\${1:-}" = "--prefix" ] && printf '%s\n' '${brewPrefix}'
`,
  );
  writeExecutable(
    path.join(bin, "plutil"),
    `#!/usr/bin/env bash
case "\${2:-}" in
  Label) printf '%s\n' '${options.trustedLabel === false ? "other.service" : serviceLabel}' ;;
  ProgramArguments.0) printf '%s\n' '${
    options.trustedProgram === false ? path.join(tmp, "foreign-gateway") : serviceProgram
  }' ;;
esac
`,
  );
  writeExecutable(
    path.join(bin, "launchctl"),
    `#!/usr/bin/env bash
printf '%s\n' "$*" >>'${launchctlLog}'
case "\${1:-}" in
  print)
    [ -f '${active}' ] || exit 1
    printf 'program = %s\\n' '${
      options.trustedActiveProgram === false
        ? path.join(tmp, "active-foreign-gateway")
        : serviceProgram
    }'
    ;;
  bootout) rm -f '${active}' ;;
esac
`,
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
HOME="${home}"
NEMOCLAW_GATEWAY_PORT=8080
stop_macos_openshell_gateway_user_service`,
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
    launchctlLog: fs.existsSync(launchctlLog) ? fs.readFileSync(launchctlLog, "utf-8") : "",
  };
}

function runDarwinRetirementFallback() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-darwin-retirement-fallback-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const stateDir = path.join(tmp, "state");
  const runtimeDir = path.join(tmp, "runtime");
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const openshellLog = path.join(tmp, "openshell.log");
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "sandboxes.json"), "{}\n");
  writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexec sleep 60\n");
  writeExecutable(path.join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
  writeExecutable(
    path.join(bin, "openshell"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>'${openshellLog}'
[ "\${1:-}" = "gateway" ] && [ "\${2:-}" = "remove" ]
`,
  );
  writeExecutable(
    path.join(bin, "ps"),
    `#!/usr/bin/env bash
managed_pid="$(cat '${runtimeDir}/openshell-gateway.pid')" || exit 1
[ "\${2:-}" = "$managed_pid" ] || exit 1
printf '%s\\n' 'openshell-gateway[nemoclaw=nemoclaw-20369;port=20369]'
`,
  );
  writeExecutable(
    path.join(bin, "lsof"),
    `#!/usr/bin/env bash
managed_pid="$(cat '${runtimeDir}/openshell-gateway.pid')" || exit 1
[ "\${3:-}" = "$managed_pid" ] || exit 1
printf 'p%s\\nn%s\\n' "$managed_pid" '${gatewayBin}'
`,
  );

  const result = spawnSync(
    "bash",
    [
      "-c",
      `trap 'kill "$gateway_pid" 2>/dev/null || true' EXIT
source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
nemoclaw_state_dir() { printf '%s\\n' '${stateDir}'; }
nemoclaw_gateway_name() { printf '%s\\n' 'nemoclaw-20369'; }
registered_sandbox_count() { printf '1\\n'; }
require_openshell_compatible_sandbox_names() { :; }
confirm_legacy_managed_image_recovery() { :; }
run_preupgrade_backup() { :; }
installed_openshell_version() { printf '0.0.85\\n'; }
legacy_openshell_gateway_upgrade_needed() { return 1; }
resolve_current_openshell_version_range() { printf '0.0.106 0.0.106\\n'; }
version_gte() { return 1; }
stop_nemoclaw_openshell_gateway_user_service() { return 1; }
HOME="${home}"
NEMOCLAW_GATEWAY_PORT=20369
NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR="${runtimeDir}"
"${gatewayBin}" 60 &
gateway_pid=$!
sleep 0.1
printf '%s\\n' "$gateway_pid" >"${runtimeDir}/openshell-gateway.pid"
preinstall_backup_and_retire_legacy_gateway
wait "$gateway_pid" 2>/dev/null || true
if kill -0 "$gateway_pid" 2>/dev/null; then exit 9; fi
test ! -e "${runtimeDir}/openshell-gateway.pid"
test "$_OPENSHELL_INSTALL_REQUIRED_BEFORE_RECOVERY" = true
test "$NEMOCLAW_RESTORE_LATEST_BACKUP_ON_RECREATE" = 1
grep -F 'gateway destroy -g nemoclaw-20369' '${openshellLog}' >/dev/null
grep -F 'gateway remove nemoclaw-20369' '${openshellLog}' >/dev/null`,
    ],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: home,
        XDG_BIN_HOME: "",
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
    },
  );
  return { result, openshellLog };
}

describe("install.sh macOS OpenShell upgrade recovery", () => {
  it("retires the trusted PID-file gateway through the complete fallback chain (#10369)", () => {
    const { result, openshellLog } = runDarwinRetirementFallback();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.readFileSync(openshellLog, "utf-8")).toContain("gateway remove nemoclaw-20369");
  });

  it("stops only the gateway process with matching owned state and process identity (#10369)", () => {
    const result = runDarwinGatewayProcessStop();

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("rejects a PID when the process identity does not match (#10369)", () => {
    const result = runDarwinGatewayProcessStop({ trustedIdentity: false });

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("rejects a PID when lsof reports a foreign executable (#10369)", () => {
    const result = runDarwinGatewayProcessStop({ trustedExecutable: false });

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("rejects partial process identity when ps reports an observation error (#10369)", () => {
    const result = runDarwinGatewayProcessStop({ psDiagnostic: "permission denied" });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain("permission denied");
  });

  it("rejects partial executable identity when lsof reports an observation error (#10369)", () => {
    const result = runDarwinGatewayProcessStop({ lsofDiagnostic: "permission denied" });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).not.toContain("permission denied");
  });

  it("does not send SIGKILL after the recorded macOS PID is reused (#10369)", () => {
    const result = runDarwinGatewayProcessStop({ reusePidBeforeKill: true });

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("recorded macOS process changed or could not be verified");
    expect(result.stderr).toContain(
      "PID file, OpenShell registration, and sandbox backups were preserved",
    );
  });

  it("clears a stale owned macOS gateway PID file only when the port has no listener (#10369)", () => {
    const { result, pidFile } = runDarwinGatewayPidFile("999999999\n");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("preserves registration recovery when a stale PID file has an active listener (#10369)", () => {
    const { result, pidFile } = runDarwinGatewayPidFile("999999999\n", {
      listenerPid: "4242",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway port 8080 still has listener PID(s): 4242");
    expect(result.stderr).toContain("sandbox backups were preserved");
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("preserves stale PID recovery when lsof cannot verify the gateway port (#10369)", () => {
    const { result, pidFile } = runDarwinGatewayPidFile("999999999\n", {
      lsofDiagnostic: "permission denied",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lsof did not produce a conclusive listener observation");
    expect(result.stderr).toContain(
      "PID file, OpenShell registration, and sandbox backups were preserved",
    );
    expect(result.stderr).not.toContain("permission denied");
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("rejects malformed or symlinked macOS gateway PID files (#10369)", () => {
    const malformed = runDarwinGatewayPidFile("not-a-pid\n");
    const symlinked = runDarwinGatewayPidFile("999999999\n", { symlink: true });

    expect(malformed.result.status).toBe(1);
    expect(malformed.result.stderr).toContain("invalid PID file");
    expect(symlinked.result.status).toBe(1);
    expect(symlinked.result.stderr).toContain("untrusted PID file");
  });

  it("stops only the active trusted OpenShell Homebrew user service (#10369)", () => {
    const { result, launchctlLog } = runDarwinGatewayServiceStop();
    const serviceDomain = `gui/${process.getuid?.()}/homebrew.mxcl.openshell`;

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(launchctlLog.trim().split(/\r?\n/)).toEqual([
      `print ${serviceDomain}`,
      `bootout ${serviceDomain}`,
      `print ${serviceDomain}`,
    ]);
  });

  it("refuses to stop a Homebrew user service with an unexpected label (#10369)", () => {
    const { result, launchctlLog } = runDarwinGatewayServiceStop({ trustedLabel: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("macOS user service with an unexpected label");
    expect(launchctlLog).toBe("");
  });

  it("refuses to stop a Homebrew user service with an unexpected executable (#10369)", () => {
    const { result, launchctlLog } = runDarwinGatewayServiceStop({ trustedProgram: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("macOS user service with an untrusted executable");
    expect(launchctlLog).toBe("");
  });

  it("refuses to stop a trusted plist when the active launchd job has a foreign executable (#10369)", () => {
    const { result, launchctlLog } = runDarwinGatewayServiceStop({ trustedActiveProgram: false });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active macOS user service with an untrusted executable");
    expect(launchctlLog.trim().split(/\r?\n/)).toEqual([
      `print gui/${process.getuid?.()}/homebrew.mxcl.openshell`,
    ]);
  });

  it("selects Homebrew binaries after a verified formula install (#10386)", () => {
    const { gatewayBin, openshellBin, result } = runVerifiedHomebrewInstallSelection();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`openshell=${openshellBin}`);
    expect(result.stdout).toContain(`gateway=${gatewayBin}`);
    expect(result.stdout).toContain(`path=${openshellBin}`);
  });

  it("selects both verified standalone binaries on macOS without Homebrew (#10369)", () => {
    const { gatewayBin, openshellBin, result } = runVerifiedStandaloneInstallSelection();

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`openshell=${openshellBin}`);
    expect(result.stdout).toContain(`gateway=${gatewayBin}`);
    expect(result.stdout).toContain(`path=${openshellBin}`);
    expect(result.stdout).toContain("without reboot persistence");
  });

  it("stops after a verified standalone install when the gateway binary is missing (#10369)", () => {
    const { result } = runVerifiedStandaloneInstallSelection({ missingGateway: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified standalone OpenShell installation");
  });

  it("stops when the macOS OpenShell installation method changes during install (#10369)", () => {
    const { result } = runVerifiedStandaloneInstallSelection({ ambiguousMethod: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("installation method changed while installation was running");
  });

  it("stops after a verified Homebrew install when brew cannot resolve its prefix (#10386)", () => {
    const { result, staleOpenshellBin } = runVerifiedHomebrewInstallSelection({
      brewPrefixFailure: true,
    });

    expect(fs.existsSync(staleOpenshellBin)).toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified Homebrew OpenShell installation");
  });

  it("stops after a verified Homebrew install when the gateway binary is missing (#10386)", () => {
    const { result, staleOpenshellBin } = runVerifiedHomebrewInstallSelection({
      missingGateway: true,
    });

    expect(fs.existsSync(staleOpenshellBin)).toBe(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("verified Homebrew OpenShell installation");
  });
});
