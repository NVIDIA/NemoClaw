// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("telegram bridge banner", () => {
  it("reads the model from the sandbox registry instead of hardcoding it", () => {
    // The banner source should reference registry.getSandbox, not a hardcoded model string
    const bridgeSrc = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "telegram-bridge.js"),
      "utf-8",
    );

    // Must import and use the registry
    assert.match(bridgeSrc, /require\(.*registry.*\)/, "should import the registry module");
    assert.match(bridgeSrc, /getSandbox/, "should call getSandbox to look up the model");

    // The banner Model line must use a variable, not a hardcoded model name
    const bannerLines = bridgeSrc.split("\n").filter((l) => l.includes("Model:") && l.includes("│"));
    assert.ok(bannerLines.length > 0, "should have a Model banner line");
    for (const line of bannerLines) {
      assert.doesNotMatch(
        line,
        /["'].*nemotron.*["']/,
        "Model banner line should not contain a hardcoded model string literal",
      );
    }
  });
});
