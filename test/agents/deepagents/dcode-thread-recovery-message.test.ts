// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  cleanupPackageFixtures,
  createPackageFixture,
  createPatchedPackageFixture,
  patcher,
  patchFixture,
} from "../../helpers/langchain-deepagents-code-patch-fixture";

afterEach(cleanupPackageFixtures);

it("explains how to recover a thread locked after browser refresh (#14320)", () => {
  const fixture = createPackageFixture();
  patchFixture(fixture);
  patchFixture(fixture);
  const result = execFileSync(
    "python3",
    [
      "-c",
      `from pathlib import Path
from deepagents_code import thread_ownership as ownership
try:
    ownership.ensure_owned("original-thread", db_path=Path("/threads"))
except ownership.ThreadOwnershipError as error:
    print(str(error))
else:
    raise AssertionError("occupied thread was accepted")
lease = object()
ownership.try_acquire = lambda *args, **kwargs: lease
assert ownership.ensure_owned("available-thread", db_path=Path("/threads")) is lease
`,
    ],
    { env: { PATH: process.env.PATH, PYTHONPATH: fixture }, encoding: "utf8" },
  );
  expect(result.trim()).toBe(
    "Thread original-thread is still open in another Deep Code session. " +
      "Close that session and try again. " +
      "If this started after refreshing your browser, restart the sandbox to release it.",
  );
});

const originalMessage = 'f"Thread {thread_id} is open elsewhere. Close it there to resume."';
it.each([
  {
    scenario: "missing",
    makeFixture: createPackageFixture,
    before: originalMessage,
    after: '"changed upstream"',
  },
  {
    scenario: "duplicate",
    makeFixture: createPackageFixture,
    before: originalMessage,
    after: `${originalMessage} + ${originalMessage}`,
  },
  {
    scenario: "stale",
    makeFixture: createPatchedPackageFixture,
    before: "restart the sandbox",
    after: "refresh the browser",
  },
])(
  "rejects a $scenario ownership message without writing package files (#14320)",
  ({ makeFixture, before, after }) => {
    const fixture = makeFixture();
    const file = path.join(fixture, "deepagents_code/thread_ownership.py");
    const source = fs.readFileSync(file, "utf8");
    const changed = source.replace(before, after);
    fs.writeFileSync(file, changed);
    const main = path.join(fixture, "deepagents_code/main.py");
    const originalMain = fs.readFileSync(main, "utf8");
    const result = spawnSync("python3", [patcher], {
      env: { PATH: process.env.PATH, PYTHONPATH: fixture },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/thread.ownership|ownership resume message/);
    expect(fs.readFileSync(file, "utf8")).toBe(changed);
    expect(fs.readFileSync(main, "utf8")).toBe(originalMain);
  },
);
