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
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

  function runCli(args: string[]): { code: number; combined: string } {
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
      code: result.status ?? -1,
      combined: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    };
  }

  // Each row is [label, argv, expectedSubstring]. The substring is a stable
  // fragment of the branch-specific error text, so a row that regresses to a
  // different boundary (e.g. sandbox resolution) fails the substring check as
  // well as the exit-code invariant. The hard invariant is the non-zero exit.
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
      const { code, combined } = runCli(argv);
      expect(combined.trim().length).toBeGreaterThan(0);
      expect(combined).toContain(expected);
      expect(code).not.toBe(0);
    });
  }
});
