// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_REQUIRE_HOOK = path.join(import.meta.dirname, "helpers", "onboard-script-mocks.cjs");

describe("Hermes host config transaction wiring", () => {
  it("passes the exact read digest and serialized update to the sealed write transaction", () => {
    const rawConfig = "model:\n  default: trusted-model\n";
    const expectedDigest = createHash("sha256").update(rawConfig).digest("hex");
    const script = String.raw`
const Module = require("node:module");
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
let capturedPrivilegedExec = null;
installMock(source("runner.js"), { validateName: () => undefined, ROOT: root });
installMock(source("state", "registry.js"), {
  getSandbox: () => ({ name: "alpha", agent: "hermes" }),
});
installMock(source("agent", "defs.js"), {
  loadAgent: () => ({
    configPaths: { dir: "/sandbox/.hermes", configFile: "config.yaml", format: "yaml" },
  }),
});
installMock(source("adapters", "openshell", "client.js"), {
  captureOpenshellCommand: () => ({ status: 0, output: rawConfig }),
  runOpenshellCommand: () => ({ status: 0 }),
});
installMock(source("sandbox", "privileged-exec.js"), {
  privilegedSandboxExecArgv: (sandboxName, command, stdin, sanitizeEnvironment) => {
    capturedPrivilegedExec = { command, sanitizeEnvironment };
    return ["docker", "exec", ...(stdin ? ["-i"] : []), sandboxName, ...command];
  },
});
installMock(source("adapters", "docker", "exec.js"), {
  dockerExecFileSync: (argv, options) => {
    captured = { argv, options };
    return "updated=1\n";
  },
});

const config = require(source("sandbox", "config.js"));
const target = config.resolveAgentConfig("alpha");
const parsed = config.readSandboxConfig("alpha", target);
parsed.model.default = "trusted-model-v2";
config.writeSandboxConfig("alpha", target, parsed);
process.stdout.write(JSON.stringify({ ...captured, privilegedExec: capturedPrivilegedExec }));
`;

    const result = spawnSync(process.execPath, ["--require", SOURCE_REQUIRE_HOOK, "-e", script], {
      cwd: path.join(import.meta.dirname, ".."),
      encoding: "utf-8",
      env: { ...process.env, NODE_OPTIONS: "" },
      timeout: 5000,
    });

    expect(result.status, result.stderr).toBe(0);
    const captured = JSON.parse(result.stdout) as {
      argv: string[];
      options: { input: string; timeout: number; stdio: string[] };
      privilegedExec: { command: string[]; sanitizeEnvironment: boolean };
    };
    const digestFlag = captured.argv.indexOf("--expected-config-sha256");
    expect(captured.argv).toEqual(
      expect.arrayContaining([
        "-i",
        "timeout",
        "--signal=TERM",
        "--kill-after=5s",
        "2m",
        "/opt/hermes/.venv/bin/python",
        "-I",
        "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
        "write-config",
        "--hermes-dir",
        "/sandbox/.hermes",
        "--hash-file",
        "/etc/nemoclaw/hermes.config-hash",
        "--state-file",
        "/run/nemoclaw/hermes-restart-seal.json",
      ]),
    );
    expect(digestFlag).toBeGreaterThanOrEqual(0);
    expect(captured.argv[digestFlag + 1]).toBe(expectedDigest);
    expect(captured.options.input).toContain("default: trusted-model-v2");
    expect(captured.options.timeout).toBe(150000);
    expect(captured.options.stdio).toEqual(["pipe", "pipe", "pipe"]);
    expect(captured.privilegedExec.sanitizeEnvironment).toBe(true);
    expect(captured.privilegedExec.command).toEqual(
      expect.arrayContaining([
        "/opt/hermes/.venv/bin/python",
        "-I",
        "/usr/local/lib/nemoclaw/hermes-runtime-config-guard.py",
        "write-config",
      ]),
    );
  });
});
