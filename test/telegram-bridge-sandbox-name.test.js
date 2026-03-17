// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "scripts", "telegram-bridge.js"), "utf-8");

describe("telegram bridge sandbox resolution", () => {
  it("does not hardcode nemoclaw as the default sandbox", () => {
    assert.ok(
      !SCRIPT.includes('process.env.SANDBOX_NAME || "nemoclaw"'),
      'telegram bridge must not default SANDBOX_NAME to "nemoclaw"'
    );
  });

  it("reads the default sandbox from the registry", () => {
    assert.ok(
      SCRIPT.includes("registry.getDefault()"),
      "telegram bridge must read the default sandbox from the registry"
    );
  });

  it("falls back to my-assistant when no explicit or registered sandbox exists", () => {
    assert.ok(
      SCRIPT.includes('return "my-assistant";'),
      'telegram bridge must fall back to "my-assistant"'
    );
  });
});
