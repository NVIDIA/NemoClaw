// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DCODE_BUSY_PROBE_SCRIPT,
  DCODE_PROBE_PREFIX,
  DCODE_PROBE_STATE,
  parseDcodeProbeState,
} from "./dcode-activity-probe";

/** Run the shell probe with controlled ps and /proc inputs. */
function runProbeScriptWithProcessSources({
  processes = "",
  procCmdlines = [],
  psExitCode = 0,
  unreadableProcEntries = 0,
}: {
  processes?: string;
  procCmdlines?: readonly string[];
  psExitCode?: number;
  unreadableProcEntries?: number;
}): { status: number; output: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-probe-"));
  const psPath = path.join(tempDir, "ps");
  const homeDir = path.join(tempDir, "home");
  const procRoot = path.join(tempDir, "proc's");
  fs.mkdirSync(homeDir);
  fs.mkdirSync(procRoot);
  fs.mkdirSync(path.join(homeDir, ".deepagents"));
  for (const [index, cmdline] of procCmdlines.entries()) {
    const processDir = path.join(procRoot, String(index + 100));
    fs.mkdirSync(processDir);
    fs.writeFileSync(path.join(processDir, "cmdline"), cmdline);
  }
  for (const index of Array.from({ length: unreadableProcEntries }, (_, offset) => offset)) {
    const processDir = path.join(procRoot, String(index + 200));
    fs.mkdirSync(processDir);
    const cmdlinePath = path.join(processDir, "cmdline");
    fs.writeFileSync(cmdlinePath, "/usr/bin/dcode\0-n\0work\0");
    fs.chmodSync(cmdlinePath, 0o000);
  }
  fs.writeFileSync(psPath, `#!/bin/sh\ncat <<'EOF'\n${processes}\nEOF\nexit ${psExitCode}\n`);
  fs.chmodSync(psPath, 0o755);
  const testProbeScript = DCODE_BUSY_PROBE_SCRIPT.replace(
    "proc_root=/proc",
    'proc_root="$NEMOCLAW_TEST_DCODE_PROC_ROOT"',
  );
  const result = spawnSync("sh", ["-c", testProbeScript], {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${tempDir}:/usr/bin:/bin`,
      NEMOCLAW_DCODE_PROC_ROOT: path.join(tempDir, "sandbox-controlled-proc"),
      NEMOCLAW_TEST_DCODE_PROC_ROOT: procRoot,
    },
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
  return { status: result.status ?? 255, output: result.stdout || "" };
}

/** Assert the probe emitted exactly one observable sentinel. */
function expectProbeState(
  result: { status: number; output: string },
  state: (typeof DCODE_PROBE_STATE)[keyof typeof DCODE_PROBE_STATE],
): void {
  expect(result.status).toBe(0);
  expect(result.output.trim()).toBe(`${DCODE_PROBE_PREFIX}${state}`);
}

describe("dcode activity probe", () => {
  it("does not let sandbox environment redirect the production proc scan (#6180)", () => {
    expect(DCODE_BUSY_PROBE_SCRIPT).toContain("proc_root=/proc");
    expect(DCODE_BUSY_PROBE_SCRIPT).not.toContain("NEMOCLAW_DCODE_PROC_ROOT");
  });

  it("falls back to proc cmdline scanning when ps cannot list processes (#6180)", () => {
    expectProbeState(
      runProbeScriptWithProcessSources({
        procCmdlines: ["/bin/sh\0-c\0sleep 30\0", "/usr/bin/python3\0-m\0not_deepagents_code\0"],
        psExitCode: 1,
      }),
      DCODE_PROBE_STATE.idleDcodeRuntime,
    );
    expectProbeState(
      runProbeScriptWithProcessSources({
        procCmdlines: ["/opt/venv/bin/python3\0-I\0-m\0deepagents_code\0-n\0work\0"],
        psExitCode: 1,
      }),
      DCODE_PROBE_STATE.active,
    );
  });

  it("fails closed when ps and proc cannot verify a marked dcode runtime (#6180)", () => {
    expectProbeState(
      runProbeScriptWithProcessSources({ psExitCode: 1 }),
      DCODE_PROBE_STATE.unverifiableDcodeRuntime,
    );
  });

  it("fails closed when proc fallback visibility is incomplete (#6180)", () => {
    expectProbeState(
      runProbeScriptWithProcessSources({
        procCmdlines: ["", "/bin/sh\0-c\0sleep 30\0"],
        psExitCode: 1,
      }),
      DCODE_PROBE_STATE.unverifiableDcodeRuntime,
    );
    expectProbeState(
      runProbeScriptWithProcessSources({
        procCmdlines: ["/bin/sh\0-c\0sleep 30\0"],
        psExitCode: 1,
        unreadableProcEntries: 1,
      }),
      DCODE_PROBE_STATE.unverifiableDcodeRuntime,
    );
  });

  it("parses every declared probe state", () => {
    for (const state of Object.values(DCODE_PROBE_STATE)) {
      expect(parseDcodeProbeState(`${DCODE_PROBE_PREFIX}${state}\n`)).toBe(state);
    }
  });

  it("parses exactly one probe sentinel from sandbox exec output", () => {
    expect(parseDcodeProbeState(`${DCODE_PROBE_PREFIX}idle\n`)).toBe(
      DCODE_PROBE_STATE.idleDcodeRuntime,
    );
    expect(parseDcodeProbeState(`${DCODE_PROBE_PREFIX}idle\n${DCODE_PROBE_PREFIX}active\n`)).toBe(
      null,
    );
  });
});
