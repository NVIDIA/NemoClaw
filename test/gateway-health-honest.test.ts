// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o755 });
}

function isLiveNonZombieProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const state = spawnSync("ps", ["-p", String(pid), "-o", "state="], {
      encoding: "utf8",
      killSignal: "SIGKILL",
      timeout: 5_000,
    }).stdout.trim();
    return state !== "" && !state.startsWith("Z");
  } catch {
    return false;
  }
}

test("reports a crashed Docker-driver gateway instead of reporting it healthy (#3111)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-gateway-health-honest-"));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const gatewayBin = path.join(binDir, "openshell-gateway-sabotage");
  const openshellBin = path.join(binDir, "openshell");
  const dockerBin = path.join(binDir, "docker");
  fs.mkdirSync(binDir);
  fs.mkdirSync(stateDir);
  writeExecutable(
    gatewayBin,
    `#!/usr/bin/env bash
printf '%s\n' 'openshell-gateway-sabotage: GLIBC_2.38 not found' >&2
exit 127
`,
  );
  writeExecutable(
    openshellBin,
    `#!/usr/bin/env bash
if [ "\${1:-}" = "--version" ]; then printf '%s\n' 'openshell 0.0.85'; fi
exit 0
`,
  );
  writeExecutable(
    dockerBin,
    `#!/usr/bin/env bash
exit 0
`,
  );

  const pidFile = path.join(stateDir, "openshell-gateway.pid");
  let gatewayPid: number | null = null;
  try {
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        [
          'const { startGateway } = require("./src/lib/onboard.ts");',
          "startGateway(null)",
          "  .then(() => { console.log('__startGateway_succeeded__'); process.exit(0); })",
          "  .catch((error) => { console.error('__startGateway_failed__'); console.error(error && error.stack ? error.stack : error); process.exit(3); });",
        ].join("\n"),
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: root,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          NEMOCLAW_GATEWAY_PORT: "18080",
          NEMOCLAW_HEALTH_POLL_COUNT: "3",
          NEMOCLAW_HEALTH_POLL_INTERVAL: "1",
          NEMOCLAW_OPENSHELL_BIN: openshellBin,
          NEMOCLAW_OPENSHELL_GATEWAY_BIN: gatewayBin,
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "0",
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir,
        },
        killSignal: "SIGKILL",
        timeout: 60_000,
      },
    );
    const output = `${result.stdout}${result.stderr}`;
    const gatewayLogPath = path.join(stateDir, "openshell-gateway.log");
    const gatewayLog = fs.existsSync(gatewayLogPath) ? fs.readFileSync(gatewayLogPath, "utf8") : "";

    expect(`${output}\n${gatewayLog}`).toMatch(/GLIBC_2\.38|openshell-gateway-sabotage/);
    expect(output).not.toContain("Docker-driver gateway is healthy");
    expect(result.status, output).not.toBe(0);
    expect(output).not.toContain("__startGateway_succeeded__");
    expect(output).toMatch(
      /Docker-driver gateway failed to start|exited with code 127|__startGateway_failed__/i,
    );

    if (fs.existsSync(pidFile)) {
      gatewayPid = Number.parseInt(fs.readFileSync(pidFile, "utf8"), 10);
      if (Number.isInteger(gatewayPid) && gatewayPid > 0) {
        expect(isLiveNonZombieProcess(gatewayPid)).toBe(false);
      }
    }
  } finally {
    if (gatewayPid !== null && Number.isInteger(gatewayPid) && gatewayPid > 0) {
      try {
        process.kill(gatewayPid, "SIGKILL");
      } catch {
        // The expected crashed process has already exited.
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
