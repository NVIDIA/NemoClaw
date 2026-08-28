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
  options: { trustedExecutable?: boolean; trustedIdentity?: boolean } = {},
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-darwin-gateway-stop-"));
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "bin");
  const runtimeDir = path.join(tmp, "runtime");
  const gatewayBin = path.join(home, ".local", "bin", "openshell-gateway");
  const foreignGatewayBin = path.join(tmp, "foreign-gateway");
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
printf '%s\n' '${
      options.trustedIdentity === false
        ? "python"
        : "openshell-gateway[nemoclaw=nemoclaw-20369;port=20369]"
    }'
`,
  );
  writeExecutable(
    path.join(bin, "lsof"),
    `#!/usr/bin/env bash
managed_pid="$(cat '${runtimeDir}/openshell-gateway.pid')" || exit 1
[ "\${3:-}" = "$managed_pid" ] || exit 1
printf 'p%s\nn%s\n' "$managed_pid" '${options.trustedExecutable === false ? foreignGatewayBin : gatewayBin}'
`,
  );

  const script =
    options.trustedIdentity === false || options.trustedExecutable === false
      ? `trap 'kill "$gateway_pid" 2>/dev/null || true' EXIT
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
trap - EXIT`
      : `trap 'kill "$gateway_pid" 2>/dev/null || true' EXIT
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

function runDarwinGatewayPidFile(contents: string, symlink = false, listenerPid = "") {
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
  [ -n '${listenerPid}' ] || exit 1
  printf '%s\\n' '${listenerPid}'
  exit 0
fi
exit 1
`,
  );
  const writePidFile = symlink
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

  it("clears a stale owned macOS gateway PID file only when the port has no listener (#10369)", () => {
    const { result, pidFile } = runDarwinGatewayPidFile("999999999\n");

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(fs.existsSync(pidFile)).toBe(false);
  });

  it("preserves registration recovery when a stale PID file has an active listener (#10369)", () => {
    const { result, pidFile } = runDarwinGatewayPidFile("999999999\n", false, "4242");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("gateway port 8080 still has listener PID(s): 4242");
    expect(result.stderr).toContain("sandbox backups were preserved");
    expect(fs.existsSync(pidFile)).toBe(true);
  });

  it("rejects malformed or symlinked macOS gateway PID files (#10369)", () => {
    const malformed = runDarwinGatewayPidFile("not-a-pid\n");
    const symlinked = runDarwinGatewayPidFile("999999999\n", true);

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
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-homebrew-openshell-path-"));
    const bin = path.join(tmp, "bin");
    const brewPrefix = path.join(tmp, "homebrew");
    const openshellBin = path.join(brewPrefix, "bin", "openshell");
    const gatewayBin = path.join(brewPrefix, "bin", "openshell-gateway");
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.dirname(openshellBin), { recursive: true });
    writeExecutable(openshellBin, "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(gatewayBin, "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(path.join(bin, "uname"), "#!/usr/bin/env bash\nprintf 'Darwin\\n'\n");
    writeExecutable(
      path.join(bin, "brew"),
      `#!/usr/bin/env bash
[ "\${1:-}" = "--prefix" ] && printf '%s\n' '${brewPrefix}'
`,
    );

    const result = spawnSync(
      "bash",
      [
        "-c",
        `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1
prefer_homebrew_openshell verified-install
printf 'openshell=%s\ngateway=%s\npath=%s\n' "$NEMOCLAW_OPENSHELL_BIN" "$NEMOCLAW_OPENSHELL_GATEWAY_BIN" "$(command -v openshell)"`,
      ],
      {
        encoding: "utf-8",
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` },
      },
    );

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain(`openshell=${openshellBin}`);
    expect(result.stdout).toContain(`gateway=${gatewayBin}`);
    expect(result.stdout).toContain(`path=${openshellBin}`);
  });
});
