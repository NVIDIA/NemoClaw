// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression matrix for #5974.
 *
 * Several user-error / unknown-command surfaces historically printed correct
 * error text but returned exit 0, which breaks `$?` scriptability (a watchdog
 * or CI step wrapping `nemoclaw` could not tell the command failed). This test
 * runs the real `nemoclaw` binary against fake `openshell`/`docker` shims with
 * an isolated HOME and asserts each surface returns a non-zero exit code while
 * still surfacing its error text.
 *
 * The registry is seeded with one sandbox (`bug5974-alpha`) so the rows that
 * target the issue's *command-specific* branches (missing required `skill
 * install` path on an existing sandbox, unknown action on an existing sandbox)
 * resolve the sandbox and reach those exact branches rather than stopping at
 * the dispatcher's "sandbox does not exist" boundary. Rows that target a
 * non-existent sandbox keep the reporter's literal nonexistent-sandbox surfaces
 * (e.g. `nonexistent-sb upload file.txt`). All rows stay hermetic: the fakes
 * report no reachable gateway, so nothing contacts a live OpenShell gateway.
 *
 * The `share mount` *bad remote path* diagnostic (#3414) needs both a live
 * sandbox and a host `sshfs` binary to reach, so it cannot run hermetically
 * here; that branch is covered by the unit tests in
 * `src/lib/share-command.test.ts` and `test/share-command-remote-path.test.ts`.
 * This matrix locks the nonexistent-sandbox share/upload surfaces instead.
 *
 * Issue instance 3 (onboard dashboard-port exhaustion) is locked by its own
 * hermetic `onboard` spawn in the second describe below: it binds the whole
 * dashboard port range and drives the real `onboard` preflight to the
 * fail-fast "All dashboard ports in range … are occupied" exit, asserting a
 * non-zero code. (That preflight exits via an explicit `exitFn(1)`, so it never
 * rode the `oclif.exit === 0` catch-all this PR hardens — the spawn simply
 * proves the surface stays non-zero end-to-end.)
 *
 * Issue instance 5 (Model Router Python preflight) is the one surface left to
 * unit tests: `reconcileModelRouter` runs only deep in `onboard`, behind live
 * gateway + provider + sandbox provisioning that cannot be faked hermetically
 * here. Its Python preflight (`prepareModelRouterVenv`) throws a plain Error
 * (no `oclif.exit`, so unaffected by this PR's oclif hardening); the routed
 * branch of the provider/inference handler catches that throw and exits
 * non-zero via `exitProcess(1)` instead of letting it ride the oclif runner.
 * The error reasons are locked by `src/lib/onboard/model-router-python.test.ts`
 * (the "above supported ceiling" reason and the "No usable host Python
 * interpreter found" message), and the caught-throw → non-zero exit composition
 * is locked by `src/lib/onboard/machine/handlers/provider-inference.test.ts`
 * ("exits non-zero when model router reconciliation throws").
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testTimeoutOptions } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");
const REGISTERED = "bug5974-alpha";

describe("user-error/startup surfaces return non-zero exit (#5974)", () => {
  let home: string;
  let binDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-5974-"));
    binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    // Fake openshell: every gateway/sandbox probe fails, so recovery can never
    // resurrect a sandbox and the dispatcher's user-error boundaries decide the
    // exit code. Nothing here should ever exit 0 for a sandbox lookup.
    fs.writeFileSync(
      path.join(binDir, "openshell"),
      [
        "#!/usr/bin/env bash",
        'case "$*" in',
        "  status)",
        "    echo 'Status: Disconnected' ;",
        "    exit 1 ;;",
        "  *)",
        "    echo '' >&2 ;",
        "    exit 1 ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    // Fake docker: report a healthy daemon but no NemoClaw containers so the
    // Docker-driver gateway probe stays quiet without reaching a real daemon.
    fs.writeFileSync(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = info ]; then echo "Server Version: 24.0.0"; exit 0; fi',
        'if [ "$1" = ps ]; then exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    // Seed a single registered sandbox so the command-specific rows can resolve
    // it and reach their own validation branches.
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          [REGISTERED]: {
            name: REGISTERED,
            model: "test-model",
            provider: "test-provider",
            gpuEnabled: false,
            policies: [],
            agent: "openclaw",
          },
        },
        defaultSandbox: REGISTERED,
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCli(args: string[]): {
    status: number | null;
    signal: NodeJS.Signals | null;
    error: Error | undefined;
    combined: string;
  } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        NEMOCLAW_TEST_NO_SLEEP: "1",
        NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "2000",
      },
    });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  }

  // Each row is [label, argv, expectedSubstring]. The substring is a stable
  // fragment of the branch-specific error text, so a row that regresses to a
  // different boundary (e.g. sandbox resolution) fails the substring check as
  // well as the exit-code invariant. The hard invariant is a real positive
  // exit code from a clean process exit — see the assertions below, which
  // reject spawn failures and signal/timeout terminations so a killed process
  // (status === null) can never satisfy the "non-zero exit" claim.
  const cases: ReadonlyArray<[string, string[], string]> = [
    // Missing required arg — oclif parse error, exits before any gateway probe.
    ["credentials reset without a provider", ["credentials", "reset"], "required arg"],
    // Missing required path on an EXISTING sandbox: resolves the seeded sandbox
    // and reaches `skill install`'s own required-arg parser (issue instance 1).
    [
      `${REGISTERED} skill install without a path`,
      [REGISTERED, "skill", "install"],
      "required arg",
    ],
    // Unknown action on an EXISTING sandbox: resolves the seeded sandbox and
    // reaches the dispatcher's unknown-action branch (issue instance 2).
    [`${REGISTERED} unknown action`, [REGISTERED, "dcode", "--help"], "Unknown action: dcode"],
    // Nonexistent-sandbox surfaces (issue instance 4, literal reporter commands).
    [
      "share mount on a nonexistent sandbox",
      ["bug5974-missing-sb", "share", "mount", "/sandbox/bad-typo-path"],
      "does not exist",
    ],
    [
      "upload to a nonexistent sandbox",
      ["bug5974-missing-sb", "upload", "some-file.txt"],
      "does not exist",
    ],
  ];

  for (const [label, argv, expected] of cases) {
    it(`${label} prints an error and exits non-zero`, testTimeoutOptions(30_000), () => {
      const { status, signal, error, combined } = runCli(argv);
      // The process must have launched and exited on its own — not failed to
      // spawn and not been killed by a signal/timeout (which leaves
      // status === null and would otherwise masquerade as a "non-zero exit").
      expect(error).toBeUndefined();
      expect(signal).toBeNull();
      expect(combined.trim().length).toBeGreaterThan(0);
      expect(combined).toContain(expected);
      expect(status).toBeGreaterThan(0);
    });
  }

  // PRA-1 (#5974): exercise the NATIVE oclif argv route end-to-end through the
  // real binary. `dispatchCli` sends a leading `sandbox`/`internal` token
  // straight to `runOclifArgv` (src/lib/cli/oclif-runner.ts) — distinct from
  // the by-id dispatcher used by the rows above — so these two cases lock both
  // directions of that route:
  //   - a native parse/user-error route prints oclif's formatted error and
  //     exits non-zero (the hardening this PR adds to the native path), and
  //   - a native help route stays a clean exit 0 — a genuine ExitError(0) that
  //     the hardening must NOT over-correct (the spawned-CLI counterpart to the
  //     ExitError(0) unit test in src/lib/cli/oclif-runner.test.ts).
  // Both resolve at oclif's command lookup, before any gateway probe, so they
  // stay hermetic under the fakes above.
  it(
    "a native-route user error prints oclif's error and exits non-zero (#5974)",
    testTimeoutOptions(30_000),
    () => {
      const { status, signal, error, combined } = runCli(["sandbox", "bogus-subcmd"]);
      expect(error).toBeUndefined();
      expect(signal).toBeNull();
      expect(combined).toContain("not found");
      expect(status).toBeGreaterThan(0);
    },
  );

  it("a native-route --help stays a clean exit 0 (#5974)", testTimeoutOptions(30_000), () => {
    const { status, signal, error, combined } = runCli(["sandbox", "--help"]);
    expect(error).toBeUndefined();
    expect(signal).toBeNull();
    expect(combined).toContain("USAGE");
    expect(status).toBe(0);
  });
});

// Issue #5974 instance 3: `nemoclaw onboard …` printed "All dashboard ports in
// range … are occupied" but the reporter saw exit 0. The onboard preflight
// fails fast here via an explicit process.exit(1), so it was never affected by
// the oclif.exit === 0 catch-all this PR hardens — this spawn locks the
// end-to-end non-zero exit so the surface cannot silently regress to 0.
describe("onboard dashboard-port exhaustion exits non-zero (#5974)", () => {
  const PORT_RANGE_START = 18789;
  const PORT_RANGE_END = 18799;
  let home: string;
  let binDir: string;
  let servers: net.Server[];

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-5974-onboard-"));
    binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    // Fake openshell: report a supported version and embed the capability
    // markers the installer greps for with `strings`, so onboard's preflight
    // neither attempts a network reinstall nor fails the credential-rewrite
    // capability gate before it reaches the dashboard-port check.
    fs.writeFileSync(
      path.join(binDir, "openshell"),
      [
        "#!/usr/bin/env bash",
        "# openshell capabilities: request-body-credential-rewrite websocket-credential-rewrite",
        'case "$1" in',
        '  --version) echo "openshell 0.0.44"; exit 0;;',
        "esac",
        "echo '' >&2",
        "exit 1",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        'if [ "$1" = info ]; then echo "Server Version: 24.0.0"; exit 0; fi',
        'if [ "$1" = ps ]; then exit 0; fi',
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );

    // Occupy the entire dashboard port range so the preflight has no free port.
    servers = [];
    const ports = Array.from(
      { length: PORT_RANGE_END - PORT_RANGE_START + 1 },
      (_unused, i) => PORT_RANGE_START + i,
    );
    await Promise.all(
      ports.map(
        (port) =>
          new Promise<void>((resolve) => {
            const server = net.createServer();
            server.once("error", () => resolve());
            server.listen(port, "127.0.0.1", () => {
              servers.push(server);
              resolve();
            });
          }),
      ),
    );
  });

  afterEach(() => {
    for (const server of servers) server.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("prints the canonical message and exits non-zero", testTimeoutOptions(60_000), () => {
    const result = spawnSync(
      process.execPath,
      [CLI, "onboard", "--name", "port-test", "--no-gpu", "--non-interactive"],
      {
        encoding: "utf-8",
        timeout: 55_000,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binDir}:${process.env.PATH || ""}`,
          NEMOCLAW_TEST_NO_SLEEP: "1",
          NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "2000",
          NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
        },
      },
    );
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(combined).toContain(
      `All dashboard ports in range ${PORT_RANGE_START}-${PORT_RANGE_END} are occupied`,
    );
    expect(result.status).toBeGreaterThan(0);
  });
});
