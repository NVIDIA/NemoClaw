// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "scripts", "telegram-bridge.js"), "utf-8");

function extractFunctionSource(source, name) {
  const signature = `function ${name}()`;
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `expected source to include ${signature}`);

  const bodyStart = source.indexOf("{", start);
  assert.notEqual(bodyStart, -1, `expected ${name} to have a function body`);

  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  assert.fail(`expected ${name}() to have balanced braces`);
}

const RESOLVE_SANDBOX_NAME_SOURCE = extractFunctionSource(SCRIPT, "resolveSandboxName");

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
