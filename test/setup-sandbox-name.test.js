// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that setup.sh uses a parameterized sandbox name instead of
// hardcoding "nemoclaw". Gateway name must stay hardcoded.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/197

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

describe("setup.sh sandbox name parameterization (#197)", () => {
  const content = fs.readFileSync(path.join(ROOT, "scripts/setup.sh"), "utf-8");

  it("accepts sandbox name as $1 with default", () => {
    assert.ok(
      content.includes('SANDBOX_NAME="${1:-nemoclaw}"'),
      'setup.sh must accept sandbox name as $1 with default "nemoclaw"'
    );
  });

  it("sandbox create uses $SANDBOX_NAME, not hardcoded", () => {
    const createLine = content.match(/openshell sandbox create.*--name\s+(\S+)/);
    assert.ok(createLine, "Could not find openshell sandbox create --name");
    assert.ok(
      createLine[1].includes("$SANDBOX_NAME") || createLine[1].includes('"$SANDBOX_NAME"'),
      `sandbox create --name must use $SANDBOX_NAME, found: ${createLine[1]}`
    );
  });

  it("sandbox delete uses $SANDBOX_NAME, not hardcoded", () => {
    const deleteLine = content.match(/openshell sandbox delete\s+(\S+)/);
    assert.ok(deleteLine, "Could not find openshell sandbox delete");
    assert.ok(
      deleteLine[1].includes("$SANDBOX_NAME") || deleteLine[1].includes('"$SANDBOX_NAME"'),
      `sandbox delete must use $SANDBOX_NAME, found: ${deleteLine[1]}`
    );
  });

  it("sandbox get uses $SANDBOX_NAME, not hardcoded", () => {
    const getLine = content.match(/openshell sandbox get\s+(\S+)/);
    assert.ok(getLine, "Could not find openshell sandbox get");
    assert.ok(
      getLine[1].includes("$SANDBOX_NAME") || getLine[1].includes('"$SANDBOX_NAME"'),
      `sandbox get must use $SANDBOX_NAME, found: ${getLine[1]}`
    );
  });

  it("gateway name stays hardcoded to nemoclaw", () => {
    assert.ok(
      content.includes("gateway destroy -g nemoclaw"),
      "gateway destroy must use hardcoded nemoclaw (gateway != sandbox)"
    );
    assert.ok(
      content.includes("--name nemoclaw"),
      "gateway start --name must use hardcoded nemoclaw"
    );
  });

  it("$1 arg actually sets SANDBOX_NAME in bash", () => {
    const result = execSync(
      'bash -c \'SANDBOX_NAME="${1:-nemoclaw}"; echo "$SANDBOX_NAME"\' -- my-test-box',
      { encoding: "utf-8" }
    ).trim();
    assert.equal(result, "my-test-box");
  });

  it("no arg defaults to nemoclaw in bash", () => {
    const result = execSync(
      'bash -c \'SANDBOX_NAME="${1:-nemoclaw}"; echo "$SANDBOX_NAME"\'',
      { encoding: "utf-8" }
    ).trim();
    assert.equal(result, "nemoclaw");
  });
});
