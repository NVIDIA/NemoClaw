// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  BREV_MESSAGING_COMPAT_TIMEOUT_MS,
  BREV_MESSAGING_PROVIDER_TIMEOUT_MS,
  BREV_REMOTE_WRAPPER_GRACE_MS,
  BREV_SECURITY_SUITE_TIMEOUT_MS,
  BREV_WORKFLOW_OWNERSHIP_ENV,
  brevSuiteHarnessSandboxName,
  brevSuiteNeedsHarnessSandbox,
  brevWorkflowOwnsInstance,
  buildBrevRemoteVitestCommand,
} from "../tools/e2e/brev-remote-vitest.mts";

const TARGET = "test/e2e/live/credential-sanitization.test.ts";

type Fixture = {
  fakeBin: string;
  fixtureVitest: string;
  npmLog: string;
  root: string;
  vitestLog: string;
};

function writeExecutable(target: string, source: string): void {
  fs.writeFileSync(target, source, { mode: 0o755 });
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-brev-vitest-"));
  const fakeBin = path.join(root, "fake-bin");
  const fixtureVitest = path.join(root, "fixture-vitest");
  const npmLog = path.join(root, "npm.log");
  const vitestLog = path.join(root, "vitest.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(
    fixtureVitest,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf 'env=%s\\n' "\${NEMOCLAW_RUN_LIVE_E2E:-}" >> "$VITEST_LOG"`,
      `printf 'arg=%s\\n' "$@" >> "$VITEST_LOG"`,
      "",
    ].join("\n"),
  );
  writeExecutable(
    path.join(fakeBin, "npm"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$*" >> "$NPM_LOG"`,
      "mkdir -p node_modules/.bin",
      `cp "$FIXTURE_VITEST" node_modules/.bin/vitest`,
      "chmod +x node_modules/.bin/vitest",
      "",
    ].join("\n"),
  );
  return { fakeBin, fixtureVitest, npmLog, root, vitestLog };
}

function runRemoteCommand(fixture: Fixture) {
  return spawnSync("bash", ["-c", buildBrevRemoteVitestCommand("e2e-live", TARGET)], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIXTURE_VITEST: fixture.fixtureVitest,
      NPM_LOG: fixture.npmLog,
      PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
      VITEST_LOG: fixture.vitestLog,
    },
  });
}

function expectedVitestLog(): string {
  return [
    "env=1",
    "arg=run",
    "arg=--project",
    "arg=e2e-live",
    `arg=${TARGET}`,
    "arg=--silent=false",
    "arg=--reporter=default",
    "",
  ].join("\n");
}

describe("Brev remote Vitest command", () => {
  it("leaves each messaging target inside the fresh-instance job budget", () => {
    expect(BREV_SECURITY_SUITE_TIMEOUT_MS).toBe(20 * 60_000);
    expect(BREV_MESSAGING_PROVIDER_TIMEOUT_MS).toBe(70 * 60_000);
    expect(BREV_MESSAGING_COMPAT_TIMEOUT_MS).toBe(40 * 60_000);
    expect(BREV_REMOTE_WRAPPER_GRACE_MS).toBe(120_000);
  });

  it("recognizes workflow ownership only from the explicit sentinel", () => {
    expect(BREV_WORKFLOW_OWNERSHIP_ENV).toBe("NEMOCLAW_BREV_WORKFLOW_OWNS_INSTANCE");
    expect(brevWorkflowOwnsInstance({ NEMOCLAW_BREV_WORKFLOW_OWNS_INSTANCE: "1" })).toBe(true);
    expect(brevWorkflowOwnsInstance({ NEMOCLAW_BREV_WORKFLOW_OWNS_INSTANCE: "0" })).toBe(false);
    expect(brevWorkflowOwnsInstance({})).toBe(false);
  });

  it("does not seed shared harness state for suites that own their sandbox lifecycle", () => {
    expect(brevSuiteNeedsHarnessSandbox("all")).toBe(false);
    expect(brevSuiteNeedsHarnessSandbox("full")).toBe(false);
    expect(brevSuiteNeedsHarnessSandbox("gpu")).toBe(false);
    expect(brevSuiteNeedsHarnessSandbox("messaging-compatible-endpoint")).toBe(false);
    expect(brevSuiteNeedsHarnessSandbox("messaging-providers")).toBe(false);
    expect(brevSuiteHarnessSandboxName("all")).toBeUndefined();
    expect(brevSuiteHarnessSandboxName("messaging-compatible-endpoint")).toBeUndefined();
    expect(brevSuiteHarnessSandboxName("messaging-providers")).toBeUndefined();
  });

  it("preserves harness onboarding for single-target suites", () => {
    expect(brevSuiteNeedsHarnessSandbox("credential-sanitization")).toBe(true);
    expect(brevSuiteNeedsHarnessSandbox("telegram-injection")).toBe(true);
    expect(brevSuiteNeedsHarnessSandbox("dashboard-remote-bind")).toBe(true);
    expect(brevSuiteHarnessSandboxName("dashboard-remote-bind")).toBe("e2e-test");
  });

  it("uses the repository-local Vitest binary without invoking a package runner", () => {
    const fixture = createFixture();
    try {
      const localVitest = path.join(fixture.root, "node_modules/.bin/vitest");
      fs.mkdirSync(path.dirname(localVitest), { recursive: true });
      fs.copyFileSync(fixture.fixtureVitest, localVitest);
      fs.chmodSync(localVitest, 0o755);

      const result = runRemoteCommand(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(fixture.npmLog)).toBe(false);
      expect(fs.readFileSync(fixture.vitestLog, "utf8")).toBe(expectedVitestLog());
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it("restores the lockfile graph when a prior suite prunes Vitest", () => {
    const fixture = createFixture();
    try {
      const result = runRemoteCommand(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(fixture.npmLog, "utf8")).toBe(
        "ci --ignore-scripts --no-audit --no-fund\n",
      );
      expect(fs.readFileSync(fixture.vitestLog, "utf8")).toBe(expectedVitestLog());
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
