// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

// Regression coverage for #6448. The shared setup file
// test/helpers/normalize-fixture-umask.ts must force the conventional CI
// file-creation umask (0o022) in every test worker, so Hermes/OpenClaw guard
// fixtures are never created group/world-writable on a developer host with a
// permissive ambient umask (e.g. 0002). Without it, the production
// runtime-config guard fails those fixtures closed with
// `UnsafePathError: refusing group/world-writable runtime config path`.

it("pins the test worker umask to the deterministic 0o022 baseline (#6448)", () => {
  // process.umask(mask) sets the umask and returns the previous value; setting it
  // to the value the setup already installed is a no-op, and the returned
  // previous value proves the setup pinned the worker to exactly 0o022 —
  // independent of the developer's ambient umask. The exact value matters: tests
  // assert group-readable fixture modes (e.g. a Hermes .env at 0o640) that only
  // hold at 0o022.
  const previous = process.umask(0o022);
  expect(previous).toBe(0o022);
});

it("keeps in-process fixture files free of group/world write bits (#6448)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-umask-regression-"));
  try {
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(file, "model: test\n");
    expect(fs.statSync(file).mode & 0o022).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("propagates the safe umask to spawned fixture processes (#6448)", () => {
  // Guard fixtures are written by python/bash children spawned from the worker.
  // umask is inherited across spawn, so a child creating a normal file (which,
  // unlike tempfile.mkstemp, respects umask) must also produce a non
  // group/world-writable mode.
  const result = spawnSync(
    "python3",
    [
      "-c",
      [
        "import os, stat, sys, tempfile",
        "d = tempfile.mkdtemp()",
        "p = os.path.join(d, 'config.yaml')",
        "open(p, 'w', encoding='utf-8').write('model: test\\n')",
        "sys.stdout.write(str(stat.S_IMODE(os.stat(p).st_mode)))",
      ].join("\n"),
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  const mode = Number.parseInt(result.stdout.trim(), 10);
  expect(mode & 0o022).toBe(0);
});
