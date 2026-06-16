// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// CLI coverage for the #4710 post-recovery settle-confirm: a wedged gateway
// serves the first probe after relaunch and then drops its HTTP listener, so
// `connect --probe-only` must fail and surface the wedge signature instead of
// declaring a recovery that is already dying. Split from
// connect-recovery.test.ts, which is at the default size budget.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithEnv, writeSandboxRegistry } from "./helpers";

describe("CLI dispatch", () => {
  it("fails probe-only when the gateway serves once and then drops its listener (#4710 wedge)", () => {
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
        // The wedge shape: the relaunched gateway answers the first
        // post-recovery probe, then drops its listener — every later probe
        // refuses.
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
    // First probe succeeded, settle confirm observed the dropped listener.
    expect(fs.readFileSync(readyCountFile, "utf8").trim()).toBe("2");
  });
});
