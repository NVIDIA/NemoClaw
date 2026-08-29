// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { expect, test } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../../..");

function writeExecutable(file: string, content: string): void {
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o755 });
}

function readOptionalFile(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function readGatewayPid(file: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function stopGatewayProcess(pid: number | null): void {
  try {
    pid === null || process.kill(pid, "SIGKILL");
  } catch {
    // The expected crashed process has already exited.
  }
}

// source-shape-contract: compatibility -- Executes the real gateway start path to prove crashed drivers are reported honestly to users
test("reports a crashed Docker-driver gateway instead of reporting it healthy (#3111)", () => {
  const root = fs.mkdtempSync(path.join(REPO_ROOT, "nemoclaw-gateway-health-honest-"));
  const binDir = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const gatewayBin = path.join(binDir, "openshell-gateway-sabotage");
  const openshellBin = path.join(binDir, "openshell");
  const dockerBin = path.join(binDir, "docker");
  fs.mkdirSync(binDir);
  fs.mkdirSync(stateDir, { mode: 0o700 });
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
    const gatewayLog = readOptionalFile(gatewayLogPath);

    expect(`${output}\n${gatewayLog}`).toMatch(/GLIBC_2\.38|openshell-gateway-sabotage/);
    expect(output).not.toContain("Docker-driver gateway is healthy");
    expect(result.status, output).not.toBe(0);
    expect(output).not.toContain("__startGateway_succeeded__");
    expect(output).toMatch(
      /Docker-driver gateway failed to start|exited with code 127|__startGateway_failed__/i,
    );

    gatewayPid = readGatewayPid(pidFile);
    const lingeringGateway = spawnSync(
      "bash",
      [
        "-c",
        'kill -0 "$1" 2>/dev/null || exit 0; ps -p "$1" -o state= 2>/dev/null | tr -d "[:space:]" | grep -Eq "^Z|^$"',
        "gateway-process-check",
        String(gatewayPid ?? ""),
      ],
      { encoding: "utf8", killSignal: "SIGKILL", timeout: 5_000 },
    );
    expect(lingeringGateway.status, `${lingeringGateway.stdout}${lingeringGateway.stderr}`).toBe(0);
  } finally {
    stopGatewayProcess(gatewayPid);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
