// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const helper = process.env.NEMOCLAW_TEST_TRANSACTION_HELPER;
const skip =
  process.platform !== "win32" || !helper
    ? "Requires a compiled Windows MSI helper with msi-boundary-fixture enabled"
    : false;

test("compiled helper preserves redirected fixture output", { skip }, () => {
  assert.ok(helper);
  const result = spawnSync(helper, ["--fixture-identify"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 8192,
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "NEMOCLAW_MSI_FIXTURE_COMMIT_FAILURE_V1");
  assert.equal(result.stderr, "");
});

test(
  "compiled helper preserves an invalid-command failure without an MSI operation",
  { skip },
  () => {
    assert.ok(helper);
    const result = spawnSync(helper, ["--invalid-process-control"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 8192,
      windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 120);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr.trim(),
      "NemoClaw runtime maintenance failed: The native MSI transaction command is invalid.",
    );
  },
);
