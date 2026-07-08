// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Coverage for the dcode wrapper (agents/langchain-deepagents-code/dcode-wrapper.sh)
// empty-prompt guard (#5752): `dcode -n ""` and whitespace-only `-n` prompts must
// fail fast with a non-zero exit and never launch Deep Agents Code, instead of
// running a task or dropping into the interactive TUI.
//
// The test patches only the copied wrapper's isolated interpreter path and
// managed PATH so it can exercise the same Bash contract on every host with
// Bash and Python 3 available.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadAgent } from "../src/lib/agent/defs";

const AGENT_DIR = path.join(import.meta.dirname, "..", "agents", "langchain-deepagents-code");
const WRAPPER = path.join(AGENT_DIR, "dcode-wrapper.sh");
const EMPTY_PROMPT_DIAGNOSTIC =
  "NemoClaw: empty non-interactive prompt for -n; provide prompt text.";

function wrapperFixtureCanRun(): boolean {
  try {
    return (
      spawnSync("bash", ["--version"], { timeout: 5000 }).status === 0 &&
      spawnSync("python3", ["--version"], { timeout: 5000 }).status === 0
    );
  } catch {
    return false;
  }
}
const canRun = wrapperFixtureCanRun();

type WrapperRun = {
  status: number | null;
  stderr: string;
  launched: boolean;
  launchArgs: string;
};

// Run the wrapper against a temp install: a copy of the wrapper plus a stub
// `python3` that records the argv it was launched with. A recorded marker proves
// the wrapper passed through; its absence proves the wrapper refused first.
function runWrapper(args: string[]): WrapperRun {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-wrapper-"));
  try {
    const marker = path.join(dir, "launched.txt");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const wrapperSource = fs.readFileSync(WRAPPER, "utf-8");
    const wrapperFixture = wrapperSource
      .replace(
        /export PATH="([^"]*)"/,
        (_match, managedPath: string) => `export PATH=${JSON.stringify(`${bin}:${managedPath}`)}`,
      )
      .replaceAll("/opt/venv/bin/python3 -I", "python3 -I");
    expect(wrapperFixture).not.toBe(wrapperSource);
    fs.writeFileSync(path.join(dir, "dcode"), wrapperFixture, { mode: 0o755 });

    fs.writeFileSync(
      path.join(bin, "python3"),
      `#!/usr/bin/env bash\nprintf '%s' "$*" > ${JSON.stringify(marker)}\nexit 0\n`,
      { mode: 0o755 },
    );

    const result = spawnSync("bash", [path.join(dir, "dcode"), ...args], {
      encoding: "utf-8",
      timeout: 10000,
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: dir },
    });

    const launched = fs.existsSync(marker);
    return {
      status: result.status,
      stderr: result.stderr ?? "",
      launched,
      launchArgs: launched ? fs.readFileSync(marker, "utf-8") : "",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const REJECT_CASES: Array<{ label: string; args: string[] }> = [
  { label: '-n ""', args: ["-n", ""] },
  { label: '-n "   " (whitespace only)', args: ["-n", "   "] },
  { label: "-n $'\\t' (tab only)", args: ["-n", "\t"] },
  { label: '--non-interactive ""', args: ["--non-interactive", ""] },
  { label: "--non-interactive= (empty attached value)", args: ["--non-interactive="] },
  { label: '--non-interactive="  " (whitespace attached value)', args: ["--non-interactive=  "] },
  { label: '-q -n "" (flag before empty prompt)', args: ["-q", "-n", ""] },
  // A non-blank first prompt must not let a later blank one through (#5752 review).
  {
    label: '-n "ok" --non-interactive="" (later attached value blank)',
    args: ["-n", "ok", "--non-interactive="],
  },
  { label: '-n "ok" -n "" (repeated flag, later value blank)', args: ["-n", "ok", "-n", ""] },
];

describe.skipIf(!canRun)(
  "agents/langchain-deepagents-code/dcode-wrapper.sh empty prompt (#5752)",
  () => {
    for (const { label, args } of REJECT_CASES) {
      it(`refuses ${label} with exit 2 and never launches dcode`, () => {
        const run = runWrapper(args);

        expect(run.status).toBe(2);
        expect(run.stderr).toContain("empty non-interactive prompt");
        expect(run.launched).toBe(false);
      });
    }

    it("passes a real -n prompt through to dcode with managed flags", () => {
      const run = runWrapper(["-n", "list the files"]);

      expect(run.status).toBe(0);
      expect(run.launched).toBe(true);
      expect(run.launchArgs).toContain("-m deepagents_code");
      expect(run.launchArgs).toContain("--sandbox none --no-mcp");
      expect(run.launchArgs).toContain("-n list the files");
    });

    it("passes an attached -nPROMPT form through to dcode", () => {
      const run = runWrapper(["-nhello"]);

      expect(run.status).toBe(0);
      expect(run.launched).toBe(true);
      expect(run.launchArgs).toContain("-nhello");
    });

    it("does not re-examine an -n value that looks like a flag", () => {
      const run = runWrapper(["-n", "-n"]);

      expect(run.status).toBe(0);
      expect(run.launched).toBe(true);
    });

    it("launches the interactive UI unchanged when no prompt flag is given", () => {
      const run = runWrapper([]);

      expect(run.status).toBe(0);
      expect(run.launched).toBe(true);
      expect(run.stderr).not.toContain("empty non-interactive prompt");
    });
  },
);

describe.skipIf(!canRun)("Deep Agents Code empty-prompt acceptance contract (#6440)", () => {
  it("fails closed when the terminal smoke sees the wrong status", () => {
    const smokeCommand = loadAgent("langchain-deepagents-code").runtime?.smoke_commands?.find(
      (command) => command.includes("NEMOCLAW_DCODE_EMPTY_PROMPT_OK"),
    );
    expect(smokeCommand).toBeDefined();
    if (!smokeCommand) throw new Error("missing empty-prompt smoke command");

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-smoke-"));
    const binDir = path.join(tempDir, "bin");
    fs.mkdirSync(binDir);
    fs.writeFileSync(
      path.join(binDir, "dcode"),
      '#!/bin/sh\nprintf \'%s\\n\' "$DCODE_STUB_OUTPUT" >&2\nexit "$DCODE_STUB_STATUS"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(binDir, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', {
      mode: 0o755,
    });
    const runSmoke = (status: string, output: string) =>
      spawnSync("sh", ["-c", smokeCommand], {
        encoding: "utf8",
        env: {
          PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          DCODE_STUB_OUTPUT: output,
          DCODE_STUB_STATUS: status,
        },
      });

    try {
      const accepted = runSmoke("2", EMPTY_PROMPT_DIAGNOSTIC);
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toBe("NEMOCLAW_DCODE_EMPTY_PROMPT_OK\n");
      expect(runSmoke("0", EMPTY_PROMPT_DIAGNOSTIC).status).not.toBe(0);
      expect(runSmoke("2", "wrong diagnostic").status).not.toBe(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
