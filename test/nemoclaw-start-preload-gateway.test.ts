// @ts-nocheck
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { extractShellFunctionFromSource } from "./support/shell-function-extractor.ts";

const START_SCRIPT = path.join(import.meta.dirname, "..", "scripts", "nemoclaw-start.sh");
const PRELOAD_SCRIPTS = path.join(import.meta.dirname, "..", "nemoclaw-blueprint", "scripts");

function runEmbeddedPreload(
  script: string,
  argv1: string,
  argv2: string,
  title = "node",
): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      "-e",
      `process.env.OPENSHELL_SANDBOX = '1';
process.title = ${JSON.stringify(title)};
process.argv[1] = ${JSON.stringify(argv1)};
process.argv[2] = ${JSON.stringify(argv2)};
${script}`,
    ],
    { encoding: "utf-8" },
  );
}

describe("nemoclaw-start gateway preload process detection (#2478)", () => {
  const safetyNetScript = fs.readFileSync(
    path.join(PRELOAD_SCRIPTS, "sandbox-safety-net.js"),
    "utf-8",
  );
  const ciaoGuardScript = fs.readFileSync(
    path.join(PRELOAD_SCRIPTS, "ciao-network-guard.js"),
    "utf-8",
  );

  it("activates the safety net for the re-execed openclaw-gateway child", () => {
    const run = runEmbeddedPreload(safetyNetScript, "/usr/local/bin/openclaw-gateway", "--port");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("[sandbox-safety-net] loaded (openclaw-gateway)");
  });

  it("activates the ciao guard fallback for the re-execed openclaw-gateway child", () => {
    const run = runEmbeddedPreload(ciaoGuardScript, "/usr/local/bin/openclaw-gateway", "--port");
    expect(run.status).toBe(0);
    expect(run.stderr).toContain("[guard] ciao-network-guard loaded (openclaw-gateway)");
  });

  it("still recognizes the openclaw gateway launcher path", () => {
    const safetyNet = runEmbeddedPreload(safetyNetScript, "/usr/local/bin/openclaw", "gateway");
    const ciaoGuard = runEmbeddedPreload(ciaoGuardScript, "/usr/local/bin/openclaw", "gateway");
    expect(safetyNet.status).toBe(0);
    expect(ciaoGuard.status).toBe(0);
    expect(safetyNet.stderr).toContain("[sandbox-safety-net] loaded (launcher)");
    expect(ciaoGuard.stderr).toContain("[guard] ciao-network-guard loaded (launcher)");
  });

  it("prefers the re-execed process title over launcher argv", () => {
    const safetyNet = runEmbeddedPreload(
      safetyNetScript,
      "/usr/local/bin/openclaw",
      "gateway",
      "openclaw-gateway",
    );
    const ciaoGuard = runEmbeddedPreload(
      ciaoGuardScript,
      "/usr/local/bin/openclaw",
      "gateway",
      "openclaw-gateway",
    );
    expect(safetyNet.status).toBe(0);
    expect(ciaoGuard.status).toBe(0);
    expect(safetyNet.stderr).toContain("[sandbox-safety-net] loaded (openclaw-gateway)");
    expect(ciaoGuard.stderr).toContain("[guard] ciao-network-guard loaded (openclaw-gateway)");
  });

  it("does not install the safety net for non-gateway CLI commands", () => {
    const run = runEmbeddedPreload(safetyNetScript, "/usr/local/bin/openclaw", "agent");
    expect(run.status).toBe(0);
    expect(run.stderr).not.toContain("[sandbox-safety-net] loaded");
  });
});

describe("nemoclaw-start persistent gateway log hardening", () => {
  const src = fs.readFileSync(START_SCRIPT, "utf-8");
  function persistentLogFunction(root: string, gatewayLog: string): string {
    return extractShellFunctionFromSource(src, "start_persistent_gateway_log_mirror")
      .replaceAll("/sandbox/.openclaw/logs", path.join(root, "logs"))
      .replaceAll("/tmp/gateway.log", gatewayLog);
  }

  it("creates a regular read-only persistent log mirror and refuses unsafe paths", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-persistent-log-"));
    const gatewayLog = path.join(tmpDir, "gateway.log");
    const persistentLog = path.join(tmpDir, "logs", "gateway-persistent.log");
    const scriptPath = path.join(tmpDir, "run.sh");
    fs.writeFileSync(gatewayLog, "initial gateway line\n");
    fs.writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env bash",
        'set -euo pipefail\n# Identity capture is covered by supervisor suites.\ncapture_openclaw_pid_start_identity() { printf -v "$2" "%s" "test:$1"; }',
        persistentLogFunction(tmpDir, gatewayLog),
        "start_persistent_gateway_log_mirror",
        "sleep 0.2",
        `printf '%s\\n' later-line >> ${JSON.stringify(gatewayLog)}`,
        `for _ in {1..30}; do grep -Fq later-line ${JSON.stringify(persistentLog)} 2>/dev/null && break; sleep 0.1; done`,
        'kill "$GATEWAY_LOG_PERSIST_PID" 2>/dev/null || true',
        'wait "$GATEWAY_LOG_PERSIST_PID" 2>/dev/null || true',
        "printf 'PID=%s\\n' \"$GATEWAY_LOG_PERSIST_PID\"",
      ].join("\n"),
      { mode: 0o700 },
    );

    try {
      const result = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("PID=");
      const fd = fs.openSync(persistentLog, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const [stat, log] = [fs.fstatSync(fd), fs.readFileSync(fd, "utf-8")];
      fs.closeSync(fd);
      expect(stat.isFile()).toBe(true);
      expect((stat.mode & 0o777).toString(8)).toBe("644");
      expect(log).toContain("initial gateway line");
      expect(log).toContain("later-line");

      fs.rmSync(path.join(tmpDir, "logs"), { recursive: true, force: true });
      fs.symlinkSync(tmpDir, path.join(tmpDir, "logs"));
      const unsafe = spawnSync("bash", [scriptPath], { encoding: "utf-8", timeout: 5000 });
      expect(unsafe.status).not.toBe(0);
      expect(unsafe.stderr).toContain("refusing symlinked persistent log directory");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
