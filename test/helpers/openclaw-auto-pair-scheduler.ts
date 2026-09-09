// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

const INVALID_AUTO_PAIR_ENV_CASES: ReadonlyArray<
  readonly [string, Readonly<Record<string, string>>]
> = [
  ["an infinite poll count", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "Infinity" }],
  ["a lowercase infinite poll count", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "inf" }],
  ["an overflowing poll count", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "1e309" }],
  ["an infinite fast interval", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "Infinity" }],
  ["an above-limit fast interval", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "300.01" }],
  ["a not-a-number slow interval", { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "NaN" }],
  ["a fractional poll count below one", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "0.5" }],
  ["a fractional poll count above one", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "2.7" }],
  ["an exponent-form poll count", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "1e1" }],
  ["an underscore-separated interval", { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1_000" }],
  ["an above-limit poll count", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "1728001" }],
  ["an overlong poll count", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "9".repeat(5_000) }],
  ["an infinite slow interval", { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "Infinity" }],
  ["an above-limit slow interval", { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "300.01" }],
  ["an underflowing slow interval", { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "1e-324" }],
  [
    "a midpoint slow interval",
    { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "2.4703282292062327e-324" },
  ],
  ["an above-limit run timeout", { NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "300.01" }],
  ["an above-limit watcher deadline", { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "86401" }],
  ["a below-limit watcher deadline", { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "0.5" }],
  ["an infinite watcher deadline", { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "inf" }],
];

const BOUNDARY_AUTO_PAIR_ENV_CASES: ReadonlyArray<
  readonly [string, Readonly<Record<string, string>>, Readonly<Record<string, string>>]
> = [
  ["the poll limit", { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "1728000" }, { POLLS: "1728000" }],
  [
    "the fast interval limit",
    { NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "300" },
    { INTERVAL: "300.0" },
  ],
  ["the deadline limit", { NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "86400" }, { DEADLINE: "86400" }],
  ["the slow interval limit", { NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "300" }, { SLOW: "300.0" }],
  [
    "the run timeout limit",
    { NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "300" },
    { RUN_TIMEOUT: "300.0" },
  ],
];

const VALID_AUTO_PAIR_ENV = Object.freeze({
  NEMOCLAW_AUTO_PAIR_FAST_REENTRY_POLLS: "7",
  NEMOCLAW_AUTO_PAIR_FAST_REENTRY_INTERVAL_SECS: "0.25",
  NEMOCLAW_AUTO_PAIR_SLOW_INTERVAL_SECS: "9",
  NEMOCLAW_AUTO_PAIR_RUN_TIMEOUT_SECS: "12",
  NEMOCLAW_AUTO_PAIR_DEADLINE_SECS: "600",
});

const DEFAULT_VALUES = Object.freeze({
  POLLS: "5",
  INTERVAL: "1",
  SLOW: "5",
  RUN_TIMEOUT: "10",
  DEADLINE: "28800",
});

export const AUTO_PAIR_SCHEDULER_CASES = [
  ...INVALID_AUTO_PAIR_ENV_CASES.map(([name, env]) => ({
    name: `uses defaults for ${name}`,
    kind: "constants" as const,
    env,
    expected: { status: 0, stderr: "", values: DEFAULT_VALUES },
  })),
  ...BOUNDARY_AUTO_PAIR_ENV_CASES.map(([name, env, values]) => ({
    name: `honours ${name}`,
    kind: "constants" as const,
    env,
    expected: { status: 0, values },
  })),
  {
    name: "honours in-range overrides",
    kind: "constants" as const,
    env: VALID_AUTO_PAIR_ENV,
    expected: {
      status: 0,
      values: { POLLS: "7", INTERVAL: "0.25", SLOW: "9.0", RUN_TIMEOUT: "12.0", DEADLINE: "600" },
    },
  },
  ...[
    ["caps slow-mode sleep at the deadline", 0, "0"],
    ["caps fast-reentry sleep at the deadline", 2, "1"],
  ].map(([name, fastReentryRemaining, remaining]) => ({
    name,
    kind: "sleep" as const,
    options: {
      deadline: 100.25,
      now: 100,
      defaultSeconds: 1_000_000_000,
      fastReentryInterval: 1_000_000_000,
      fastReentryRemaining: Number(fastReentryRemaining),
    },
    expected: {
      status: 0,
      stderr: "",
      values: { SLEEP: "0.25", FAST_REENTRY_REMAINING: remaining },
    },
  })),
  {
    name: "caps an active command at the deadline",
    kind: "timeout" as const,
    options: { deadline: 100.25, now: 100, runTimeout: 300 },
    expected: { status: 0, stderr: "", values: { CHILD_STATUS: "0", TIMEOUT: "0.25" } },
  },
];

