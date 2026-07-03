// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Co-located NON-test helper (deliberately not *.test.ts) for the fake-curl
// probe harness duplicated across onboard-probes.test.ts. Centralizing the
// shared boilerplate here keeps the branching out of the test file so the
// codebase-growth-guardrails "if count" for *.test.ts stays flat; see PR
// #5975 review note PRA-9.

// Placeholder tokens a fake-curl body may reference; withFakeCurlProbe swaps
// them for the real absolute paths just before writing the script, so bodies
// can be built before the temp dir exists. The written bash therefore contains
// the exact interpolated paths the tests used before this extraction.
export const HARNESS_COUNTER = "__HARNESS_COUNTER__";
export const HARNESS_TMPDIR = "__HARNESS_TMPDIR__";

// The exact `-o outfile`/`-w` arg-parsing header the standard fake curls share.
// The body logic passed by each call site is appended verbatim after this loop.
const FAKE_CURL_HEADER = `#!/usr/bin/env bash
outfile=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) outfile="$2"; shift 2 ;;
    -w) shift 2 ;;
    *) shift ;;
  esac
done
`;

// Build a full fake `curl` bash script from the shared shebang + `-o`/`-w`
// arg-parsing while-loop followed by the caller's unique body logic.
export function makeFakeCurlScript(bodyLogic: string): string {
  return `${FAKE_CURL_HEADER}${bodyLogic}`;
}

// Restore an env var to its pre-test value without branching at the call
// site (kept identical to the helper the test file uses so restore semantics
// are unchanged).
function restoreEnv(name: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

type FakeCurlProbeContext = {
  lines: string[];
  counter: string;
  tmpDir: string;
  fakeBin: string;
};

// Run `run` with a fake `curl` on PATH backed by `script`. Creates a temp dir
// (mkdtemp using dirPrefix, default "nemoclaw-probe-"), a `bin/curl` at mode
// 0755, a "counter" file seeded with "0", sets PATH + NEMOCLAW_TEST_NO_SLEEP,
// captures console.log into `lines`, and in `finally` restores console.log,
// PATH, NEMOCLAW_TEST_NO_SLEEP, and removes the temp dir. Any HARNESS_COUNTER /
// HARNESS_TMPDIR placeholders in `script` are replaced with the real absolute
// paths before the script is written. Returns run()'s value.
export function withFakeCurlProbe<T>(
  opts: { script: string; dirPrefix?: string },
  run: (ctx: FakeCurlProbeContext) => T,
): T {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), opts.dirPrefix ?? "nemoclaw-probe-"));
  const fakeBin = path.join(tmpDir, "bin");
  const counter = path.join(tmpDir, "counter");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(counter, "0");
  const script = opts.script
    .split(HARNESS_COUNTER)
    .join(counter)
    .split(HARNESS_TMPDIR)
    .join(tmpDir);
  fs.writeFileSync(path.join(fakeBin, "curl"), script, { mode: 0o755 });

  const originalPath = process.env.PATH;
  const originalNoSleep = process.env.NEMOCLAW_TEST_NO_SLEEP;
  const originalLog = console.log;
  const lines: string[] = [];
  process.env.PATH = `${fakeBin}:${originalPath || ""}`;
  process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
  console.log = (...args) => lines.push(args.join(" "));
  try {
    return run({ lines, counter, tmpDir, fakeBin });
  } finally {
    console.log = originalLog;
    process.env.PATH = originalPath;
    restoreEnv("NEMOCLAW_TEST_NO_SLEEP", originalNoSleep);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
