// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Live Vitest replacement for test/e2e/test-gateway-health-honest.sh.
 *
 * Preserves the legacy #3111 contract by invoking the real compiled
 * `startGateway()` path with a sabotaged OpenShell Docker-driver gateway
 * binary that exits immediately with GLIBC-style stderr. The assertion is
 * intentionally about user-visible behavior: onboarding must not print the
 * misleading "Docker-driver gateway is healthy" message when the child died
 * before serving a TCP probe, and it must surface a gateway-start failure.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildAvailabilityProbeEnv } from "../fixtures/availability-env.ts";
import { resultText } from "../fixtures/clients/index.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { shouldRunLiveE2EScenarios } from "../fixtures/live-project-gate.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const GATEWAY_NAME = "nemoclaw-18080";

function gatewayStateDir(): string {
  return path.join(os.homedir(), ".local", "state", "nemoclaw", "openshell-docker-gateway-18080");
}

function writeExecutable(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(file, 0o755);
}

test.skipIf(!shouldRunLiveE2EScenarios())(
  "onboard surfaces crashed Docker-driver gateway instead of reporting healthy (#3111)",
  async ({ artifacts, cleanup, host }) => {
    const stateDir = gatewayStateDir();
    const sabotageBin = artifacts.pathFor("bin/openshell-gateway-sabotage");
    const gatewayLog = path.join(stateDir, "openshell-gateway.log");
    const gatewayPidFile = path.join(stateDir, "openshell-gateway.pid");

    await artifacts.writeJson("scenario.json", {
      id: "gateway-health-honest",
      runner: "vitest",
      boundary: "real-startGateway-openshell-docker-driver-process",
      legacySource: "test/e2e/test-gateway-health-honest.sh",
      contracts: [
        "startGateway() invokes a real OpenShell Docker-driver gateway child process",
        "a crashed gateway binary does not log 'Docker-driver gateway is healthy'",
        "startGateway() exits non-zero and surfaces a gateway-start failure",
        "the gateway log proves the sabotaged GLIBC-failure binary was executed",
        "no live non-zombie gateway process remains after the simulated crash",
      ],
    });

    writeExecutable(
      sabotageBin,
      [
        "#!/usr/bin/env bash",
        'printf \'%s\\n\' "$(basename \\"$0\\"): /lib/x86_64-linux-gnu/libc.so.6: version \\`GLIBC_2.38\' not found (required by $(basename \\"$0\\"))" >&2',
        'printf \'%s\\n\' "$(basename \\"$0\\"): /lib/x86_64-linux-gnu/libc.so.6: version \\`GLIBC_2.39\' not found (required by $(basename \\"$0\\"))" >&2',
        "exit 127",
        "",
      ].join("\n"),
    );

    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.rmSync(gatewayPidFile, { force: true });
    fs.rmSync(gatewayLog, { force: true });
    fs.rmSync(path.join(stateDir, "runtime-marker.json"), { force: true });
    fs.rmSync(path.join(stateDir, "openshell-gateway.toml"), { force: true });
    await host.command(
      "sh",
      [
        "-lc",
        `command -v openshell >/dev/null 2>&1 && openshell gateway remove ${GATEWAY_NAME} || true`,
      ],
      {
        artifactName: "pre-cleanup-openshell-gateway-remove-gateway-health-honest",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );

    cleanup.add("remove sabotaged OpenShell gateway metadata", async () => {
      await host.command(
        "sh",
        [
          "-lc",
          `command -v openshell >/dev/null 2>&1 && openshell gateway remove ${GATEWAY_NAME} || true`,
        ],
        {
          artifactName: "cleanup-openshell-gateway-remove-gateway-health-honest",
          env: buildAvailabilityProbeEnv(),
          timeoutMs: 30_000,
        },
      );
    });
    cleanup.add("remove sabotaged gateway runtime files", () => {
      const pid = fs.existsSync(gatewayPidFile)
        ? Number.parseInt(fs.readFileSync(gatewayPidFile, "utf8"), 10)
        : Number.NaN;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Best-effort: the expected child has already exited.
        }
      }
      fs.rmSync(gatewayPidFile, { force: true });
      fs.rmSync(path.join(stateDir, "runtime-marker.json"), { force: true });
      fs.rmSync(path.join(stateDir, "openshell-gateway.toml"), { force: true });
      fs.rmSync(sabotageBin, { force: true });
    });

    const result = await host.command(
      "node",
      [
        "-e",
        [
          'const { startGateway } = require("./dist/lib/onboard");',
          "startGateway(null)",
          "  .then(() => { console.log('__onboard_startGateway_returned_successfully__'); process.exit(0); })",
          "  .catch((error) => { console.error('__onboard_startGateway_threw__'); console.error(error && error.stack ? error.stack : error); process.exit(3); });",
        ].join("\n"),
      ],
      {
        artifactName: "start-gateway-with-sabotaged-binary",
        cwd: REPO_ROOT,
        env: {
          ...buildAvailabilityProbeEnv(),
          NEMOCLAW_GATEWAY_PORT: "18080",
          NEMOCLAW_HEALTH_POLL_COUNT: "3",
          NEMOCLAW_HEALTH_POLL_INTERVAL: "1",
          NEMOCLAW_OPENSHELL_GATEWAY_BIN: sabotageBin,
          NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH: "0",
          NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR: stateDir,
        },
        timeoutMs: 60_000,
      },
    );

    const output = resultText(result);
    await artifacts.writeText(
      "gateway-log-tail.txt",
      fs.existsSync(gatewayLog) ? fs.readFileSync(gatewayLog, "utf8") : "",
    );

    expect(
      fs.existsSync(gatewayLog) ? fs.readFileSync(gatewayLog, "utf8") : "",
      "sabotage binary must have been executed before health assertions are trusted",
    ).toMatch(/GLIBC_2\.3(?:8|9)|openshell-gateway-sabotage/);

    expect(output).not.toContain("Docker-driver gateway is healthy");
    expect(result.exitCode, output).not.toBe(0);
    expect(output).not.toContain("__onboard_startGateway_returned_successfully__");
    expect(output).toMatch(
      /Docker-driver gateway failed to start|Gateway process exited with code 127|__onboard_startGateway_threw__/i,
    );

    const lingeringGateway = await host.command(
      "bash",
      [
        "-lc",
        String.raw`
set -u
pid_file="$1"
[ -f "$pid_file" ] || exit 0
pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
case "$pid" in
  ""|*[!0-9]*) exit 0 ;;
esac
kill -0 "$pid" 2>/dev/null || exit 0
state="$(ps -p "$pid" -o state= 2>/dev/null | tr -d '[:space:]')" || state=""
case "$state" in
  ""|Z*) exit 0 ;;
esac
printf 'live non-zombie gateway pid remains: pid=%s state=%s\n' "$pid" "$state" >&2
exit 1
`,
        "gateway-lingering-process-check",
        gatewayPidFile,
      ],
      {
        artifactName: "gateway-lingering-process-check",
        env: buildAvailabilityProbeEnv(),
        timeoutMs: 30_000,
      },
    );
    expect(lingeringGateway.exitCode, resultText(lingeringGateway)).toBe(0);
  },
);
