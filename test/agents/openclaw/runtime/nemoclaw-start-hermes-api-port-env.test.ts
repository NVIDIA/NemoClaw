// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { extractShellFunctionFromSource } from "../../../support/shell-function-extractor";

const START_SCRIPT = path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh");

/**
 * Emit the shared connect/exec runtime env file from the real
 * `write_runtime_shell_env` body. The function pipes into
 * `emit_sandbox_sourced_file`, so the test supplies a plain redirect for that
 * helper and retargets the fixed proxy-env path at a temp file.
 */
function emitRuntimeShellEnv(env: Readonly<Record<string, string>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-api-port-env-"));
  const target = path.join(dir, "runtime-env.sh");
  const scriptPath = path.join(dir, "run.sh");
  const source = fs.readFileSync(START_SCRIPT, "utf8");
  const body = extractShellFunctionFromSource(source, "write_runtime_shell_env").replaceAll(
    "/tmp/nemoclaw-proxy-env.sh",
    target,
  );
  const script = [
    "set -eo pipefail",
    'emit_sandbox_sourced_file() { local target="$1"; cat > "$target"; }',
    body,
    `export _PROXY_URL='http://127.0.0.1:3128' _NO_PROXY_VAL='127.0.0.1,localhost'`,
    ...Object.entries(env).map(([name, value]) => `export ${name}='${value}'`),
    "write_runtime_shell_env",
  ].join("\n");
  fs.writeFileSync(scriptPath, script);

  try {
    const result = spawnSync("bash", [scriptPath], { encoding: "utf8", timeout: 15000 });
    expect(result.status, result.stderr).toBe(0);
    return fs.readFileSync(target, "utf8");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hermesApiPortExport(emitted: string): string[] {
  return emitted.split("\n").filter((line) => line.includes("NEMOCLAW_HERMES_API_PORT"));
}

describe("connect and exec runtime env", () => {
  // The Hermes agent process inherits the per-sandbox API port from the
  // sandbox-create environment, but connect and exec shells only source this
  // file. Without the export the in-sandbox plugin falls back to 8642 and
  // reports another sandbox's API address (#14318).
  it("exports the allocated Hermes API port for connect and exec shells", () => {
    expect(hermesApiPortExport(emitRuntimeShellEnv({ NEMOCLAW_HERMES_API_PORT: "8643" }))).toEqual(
      ["export NEMOCLAW_HERMES_API_PORT='8643'"],
    );
  });

  it("emits no Hermes API port line when the sandbox-create environment omits it", () => {
    expect(hermesApiPortExport(emitRuntimeShellEnv({}))).toEqual([]);
  });

});