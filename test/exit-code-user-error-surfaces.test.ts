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
 * Surfaces are kept hermetic on purpose: the fakes report no reachable gateway
 * and no sandbox, so registry recovery finds nothing and the dispatcher's
 * "unknown command / sandbox does not exist / missing argument" boundaries are
 * exercised without contacting a live OpenShell gateway.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testTimeoutOptions } from "./helpers/timeouts";

const CLI = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

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

    // Empty registry: no sandboxes are known on disk.
    const registryDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify({ sandboxes: {}, defaultSandbox: null }),
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
  // fragment of the existing user-facing error text; the hard invariant is the
  // non-zero exit code.
  const cases: ReadonlyArray<[string, string[], string]> = [
    ["credentials reset with no provider", ["credentials", "reset"], "required arg"],
    ["skill install with no path", ["bug5974-sb", "skill", "install"], "does not exist"],
    ["unknown sandbox action", ["bug5974-da-sb", "dcode", "--help"], "Unknown command"],
    [
      "share mount on a nonexistent sandbox",
      ["bug5974-sb", "share", "mount", "/sandbox/bad-typo-path"],
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
