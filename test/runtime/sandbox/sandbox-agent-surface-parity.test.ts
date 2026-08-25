// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testTimeoutOptions } from "../../helpers/timeouts";

const CLI = path.join(import.meta.dirname, "../..", "bin", "nemoclaw.js");
const SANDBOX = "my-assist";

describe("agent parity across sandbox inventory surfaces", () => {
  let home: string;
  let binDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-parity-"));
    binDir = path.join(home, "bin");
    fs.mkdirSync(binDir, { recursive: true });

    fs.writeFileSync(
      path.join(binDir, "openshell"),
      [
        "#!/usr/bin/env bash",
        'case "$*" in',
        "  status)",
        "    echo 'Status: Disconnected'",
        "    exit 1",
        "    ;;",
        "  *)",
        "    exit 1",
        "    ;;",
        "esac",
      ].join("\n"),
      { mode: 0o755 },
    );

    const stateDir = path.join(home, ".nemoclaw");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "sandboxes.json"),
      JSON.stringify({
        sandboxes: {
          [SANDBOX]: {
            name: SANDBOX,
            model: "test-model",
            provider: "nvidia-prod",
            gpuEnabled: false,
            policies: [],
            agent: null,
          },
        },
        defaultSandbox: SANDBOX,
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [CLI, ...args], {
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH || ""}`,
        NEMOCLAW_HEALTH_POLL_COUNT: "1",
        NEMOCLAW_HEALTH_POLL_INTERVAL: "0",
        NEMOCLAW_STATUS_PROBE_TIMEOUT_MS: "2000",
        NEMOCLAW_TEST_NO_SLEEP: "1",
        NEMOCLAW_GATEWAY_PORT: "",
      },
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  function runCliJson(args: string[]): Record<string, unknown> {
    const { stdout, stderr } = runCli(args);
    try {
      return JSON.parse(stdout) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Expected JSON on stdout for \`${args.join(" ")}\`: ${String(error)}\nstdout: ${stdout}\nstderr: ${stderr}`,
      );
    }
  }

  function firstSandboxAgent(payload: Record<string, unknown>): unknown {
    const sandboxes = payload.sandboxes as Array<Record<string, unknown>> | undefined;
    expect(Array.isArray(sandboxes)).toBe(true);
    expect(sandboxes).toHaveLength(1);
    return sandboxes?.[0].agent;
  }

  it(
    "reports the same agent from list --json, global status --json, scoped status --json, and list text",
    testTimeoutOptions(120_000),
    () => {
      const listAgent = firstSandboxAgent(runCliJson(["list", "--json"]));
      const globalStatusAgent = firstSandboxAgent(runCliJson(["status", "--json"]));
      const scopedStatusAgent = runCliJson([SANDBOX, "status", "--json"]).agent;
      const listText = runCli(["list"]);

      expect(listAgent).toBe("openclaw");
      expect(globalStatusAgent).toBe("openclaw");
      expect(scopedStatusAgent).toBe("openclaw");
      expect(`${listText.stdout}${listText.stderr}`).toContain("agent: openclaw");
    },
  );
});