export function instrumentAutoPairPythonScript(src: string): string {
  return src
    .replaceAll("time.time()", "_nemoclaw_test_time()")
    .replaceAll("time.sleep(", "_nemoclaw_test_sleep(")
    .replace(
      "import time",
      `import time
_nemoclaw_test_clock = [time.time()]
_nemoclaw_test_time = lambda: _nemoclaw_test_clock[0]
def _nemoclaw_test_sleep(seconds): _nemoclaw_test_clock.__setitem__(0, _nemoclaw_test_clock[0] + min(max(float(seconds), 0), 0.25))
`,
    );
}

export function runAutoPairSchedulerProbe(
  startScriptPath: string,
  kind: "constants" | "sleep" | "timeout",
  options: Record<string, number> = {},
  env: NodeJS.ProcessEnv = {},
) {
  const source = fs.readFileSync(startScriptPath, "utf8");
  const watcher = source.match(/<<'PYAUTOPAIR'[^\n]*\n([\s\S]*?)\nPYAUTOPAIR/u)?.[1];
  if (!watcher) throw new Error("auto-pair watcher not found");
  let program: string[];
  if (kind === "constants") {
    const start = watcher.indexOf("OPENCLAW = os.environ.get('OPENCLAW_BIN', 'openclaw')");
    const last = watcher.indexOf("RUN_TIMEOUT_SECS = _env_seconds(");
    if (start < 0 || last <= start) throw new Error("auto-pair scheduler constants not found");
    const prelude = watcher.slice(start, watcher.indexOf("\n", last));
    program = [
      "import os",
      "import re",
      "import time",
      prelude,
      "print('POLLS', FAST_REENTRY_POLLS)",
      "print('INTERVAL', FAST_REENTRY_INTERVAL)",
      "print('SLOW', SLOW_INTERVAL)",
      "print('RUN_TIMEOUT', RUN_TIMEOUT_SECS)",
      "print('DEADLINE', round(DEADLINE - time.time()))",
    ];
  } else if (kind === "sleep") {
    const helper = watcher.match(
      /def sleep_for_next_poll\(default_seconds, productive=True\):[\s\S]*?(?=\n\nwhile time\.time\(\) < DEADLINE:)/u,
    )?.[0];
    if (!helper) throw new Error("auto-pair sleep helper not found");
    program = [
      "class FakeTime:",
      "    def __init__(self):",
      `        self.now = ${String(options.now)}`,
      "        self.sleeps = []",
      "    def time(self):",
      "        return self.now",
      "    def sleep(self, seconds):",
      "        self.sleeps.append(seconds)",
      "time = FakeTime()",
      `DEADLINE = ${String(options.deadline)}`,
      `FAST_REENTRY_INTERVAL = ${String(options.fastReentryInterval)}`,
      `FAST_REENTRY_REMAINING = ${String(options.fastReentryRemaining)}`,
      helper,
      `sleep_for_next_poll(${String(options.defaultSeconds)})`,
      "print('SLEEP', repr(time.sleeps[0]))",
      "print('FAST_REENTRY_REMAINING', FAST_REENTRY_REMAINING)",
    ];
  } else {
    const helper = watcher.match(
      /def run\(\*args, strip_gateway_env=False, force_device_pairing=False, pairing_settlement=False\):[\s\S]*?(?=\n\ndef sleep_for_next_poll)/u,
    )?.[0];
    if (!helper) throw new Error("auto-pair command helper not found");
    program = [
      "class Result:",
      "    returncode = 0",
      "    stdout = ''",
      "    stderr = ''",
      "class FakeSubprocess:",
      "    class TimeoutExpired(Exception):",
      "        pass",
      "    def run(self, *args, **kwargs):",
      "        print('TIMEOUT', repr(kwargs['timeout']))",
      "        return Result()",
      "class FakeTime:",
      "    def time(self):",
      `        return ${String(options.now)}`,
      "class FakeOs:",
      "    environ = {}",
      "subprocess = FakeSubprocess()",
      "time = FakeTime()",
      "os = FakeOs()",
      "gateway_approval_env = lambda _env: {}",
      `DEADLINE = ${String(options.deadline)}`,
      `RUN_TIMEOUT_SECS = ${String(options.runTimeout)}`,
      helper,
      "result = run('openclaw', 'devices', 'list')",
      "print('CHILD_STATUS', result[0])",
    ];
  }
  const result = spawnSync("python3", ["-c", program.join("\n")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    values: Object.fromEntries(
      result.stdout
        .split("\n")
        .filter((line) => line.includes(" "))
        .map((line) => {
          const split = line.indexOf(" ");
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    ),
  };
}
