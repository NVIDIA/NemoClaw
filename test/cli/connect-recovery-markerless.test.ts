// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

describe("CLI markerless connect recovery", testTimeoutOptions(15_000), () => {
  it("accepts sandbox exec recovery when the gateway becomes healthy", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-markerless-recovery-"),
    );
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
        "      echo 'OpenClaw gateway launcher started without legacy recovery marker'",
        "      exit 0",
        "      ;;",
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      if [ "$(cat "$state_file")" != recovered ]; then echo STOPPED; exit 0; fi',
        '      count=$(cat "$ready_count_file" 2>/dev/null || echo 0)',
        "      count=$((count + 1))",
        '      echo "$count" > "$ready_count_file"',
        '      if [ "$count" -ge 2 ]; then echo RUNNING; else echo STOPPED; fi',
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        'if [ "$1" = "forward" ]; then',
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS: "0",
      NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS: "0",
      NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "3",
    });

    expect(r.code).toBe(0);
    expect(r.out).toContain("Probe complete: recovered OpenClaw gateway");
    expect(fs.readFileSync(readyCountFile, "utf8").trim()).toBe("2");
  });

  it("does not accept markerless launcher output when gateway health never becomes running", () => {
    const home = fs.mkdtempSync(
      path.join(os.tmpdir(), "nemoclaw-cli-connect-markerless-unhealthy-"),
    );
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
        "      echo 'OpenClaw gateway launcher started without legacy recovery marker'",
        "      exit 0",
        "      ;;",
        "    *'curl -so'*)",
        "      echo '__NEMOCLAW_SANDBOX_EXEC_STARTED__'",
        '      count=$(cat "$ready_count_file" 2>/dev/null || echo 0)',
        "      count=$((count + 1))",
        '      echo "$count" > "$ready_count_file"',
        "      echo STOPPED",
        "      exit 0",
        "      ;;",
        "  esac",
        "fi",
        'if [ "$1" = "forward" ]; then',
        "  echo 'forward should not run before verified gateway health' >&2",
        "  exit 1",
        "fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    const r = runWithEnv("alpha connect --probe-only", {
      HOME: home,
      PATH: `${localBin}:${process.env.PATH || ""}`,
      NEMOCLAW_GATEWAY_RECOVERY_POLL_INTERVAL_SECONDS: "0",
      NEMOCLAW_GATEWAY_RECOVERY_SETTLE_SECONDS: "0",
      NEMOCLAW_GATEWAY_RECOVERY_WAIT_SECONDS: "2",
    });

    expect(r.code).toBe(1);
    expect(r.out).toContain("automatic recovery failed");
    expect(r.out).not.toContain("Probe complete: recovered OpenClaw gateway");
    expect(fs.readFileSync(readyCountFile, "utf8").trim()).toBe("4");
  });
});
