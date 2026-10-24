// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  AUTO_PAIR_STATUS_PATH,
  parseAutoPairWatcherStatus,
  WATCHER_STATUS_SCRIPT,
} from "../../../../src/lib/actions/sandbox/auto-pair-warmup";
import { runOpenclaw } from "./auto-pair-settlement-fixture";
import { extractShellFunctionFromSource } from "../../../helpers/shell-source";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../../scripts/nemoclaw-start.sh"),
  "utf8",
);

describe("auto-pair startup diagnostics", () => {
  it.each([
    ["startup-timeout", 0, false],
    ["startup-gateway-exited", 1, false],
    ["startup-timeout", 0, true],
  ] as const)(
    "reports %s without starting the CLI (gateway exit: %s; unsafe log: %s)",
    async (state, livenessExit, unsafeLog) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-startup-diagnostic-"));
      const logDir = path.join(root, "logs");
      const persistentLog = path.join(logDir, "gateway-persistent.log");
      const temporaryLog = path.join(root, "auto-pair.log");
      const statusPath = path.join(root, "status.json");
      const canary = path.join(root, "canary");
      fs.mkdirSync(logDir, { mode: 0o755 });
      fs.writeFileSync(statusPath, "", { mode: 0o600 });
      fs.writeFileSync(canary, "unchanged", { mode: 0o644 });
      const prepareLog = unsafeLog
        ? () => fs.symlinkSync(canary, persistentLog)
        : () => fs.writeFileSync(persistentLog, "prior gateway output\n", { mode: 0o644 });
      prepareLog();
      const functions = [
        extractShellFunctionFromSource(source, "wait_for_openclaw_auto_pair_startup"),
        extractShellFunctionFromSource(source, "record_openclaw_auto_pair_startup_failure"),
        extractShellFunctionFromSource(source, "start_auto_pair"),
      ]
        .join("\n")
        .replaceAll("/sandbox/.openclaw/logs", logDir)
        .replaceAll("/tmp/auto-pair.log", temporaryLog)
        .replaceAll(AUTO_PAIR_STATUS_PATH, statusPath);
      try {
        const result = await runOpenclaw(
          "bash",
          [
            "-c",
            [
              "set -eu",
              functions,
              `openclaw_supervised_pid_is_live() { return ${livenessExit}; }`,
              'capture_openclaw_pid_start_identity() { printf -v "$2" test; }',
              "curl() { printf 503; }",
              "sleep() { SECONDS=$((SECONDS + 331)); }",
              "GATEWAY_PID=1; GATEWAY_PID_START_IDENTITY=1; _DASHBOARD_PORT=18789",
              'STEP_DOWN_PREFIX_SANDBOX=(); _RUNTIME_SHELL_ENV_FILE=""; OPENCLAW=/does-not-exist',
              // A parent environment cannot overwrite the actual startup result.
              "export NEMOCLAW_AUTO_PAIR_STARTUP_STATUS=ready",
              "start_auto_pair",
              'wait "$AUTO_PAIR_PID"',
            ].join("\n"),
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(result.status, result.stderr).toBe(1);
        expect(JSON.parse(fs.readFileSync(statusPath, "utf8"))).toEqual({
          schemaVersion: 1,
          state,
        });
        const read = await runOpenclaw(
          "sh",
          [
            "-c",
            WATCHER_STATUS_SCRIPT.replace(
              JSON.stringify(AUTO_PAIR_STATUS_PATH),
              JSON.stringify(statusPath),
            ),
          ],
          { encoding: "utf8", timeout: 5000 },
        );
        expect(parseAutoPairWatcherStatus(read.stdout)).toEqual({
          schemaVersion: 1,
          state,
          watcherActive: false,
        });
        expect(fs.readFileSync(temporaryLog, "utf8")).not.toContain("watcher started");
        fs.unlinkSync(temporaryLog);
        fs.unlinkSync(statusPath);
        const expectedLog = unsafeLog
          ? "unchanged"
          : `prior gateway output\n[auto-pair-status] ${JSON.stringify({ schemaVersion: 1, state })}\n`;
        expect(fs.readFileSync(persistentLog, "utf8")).toBe(expectedLog);
        expect(fs.readFileSync(canary, "utf8")).toBe("unchanged");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
