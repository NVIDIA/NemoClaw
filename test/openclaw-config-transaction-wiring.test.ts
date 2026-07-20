// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_REQUIRE_HOOK = path.join(import.meta.dirname, "helpers", "onboard-script-mocks.cjs");

describe("OpenClaw host config transaction wiring", () => {
  it("keeps internal generated writes CAS-only without requiring runtime schema validation", () => {
    const rawConfig = '{"agents":{"defaults":{"model":{"primary":"inference/old"}}}}\n';
    const expectedDigest = createHash("sha256").update(rawConfig).digest("hex");
    const script = String.raw`
const Module = require("node:module");
const crypto = require("node:crypto");
const path = require("node:path");
const root = process.cwd();
const source = (...parts) => "./" + path.join("src", "lib", ...parts);
function installMock(filename, exports) {
  const resolved = require.resolve(filename);
  const replacement = new Module(resolved);
  replacement.filename = resolved;
  replacement.loaded = true;
  replacement.exports = exports;
  require.cache[resolved] = replacement;
}

const rawConfig = ${JSON.stringify(rawConfig)};
let captured = null;
let validatorCalls = 0;
installMock(source("runner.js"), { validateName: () => undefined, ROOT: root });
installMock(source("state", "registry.js"), {
  getSandbox: () => ({ name: "alpha", agent: "openclaw" }),
});
installMock(source("agent", "defs.js"), {
  loadAgent: () => ({
    configPaths: { dir: "/sandbox/.openclaw", configFile: "openclaw.json", format: "json" },
  }),
});
installMock(source("adapters", "openshell", "client.js"), {
  captureOpenshellCommand: () => ({ status: 0, output: rawConfig }),
  runOpenshellCommand: () => ({ status: 0 }),
});
installMock(source("shields", "openclaw-config-lock.js"), {
  validateOpenClawConfigCandidate: () => {
    validatorCalls += 1;
    return [];
  },
  runOpenClawConfigGuard: (_privileged, action, options) => {
    captured = { action, options };
    return {
      issues: [],
      chattrApplied: false,
      configSha256: crypto.createHash("sha256").update(options.input).digest("hex"),
    };
  },
});

const config = require(source("sandbox", "config.js"));
const target = config.resolveAgentConfig("alpha");
const parsed = config.readSandboxConfig("alpha", target);
parsed.agents.defaults.model.primary = "inference/new";
config.writeSandboxConfig("alpha", target, parsed);
process.stdout.write(JSON.stringify({ captured, validatorCalls }));
`;

    const result = spawnSync(process.execPath, ["--require", SOURCE_REQUIRE_HOOK, "-e", script], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    const proof = JSON.parse(result.stdout) as {
      captured: { action: string; options: { expectedConfigSha256: string; input: string } };
      validatorCalls: number;
    };
    expect(proof.validatorCalls).toBe(0);
    expect(proof.captured.action).toBe("write-config");
    expect(proof.captured.options.expectedConfigSha256).toBe(expectedDigest);
    expect(proof.captured.options.input).toContain('"primary": "inference/new"');
  });
});
