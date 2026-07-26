// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const START_SCRIPT = path.resolve(HERE, "..", "scripts", "nemoclaw-start.sh");

function requireNonNegative(value: number, message: string): number {
  return value >= 0
    ? value
    : (() => {
        throw new Error(message);
      })();
}

function extractShellFunction(scriptPath: string, name: string): string {
  const body = readFileSync(scriptPath, "utf8");
  const startMarker = `${name}() {`;
  const start = requireNonNegative(
    body.indexOf(startMarker),
    `function ${name} not found in ${scriptPath}`,
  );
  const lines = body.slice(start).split("\n");
  const endIndex = requireNonNegative(
    lines.findIndex((line, index) => index > 0 && line === "}"),
    `function ${name} missing closing brace in ${scriptPath}`,
  );
  return lines.slice(0, endIndex + 1).join("\n");
}

function runMarkerScenario(scenario: string): { status: number; stdout: string } {
  const helper = extractShellFunction(START_SCRIPT, "_nemoclaw_safe_replace_tmp_file");
  const record = extractShellFunction(START_SCRIPT, "record_gateway_watchdog_kill");
  const consume = extractShellFunction(START_SCRIPT, "consume_gateway_watchdog_kill");
  const harness = `
${helper}
${record}
${consume}
GATEWAY_WATCHDOG_KILL_FILE="$(mktemp -u "\${TMPDIR:-/tmp}/nemoclaw-wd-kill.XXXXXX")"
${scenario}
`;
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf-8", timeout: 10_000 });
  return { status: result.status ?? -1, stdout: (result.stdout ?? "").trim() };
}

function extractRespawnCriticalSection(scriptPath: string): string {
  const body = readFileSync(scriptPath, "utf8");
  const startMarker = '    RC=0\n    EXITED_GATEWAY_PID="$GATEWAY_PID"';
  const start = requireNonNegative(
    body.indexOf(startMarker),
    `non-root respawn critical section not found in ${scriptPath}`,
  );
  const endMarker = "    NOW=$(date +%s)";
  const end = requireNonNegative(
    body.indexOf(endMarker, start),
    `non-root respawn critical section end not found in ${scriptPath}`,
  );
  return body.slice(start, end).trimEnd();
}

function runRespawnCriticalSection(setup: string): { status: number; stdout: string } {
  const helper = extractShellFunction(START_SCRIPT, "_nemoclaw_safe_replace_tmp_file");
  const record = extractShellFunction(START_SCRIPT, "record_gateway_watchdog_kill");
  const consume = extractShellFunction(START_SCRIPT, "consume_gateway_watchdog_kill");
  const section = extractRespawnCriticalSection(START_SCRIPT);
  const harness = `
${helper}
${record}
${consume}
wait() { return "\${STUB_WAIT_RC:-0}"; }
mark_openclaw_gateway_stopped() { GATEWAY_PID=0; GATEWAY_PID_START_IDENTITY=""; }
GATEWAY_WATCHDOG_KILL_FILE="$(mktemp -u "\${TMPDIR:-/tmp}/nemoclaw-wd-kill.XXXXXX")"
GATEWAY_PID="123"
GATEWAY_PID_START_IDENTITY="456"
${setup}
${section}
echo RESPAWN
`;
  const result = spawnSync("bash", ["-c", harness], { encoding: "utf-8", timeout: 10_000 });
  return { status: result.status ?? -1, stdout: (result.stdout ?? "").trim() };
}

describe("gateway watchdog kill marker", () => {
  it("respawns (match) when the consumed identity equals the recorded one", () => {
    const { status } = runMarkerScenario(
      `record_gateway_watchdog_kill "123:456"\nconsume_gateway_watchdog_kill "123:456"`,
    );
    expect(status).toBe(0);
  });

  it("does not match a different gateway identity", () => {
    const { status } = runMarkerScenario(
      `record_gateway_watchdog_kill "123:456"\nconsume_gateway_watchdog_kill "999:000"`,
    );
    expect(status).toBe(1);
  });

  it("does not match when no marker was recorded", () => {
    const { status } = runMarkerScenario(`consume_gateway_watchdog_kill "123:456"`);
    expect(status).toBe(1);
  });

  it("does not match an empty recorded identity", () => {
    const { status } = runMarkerScenario(
      `record_gateway_watchdog_kill ""\nconsume_gateway_watchdog_kill "123:456"`,
    );
    expect(status).toBe(1);
  });

  it("matches only once — a second consume of the same identity misses", () => {
    const { status } = runMarkerScenario(
      `record_gateway_watchdog_kill "123:456"\nconsume_gateway_watchdog_kill "123:456"\nconsume_gateway_watchdog_kill "123:456"`,
    );
    expect(status).toBe(1);
  });

  it("clears the marker on a matching consume", () => {
    const { stdout } = runMarkerScenario(
      `record_gateway_watchdog_kill "123:456"\nconsume_gateway_watchdog_kill "123:456"\ntest -f "$GATEWAY_WATCHDOG_KILL_FILE" && echo PRESENT || echo ABSENT`,
    );
    expect(stdout).toBe("ABSENT");
  });

  it("clears a stale marker even when the identity does not match", () => {
    const { stdout } = runMarkerScenario(
      `record_gateway_watchdog_kill "123:456"\nconsume_gateway_watchdog_kill "999:000"\ntest -f "$GATEWAY_WATCHDOG_KILL_FILE" && echo PRESENT || echo ABSENT`,
    );
    expect(stdout).toBe("ABSENT");
  });

  it("respawns via the real loop when the watchdog recorded the exiting identity", () => {
    const { stdout } = runRespawnCriticalSection(`record_gateway_watchdog_kill "123:456"`);
    expect(stdout).toBe("RESPAWN");
  });

  it("tears down via the real loop on a genuine operator clean exit with no marker", () => {
    const { stdout } = runRespawnCriticalSection("");
    expect(stdout).toBe("");
  });

  it("tears down via the real loop when the marker identity does not match the exit", () => {
    const { stdout } = runRespawnCriticalSection(`record_gateway_watchdog_kill "123:999"`);
    expect(stdout).toBe("");
  });
});
