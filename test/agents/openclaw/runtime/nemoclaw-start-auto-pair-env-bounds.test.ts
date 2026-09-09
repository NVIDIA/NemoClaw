// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const START_SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "../../..",
  "scripts",
  "nemoclaw-start.sh",
);

/**
 * The auto-pair watcher reads its scheduler knobs straight from the process
 * environment, so a plain `docker run -e NAME=value` reaches them without ever
 * passing through the image entrypoint's env wrapper. This harness runs the
 * watcher's own prelude, up to and including the last scheduler constant, so
 * the assertions cover the values the watcher actually computes.
 */
function resolveSchedulerConstants(env: NodeJS.ProcessEnv): {
  status: number | null;
  stderr: string;
  constants: Record<string, string>;
} {
  const source = fs.readFileSync(START_SCRIPT, "utf-8");
  const watcher = source.match(/<<'PYAUTOPAIR'[^\n]*\n([\s\S]*?)\nPYAUTOPAIR/u);
  expect(watcher).not.toBeNull();
  const body = watcher![1];
  const start = body.indexOf("OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')");
  const last = body.indexOf("RUN_TIMEOUT_SECS = _env_seconds(");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(start);
  const prelude = body.slice(start, body.indexOf("\n", last));
  const program = [
    "import os",
    "import re",
    "import time",
    prelude,
    "print('POLLS', FAST_REENTRY_POLLS)",
    "print('INTERVAL', FAST_REENTRY_INTERVAL)",
    "print('SLOW', SLOW_INTERVAL)",
    "print('RUN_TIMEOUT', RUN_TIMEOUT_SECS)",
    "print('DEADLINE', round(DEADLINE - time.time()))",
  ].join("\n");
  const result = spawnSync("python3", ["-c", program], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  const constants = Object.fromEntries(
    result.stdout
      .split("\n")
      .filter((line) => line.includes(" "))
      .map((line) => [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)]),
  );
  return { status: result.status, stderr: result.stderr, constants };
}

describe("nemoclaw-start auto-pair scheduler environment bounds", () => {
  it.each([
    {
      name: "an infinite poll count",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "Infinity" },
    },
    {
      name: "a lowercase infinite poll count",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "inf" },
    },
    {
      name: "a poll count that overflows to infinity",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "1e309" },
    },
    {
      name: "an infinite fast-reentry interval",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "Infinity" },
    },
    {
      name: "an unsleepable fast-reentry interval",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "1e10" },
    },
    {
      name: "a not-a-number slow interval",
      input: { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "NaN" },
    },
    {
      name: "a fractional poll count that would truncate to zero",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "0.5" },
    },
    {
      name: "a fractional poll count that would truncate down",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "2.7" },
    },
    {
      name: "an exponent-form poll count rejected by the shared grammar",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "1e1" },
    },
    {
      name: "an underscore-separated interval rejected by the shared grammar",
      input: { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1_000" },
    },
    {
      name: "a poll count past the safe integer range",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "9007199254740993" },
    },
    {
      name: "an infinite slow interval",
      input: { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "Infinity" },
    },
    {
      name: "a run timeout past the subprocess limit",
      input: { NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "2147484" },
    },
    {
      name: "a watcher deadline past its comparison limit",
      input: { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "1000000000001" },
    },
    { name: "an infinite watcher deadline", input: { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "inf" } },
  ])("keeps the auto-pair watcher alive and on defaults for $name (#11161)", ({ input }) => {
    const resolved = resolveSchedulerConstants(input);

    expect(resolved.stderr).not.toContain("OverflowError");
    expect(resolved.status).toBe(0);
    expect(resolved.constants).toEqual({
      POLLS: "5",
      INTERVAL: "1",
      SLOW: "5",
      RUN_TIMEOUT: "10",
      DEADLINE: "28800",
    });
  });

  it.each([
    {
      name: "a poll count the launch renderer accepts",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "9007199254740991" },
      expected: { POLLS: "9007199254740991" },
    },
    {
      name: "a poll count above the seconds range",
      input: { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "2000000" },
      expected: { POLLS: "2000000" },
    },
    {
      name: "a month-long watcher deadline",
      input: { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "2592000" },
      expected: { DEADLINE: "2592000" },
    },
    {
      name: "a year-long watcher deadline",
      input: { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "31536000" },
      expected: { DEADLINE: "31536000" },
    },
    {
      name: "a run timeout at the subprocess limit",
      input: { NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "2147483" },
      expected: { RUN_TIMEOUT: "2147483.0" },
    },
  ])(
    "bounds each knob by the limit that applies to it, honouring $name (#11161)",
    ({ input, expected }) => {
      const resolved = resolveSchedulerConstants(input);

      expect(resolved.status).toBe(0);
      expect(resolved.constants).toMatchObject(expected);
    },
  );

  it("honours in-range auto-pair scheduler overrides (#11161)", () => {
    const resolved = resolveSchedulerConstants({
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "7",
      NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.25",
      NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "9",
      NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "12",
      NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "600",
    });

    expect(resolved.status).toBe(0);
    expect(resolved.constants).toEqual({
      POLLS: "7",
      INTERVAL: "0.25",
      SLOW: "9.0",
      RUN_TIMEOUT: "12.0",
      DEADLINE: "600",
    });
  });
});
