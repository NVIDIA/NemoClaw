// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "scripts", "telegram-bridge.js"), "utf-8");
const RESOLVE_SANDBOX_NAME_SOURCE = SCRIPT.match(/function resolveSandboxName\(\) \{[\s\S]*?\n\}/)?.[0];

function resolveSandboxNameWith({ env = {}, registryDefault, registryThrows = false } = {}) {
  assert.ok(RESOLVE_SANDBOX_NAME_SOURCE, "expected telegram bridge to define resolveSandboxName()");

  const processStub = { env: { ...env } };
  const requireStub = (specifier) => {
    if (specifier !== "../bin/lib/registry") {
      throw new Error(`unexpected require: ${specifier}`);
    }
    if (registryThrows) {
      throw new Error("registry unavailable");
    }
    return { getDefault: () => registryDefault };
  };

  const resolveSandboxName = new Function(
    "process",
    "require",
    `${RESOLVE_SANDBOX_NAME_SOURCE}\nreturn resolveSandboxName;`,
  )(processStub, requireStub);

  return resolveSandboxName();
}

describe("telegram bridge sandbox resolution", () => {
  it("prefers SANDBOX_NAME when explicitly set", () => {
    assert.equal(
      resolveSandboxNameWith({
        env: { SANDBOX_NAME: "from-env" },
        registryDefault: "from-registry",
      }),
      "from-env",
    );
  });

  it("reads the default sandbox from the registry when env is unset", () => {
    assert.equal(
      resolveSandboxNameWith({ registryDefault: "from-registry" }),
      "from-registry",
    );
  });

  it("falls back to my-assistant when no explicit or registered sandbox exists", () => {
    assert.equal(
      resolveSandboxNameWith({ registryThrows: true }),
      "my-assistant",
    );
  });
});
