// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression for #9104.
 *
 * `readSandboxConfig` runs `openshell sandbox exec -- cat <configPath>` and, on
 * a failed exec, raises a diagnostic carrying the reason OpenShell reported.
 * That diagnostic was raised inside a `try` whose `catch` discarded every
 * error, so the reason never reached the user: every failed read reported the
 * generic "Is the sandbox running?" text instead. A reporter watching a Ready
 * sandbox was told it was not running.
 *
 * These tests drive the real read path — real `spawnSync`, real
 * `captureOpenshellCommand` — against a stub OpenShell binary selected through
 * `NEMOCLAW_OPENSHELL_BIN`, so they fail if the reason is discarded again.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_AGENT_CONFIG,
  readSandboxConfig,
  SandboxConfigError,
} from "../../../src/lib/sandbox/config";

const EXEC_FAILURE_REASON = "exec session setup failed: container not ready";

let home: string;

/**
 * Install a stub `openshell` whose `sandbox exec` fails, writing `stderr` to
 * stderr and `stdout` to stdout — the two channels the diagnostic chooses
 * between.
 */
function stubOpenshell(stderr: string, stdout = ""): void {
  const binary = path.join(home, "openshell");
  fs.writeFileSync(
    binary,
    [
      "#!/usr/bin/env bash",
      `printf '%s' ${JSON.stringify(stdout)}`,
      `printf '%s' ${JSON.stringify(stderr)} >&2`,
      "exit 1",
    ].join("\n"),
    { mode: 0o755 },
  );
  vi.stubEnv("NEMOCLAW_OPENSHELL_BIN", binary);
}

/** Read the config and return the diagnostic lines the CLI would print. */
function readAndCaptureLines(): string {
  const error = (() => {
    try {
      readSandboxConfig("alpha", DEFAULT_AGENT_CONFIG);
      return null;
    } catch (thrown) {
      return thrown;
    }
  })();

  expect(error).toBeInstanceOf(SandboxConfigError);
  return (error as SandboxConfigError).lines.join("\n");
}

describe("failed sandbox config reads report OpenShell failures (#9104)", () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-9104-"));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("reports the reason OpenShell gave for the failed read", () => {
    stubOpenshell(EXEC_FAILURE_REASON);

    const lines = readAndCaptureLines();

    // The operator needs the actual reason to act on: the read failed because
    // the exec session could not be set up, not because the sandbox is stopped.
    expect(lines).toContain(EXEC_FAILURE_REASON);
    expect(lines).toContain("Cannot read openclaw config (/sandbox/.openclaw/openclaw.json)");
  });

  it("does not blame a stopped sandbox when OpenShell reported another reason", () => {
    stubOpenshell(EXEC_FAILURE_REASON);

    const lines = readAndCaptureLines();

    // #9104: the sandbox was Ready. Claiming otherwise sends the operator to
    // the wrong remedy, and `readInSandboxConfigOrFail` appends "Start the
    // sandbox and retry." to any message carrying this question.
    expect(lines).not.toContain("Is the sandbox running?");
  });

  it("keeps the stopped-sandbox question when OpenShell reported no reason", () => {
    stubOpenshell("");

    const lines = readAndCaptureLines();

    // With nothing to report, the stopped sandbox stays the best guess — this
    // is the pre-existing text and it must survive the fix above.
    expect(lines).toContain("Is the sandbox running?");
  });

  it("never echoes the partial config a failed read printed", () => {
    // A read that fails partway still puts config bytes on stdout. Those bytes
    // are the agent config, so the diagnostic must come from stderr alone.
    stubOpenshell("", '{"agents":{"apiKey":"sk-secret-9104"}}');

    const lines = readAndCaptureLines();

    expect(lines).not.toContain("sk-secret-9104");
    expect(lines).toContain("Is the sandbox running?");
  });
});
