// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  LAUNCH_READINESS_FIXTURE_POLICY,
  launchReadinessRegistryFixture,
} from "../helpers/launch-readiness-fixture";
import { run, runWithEnv, testTimeoutOptions, writeSandboxRegistry } from "./helpers";

const CALL_SEPARATOR = "--- openshell call ---";
const RUNTIME_ENV_EXEC_SCRIPT =
  'if [ -r "/tmp/nemoclaw-proxy-env.sh" ]; then builtin source "/tmp/nemoclaw-proxy-env.sh" || exit $?; fi; builtin unset OPENCLAW_GATEWAY_TOKEN; builtin exec -- "$@"';
const harnessRoots: string[] = [];

afterAll(() => {
  for (const root of harnessRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  harnessRoots.length = 0;
});

type LaunchHarness = {
  home: string;
  localBin: string;
  /** One space-joined line per `openshell` invocation. */
  callLines: () => string[];
  /** One argv array per `openshell` invocation, recorded element by element. */
  callArgvs: () => string[][];
  /** Exact argv of the interactive (`--tty`) exec, or null when it never ran. */
  launchExecArgv: () => string[] | null;
  runLaunch: (args: string) => ReturnType<typeof runWithEnv>;
};

/**
 * Fake `openshell` that answers every call `launch`'s preflight makes before
 * the interactive exec: gateway selection/status, sandbox lookup, the gateway
 * health probe, and the inference-route probe. The interactive exec is the one
 * call carrying `--tty`; it is recorded argv-element by argv-element instead of
 * being answered, so the assertions see the exact argv `launch` produced.
 */
function createLaunchHarness(prefix: string, agent: string): LaunchHarness {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  harnessRoots.push(home);
  const localBin = path.join(home, "bin");
  const callsFile = path.join(home, "openshell-calls");
  const callArgvFile = path.join(home, "openshell-call-argv");
  const execArgvFile = path.join(home, "openshell-exec-argv");
  fs.mkdirSync(localBin, { recursive: true });
  writeSandboxRegistry(home, { ...launchReadinessRegistryFixture(), agent });

  fs.writeFileSync(
    path.join(localBin, "openshell"),
    [
      "#!/usr/bin/env bash",
      `calls_file=${JSON.stringify(callsFile)}`,
      `call_argv_file=${JSON.stringify(callArgvFile)}`,
      `exec_argv_file=${JSON.stringify(execArgvFile)}`,
      'printf \'%s\\n\' "$*" >> "$calls_file"',
      `printf '%s\\n' ${JSON.stringify(CALL_SEPARATOR)} "$@" >> "$call_argv_file"`,
      'if [ "$1" = "--version" ]; then echo "openshell 0.0.16"; exit 0; fi',
      'if [ "$1" = "status" ]; then',
      "  echo 'Server Status'",
      "  echo",
      "  echo '  Gateway: nemoclaw'",
      "  echo '  Status: Connected'",
      "  exit 0",
      "fi",
      'if [ "$1" = "gateway" ] && [ "$2" = "info" ]; then',
      "  echo 'Gateway Info'",
      "  echo",
      "  echo '  Gateway: nemoclaw'",
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "list" ]; then',
      "  echo 'NAME           STATUS     AGE'",
      "  echo 'alpha          Ready      2m ago'",
      "  exit 0",
      "fi",
      // Only 'alpha' exists live. Any other token (including a metacharacter
      // token) must be reported missing so the preflight refuses it.
      'if [ "$1" = "sandbox" ] && [ "$2" = "get" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "alpha" ]; then',
      "      echo 'Sandbox:'",
      "      echo",
      "      echo '  Id: abc'",
      "      echo '  Name: alpha'",
      "      echo '  Namespace: openshell'",
      "      echo '  Phase: Ready'",
      "      exit 0",
      "    fi",
      "  done",
      "  echo 'sandbox not found' >&2",
      "  exit 1",
      "fi",
      'if [ "$1" = "policy" ] && [ "$2" = "get" ]; then',
      `  printf '%b' ${JSON.stringify(LAUNCH_READINESS_FIXTURE_POLICY)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "sandbox" ] && [ "$2" = "exec" ]; then',
      // The interactive agent exec is the only exec that requests a TTY.
      '  for arg in "$@"; do',
      '    if [ "$arg" = "--tty" ]; then',
      '      printf \'%s\\n\' "$@" > "$exec_argv_file"',
      "      exit 0",
      "    fi",
      "  done",
      // Preflight probes: gateway health and the inference.local route.
      "  echo 'OK 200'",
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  // The exec path's post-command OpenClaw permission cleanup shells out to
  // Docker; a stub keeps the outcome identical whether or not the host runs a
  // Docker daemon.
  fs.writeFileSync(
    path.join(localBin, "docker"),
    [
      "#!/usr/bin/env bash",
      'if [ "$1" = "info" ]; then echo "24.0.0"; exit 0; fi',
      'if [ "$1" = "ps" ]; then exit 0; fi',
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );

  const readLines = (file: string): string[] =>
    fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];

  return {
    home,
    localBin,
    callLines: () => readLines(callsFile),
    callArgvs: () =>
      readLines(callArgvFile)
        .join("\n")
        .split(CALL_SEPARATOR)
        .map((chunk) => chunk.split("\n").filter(Boolean))
        .filter((argv) => argv.length > 0),
    launchExecArgv: () =>
      fs.existsSync(execArgvFile)
        ? fs.readFileSync(execArgvFile, "utf8").replace(/\n$/, "").split("\n")
        : null,
    runLaunch: (args: string) =>
      runWithEnv(
        args,
        {
          HOME: home,
          PATH: `${localBin}:${process.env.PATH || ""}`,
        },
        90_000,
      ),
  };
}

describe("CLI launch routing process contracts (#6006)", () => {
  it("launch --help exits 0 and shows launch usage", () => {
    const result = run("launch --help");

    expect(result.code).toBe(0);
    expect(result.out).toContain("launch <name>");
    expect(result.out).toContain("Connect to a sandbox and start its agent");
    expect(result.out.replace(/\s+/g, " ")).toContain(
      "Validate a current launch-readiness lease or run the complete connect preflight",
    );
    expect(result.out).toContain("SANDBOXNAME");
  });

  it("launch without a sandbox name fails on the missing required argument", () => {
    const result = run("launch");

    expect(result.code).toBe(2);
    expect(result.out).toContain("Missing 1 required arg");
    expect(result.out).toContain("sandboxName");
  });

  it(
    "refuses a shell-metacharacter sandbox token without starting the agent",
    testTimeoutOptions(90_000),
    () => {
      const harness = createLaunchHarness("nemoclaw-cli-launch-unsafe-token-", "openclaw");

      const result = harness.runLaunch("launch 'alpha;echo pwned'");

      expect(result.code).toBe(1);
      expect(result.out).toContain(
        "Sandbox 'alpha;echo pwned' is not registered in the local NemoClaw state.",
      );
      // The token never reaches an in-sandbox command: no interactive exec ran.
      expect(harness.launchExecArgv()).toBeNull();
      expect(harness.callLines().some((call) => call.includes("--tty"))).toBe(false);

      // Local registry rejection happens before any OpenShell command can
      // receive the untrusted token.
      const tokenCalls = harness
        .callArgvs()
        .filter((argv) => argv.some((element) => element.includes("pwned")));
      expect(tokenCalls).toEqual([]);
      expect(harness.callLines()).toEqual([]);
    },
  );

  it(
    "refuses an untrusted registry agent before starting an in-sandbox command",
    testTimeoutOptions(90_000),
    () => {
      const harness = createLaunchHarness(
        "nemoclaw-cli-launch-unsafe-agent-",
        "mystery-agent; echo pwned",
      );

      const result = harness.runLaunch("launch alpha");

      expect(result.code).toBe(1);
      expect(result.out).toMatch(
        /(?:Cannot resolve an interactive command for unsupported agent "mystery-agent; echo pwned"\.|Launch readiness final validation failed due to config\.)/,
      );
      expect(harness.launchExecArgv()).toBeNull();
      expect(harness.callLines().some((call) => call.includes("--tty"))).toBe(false);
    },
  );

  // OpenClaw sandboxes run a host-side mutable-config permission cleanup after
  // the exec. The fake host has no sandbox container, so that cleanup fails and
  // overrides the exit code; `command exit 0` records that the agent exec
  // itself succeeded. The other agents skip the cleanup and exit 0 normally.
  it.each([
    {
      agent: "openclaw",
      agentCommand: "openclaw tui",
      exitCode: 1,
    },
    { agent: "hermes", agentCommand: "hermes", exitCode: 0 },
    {
      agent: "langchain-deepagents-code",
      agentCommand: "dcode",
      exitCode: 0,
    },
  ])(
    "launch runs `$agentCommand` for a $agent sandbox through one TTY exec with no timeout",
    testTimeoutOptions(90_000),
    ({ agent, agentCommand, exitCode }) => {
      const harness = createLaunchHarness(`nemoclaw-cli-launch-${agent}-`, agent);

      const result = harness.runLaunch("launch alpha");

      const execArgv = harness.launchExecArgv();
      expect(execArgv).not.toBeNull();
      expect(execArgv).toEqual([
        "sandbox",
        "exec",
        "--name",
        "alpha",
        "-g",
        "nemoclaw",
        "--tty",
        "--timeout",
        "0",
        "--",
        "/bin/bash",
        "--noprofile",
        "--norc",
        "-p",
        "-c",
        RUNTIME_ENV_EXEC_SCRIPT,
        "nemoclaw-runtime-env",
        "bash",
        "-lc",
        agentCommand,
      ]);

      // Exactly one interactive exec: launch does not re-run the agent.
      expect(harness.callLines().filter((call) => call.includes("--tty"))).toHaveLength(1);

      expect(result.code).toBe(exitCode);
    },
  );

  it(
    "reports the OpenClaw permission cleanup failure after a successful agent exec",
    testTimeoutOptions(90_000),
    () => {
      const harness = createLaunchHarness("nemoclaw-cli-launch-openclaw-cleanup-", "openclaw");

      const result = harness.runLaunch("launch alpha");

      expect(result.code).toBe(1);
      expect(result.out).toContain("OpenClaw permission cleanup failed (command exit 0");
    },
  );
});
