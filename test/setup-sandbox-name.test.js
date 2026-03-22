// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Verify that setup.sh uses a parameterized sandbox name instead of
// hardcoding "nemoclaw". Gateway name must stay hardcoded.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/197

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

describe("setup.sh sandbox name parameterization (#197)", () => {
  const content = fs.readFileSync(path.join(ROOT, "scripts/setup.sh"), "utf-8");

  it("accepts sandbox name as $1 with default", () => {
    expect(content.includes('SANDBOX_NAME="${1:-nemoclaw}"')).toBeTruthy();
  });

  it("sandbox create uses $SANDBOX_NAME, not hardcoded", () => {
    const createLine = content.match(/openshell sandbox create.*--name\s+(\S+)/);
    expect(createLine).toBeTruthy();
    expect(
      createLine[1].includes("$SANDBOX_NAME") || createLine[1].includes('"$SANDBOX_NAME"')
    ).toBeTruthy();
  });

  it("sandbox delete uses $SANDBOX_NAME, not hardcoded", () => {
    const deleteLine = content.match(/openshell sandbox delete\s+(\S+)/);
    expect(deleteLine).toBeTruthy();
    expect(
      deleteLine[1].includes("$SANDBOX_NAME") || deleteLine[1].includes('"$SANDBOX_NAME"')
    ).toBeTruthy();
  });

  it("sandbox get uses $SANDBOX_NAME, not hardcoded", () => {
    const getLine = content.match(/openshell sandbox get\s+(\S+)/);
    expect(getLine).toBeTruthy();
    expect(
      getLine[1].includes("$SANDBOX_NAME") || getLine[1].includes('"$SANDBOX_NAME"')
    ).toBeTruthy();
  });

  it("gateway name stays hardcoded to nemoclaw", () => {
    expect(content.includes("gateway destroy -g nemoclaw")).toBeTruthy();
    expect(content.includes("--name nemoclaw")).toBeTruthy();
  });

  it("$1 arg actually sets SANDBOX_NAME in bash", () => {
    const result = execSync(
      'bash -c \'SANDBOX_NAME="${1:-nemoclaw}"; echo "$SANDBOX_NAME"\' -- my-test-box',
      { encoding: "utf-8" }
    ).trim();
    expect(result).toBe("my-test-box");
  });

  it("no arg defaults to nemoclaw in bash", () => {
    const result = execSync(
      'bash -c \'SANDBOX_NAME="${1:-nemoclaw}"; echo "$SANDBOX_NAME"\'',
      { encoding: "utf-8" }
    ).trim();
    expect(result).toBe("nemoclaw");
  });
});
