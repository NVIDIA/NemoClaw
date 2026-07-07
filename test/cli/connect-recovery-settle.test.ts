// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// CLI coverage for the #4710 post-recovery settle-confirm: a wedged gateway
// passes the controller's initial recovery proof and then drops its listener, so
// `connect --probe-only` must fail and surface the wedge signature instead of
// declaring a recovery that is already dying. Split from
// connect-recovery.test.ts, which is at the default size budget.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, writeSandboxRegistry } from "./helpers";

const DECODE_SANDBOX_EXEC_COMMAND_LINES = [
  "decode_sandbox_exec_cmd() {",
  `  ${JSON.stringify(process.execPath)} -e "const s=process.argv[1]||'';const m=s.match(/printf '%s' '([A-Za-z0-9+/=]+)' \\| base64 -d \\| sh/);process.stdout.write(m?Buffer.from(m[1],'base64').toString('utf8'):s);" "$1"`,
  "}",
];

describe("CLI dispatch", () => {
  it("fails probe-only when the authenticated settle probe detects a listener wedge (#4710)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cli-connect-probe-wedge-"));
    const localBin = path.join(home, "bin");
    const markerFile = path.join(home, "openshell-calls");
    const stateFile = path.join(home, "probe-state");
    const readyCountFile = path.join(home, "ready-count");
    fs.mkdirSync(localBin, { recursive: true });
    writeSandboxRegistry(home);
    fs.writeFileSync(stateFile, "stopped");
    fs.writeFileSync(
      path.join(localBin, "openshell"),
      [
        "#!/usr/bin/env bash",
        ...DECODE_SANDBOX_EXEC_COMMAND_LINES,
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        `ready_count_file=${JSON.stringify(readyCountFile)}`,
        'printf \'%s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "sandbox" ] && [ "$2" = "get" ] && [ "$3" = "alpha" ]; then',
        "  echo 'Sandbox:'",
        "  echo",
        "  echo '  Id: abc'",
        "  echo '  Name: alpha'",
        "  echo '  Namespace: openshell'",
        "  echo '  Phase: Ready'",
        "  exit 0",
        "fi",
        'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ] && [ "$3" = "--name" ] && [ "$4" = "alpha" ]; then',
        '  cmd="$8"',
        '  cmd="$(decode_sandbox_exec_cmd "$cmd")"',
        '  case "$cmd" in',
        '    *"OPENCLAW="*)',
        '      echo recovered > "$state_file"',
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "      echo 'GATEWAY_PID=123'",
        "      exit 0",
        "      ;;",
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      if [ "$(cat "$state_file")" != recovered ]; then echo STOPPED; exit 0; fi',
        // Any outer-namespace post-recovery health check would be invalid in
        // the OpenShell topology. Keep a counter so the assertion below proves
        // the authenticated controller probe was used instead.
        '      count=$(cat "$ready_count_file" 2>/dev/null || echo 0)',
        "      count=$((count + 1))",
        '      echo "$count" > "$ready_count_file"',
        '      if [ "$count" -le 1 ]; then echo RUNNING; else echo STOPPED; fi',
        "      exit 0",
        "      ;;",
        "    *'grep -E'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        "      echo '[reload] config change requires gateway restart (plugins.installs)'",
        "      echo 'gateway startup failed: listen failure. Process will stay alive; fix the issue and restart.'",
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(localBin, "docker"),
      [
        "#!/usr/bin/env bash",
        "set -u",
        `marker_file=${JSON.stringify(markerFile)}`,
        `state_file=${JSON.stringify(stateFile)}`,
        'printf \'docker %s\\n\' "$*" >> "$marker_file"',
        'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
        'if [ "$1" = "ps" ]; then',
        "  printf 'container-id\\topenshell-alpha\\n'",
        "  exit 0",
        "fi",
        'if [[ "$*" == *"--env LD_PRELOAD="* ]] && [[ "$*" == *"--env PYTHONPATH="* ]] && [[ "$*" == *"--user root container-id /usr/local/bin/nemoclaw-gateway-control recover "* ]]; then',
        '  nonce="${!#}"',
        '  case "$nonce" in *[!0-9a-f]*|"") exit 64 ;; esac',
        '  [ "${#nonce}" -eq 64 ] || exit 64',
        '  echo recovered > "$state_file"',
        "  echo 'GATEWAY_PID=123'",
        "  exit 0",
        "fi",
        'if [[ "$*" == *"--env LD_PRELOAD="* ]] && [[ "$*" == *"--env PYTHONPATH="* ]] && [[ "$*" == *"--user root container-id /usr/local/bin/nemoclaw-gateway-control probe "* ]]; then',
        '  nonce="${!#}"',
        '  case "$nonce" in *[!0-9a-f]*|"") exit 64 ;; esac',
        '  [ "${#nonce}" -eq 64 ] || exit 64',
        "  echo 'GATEWAY_HEALTH_TIMEOUT' >&2",
        "  exit 1",
        "fi",
        "exit 65",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "3",
      NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS: "0",
      NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS: "1",
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain(
      "Probe failed: OpenClaw gateway is not running in 'alpha' and automatic recovery failed.",
    );
    expect(r.out).toContain("#4710 wedge signature");
    expect(r.out).toContain("config change requires gateway restart (plugins.installs)");
    const calls = fs.readFileSync(markerFile, "utf8");
    expect(calls).toMatch(
      /^docker exec (?:--env [A-Z0-9_]+=[^ ]* )+--user root container-id \/usr\/local\/bin\/nemoclaw-gateway-control recover [0-9a-f]{64}$/m,
    );
    expect(calls).toMatch(
      /^docker exec (?:--env [A-Z0-9_]+=[^ ]* )+--user root container-id \/usr\/local\/bin\/nemoclaw-gateway-control probe [0-9a-f]{64}$/m,
    );
    expect(calls).toContain("--env LD_PRELOAD=");
    expect(calls).toContain("--env PYTHONPATH=");
    expect(calls).toContain("--env PYTHONUSERBASE=");
    expect(calls).toContain("--env PYTHONNOUSERSITE=1");
    expect(calls).not.toContain("OPENCLAW=");
    expect(fs.existsSync(readyCountFile)).toBe(false);
  });
});
