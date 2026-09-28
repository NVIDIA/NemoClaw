// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import {
  LAUNCH_TURN_SCRIPT,
  OPENCLAW_LAUNCH_OPENSHELL_PRELOAD_SCRIPT,
  OPENCLAW_LAUNCH_READINESS_LEASE_ACCEPTANCE_TIMEOUT_MS,
  OPENCLAW_LAUNCH_READINESS_LEASE_MAXIMUM_MS,
  OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT,
  OPENCLAW_PTY_MONITOR_STARTER_SCRIPT,
  OPENCLAW_SESSION_EVIDENCE_SCRIPT,
  runOpenClawLaunchReadinessLeaseTurns,
} from "../live/launch-agent-turn.ts";

it.runIf(process.platform === "linux")(
  "runs the producer then two PTY launch sessions under one lease (#8942, #9023, #9160)",
  async () => {
    const calls: Array<{
      command: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }> = [];
    let launchPhaseStartedAtCallCount = -1;
    const host = {
      command: async (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        calls.push({ command, args, env: options?.env });
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
      openshellCommandPath: "/usr/bin/openshell",
    };
    await runOpenClawLaunchReadinessLeaseTurns({
      artifactName: "lease-turn",
      cliCommand: "node",
      cliEntrypoint: "/repo/bin/nemoclaw.js",
      env: {},
      exitCommand: "/exit",
      host: host as never,
      redactionValues: [],
      sandboxName: "alpha",
      beforeLaunchTurns: () => {
        launchPhaseStartedAtCallCount = calls.length;
      },
    });
    expect(
      launchPhaseStartedAtCallCount === 1 &&
        OPENCLAW_LAUNCH_READINESS_LEASE_ACCEPTANCE_TIMEOUT_MS >=
          OPENCLAW_LAUNCH_READINESS_LEASE_MAXIMUM_MS + 5 * 60_000,
    ).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({
      command: "node",
      args: ["/repo/bin/nemoclaw.js", "alpha", "connect", "--probe-only"],
    });
    expect(calls.slice(1).map((call) => call.command)).toEqual(["bash", "bash"]);
    expect(calls.slice(1).map((call) => call.args)).toEqual([
      ["-lc", LAUNCH_TURN_SCRIPT],
      ["-lc", LAUNCH_TURN_SCRIPT],
    ]);
    expect(calls.slice(1).map((call) => call.env?.NEMOCLAW_LAUNCH_EXIT_COMMAND)).toEqual([
      "/exit",
      "/exit",
    ]);
    expect(calls.slice(1).map((call) => call.env?.NEMOCLAW_OPENSHELL_COMMAND)).toEqual([
      "/usr/bin/openshell",
      "/usr/bin/openshell",
    ]);
    calls.slice(1).forEach((call) => {
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_EXPECTED_REPLY");
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_POST_REPLY_READY_TEXT");
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_PROMPT");
      expect(call.env).not.toHaveProperty("NEMOCLAW_LAUNCH_READY_TEXT");
      expect(typeof call.env?.NEMOCLAW_LAUNCH_FIRST_INPUT).toBe("string");
      expect(typeof call.env?.NEMOCLAW_LAUNCH_SECOND_INPUT).toBe("string");
      expect(call.env?.NEMOCLAW_LAUNCH_FIRST_INPUT).not.toBe(
        call.env?.NEMOCLAW_LAUNCH_SECOND_INPUT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_SESSION_EVIDENCE_SCRIPT).toBe(
        OPENCLAW_SESSION_EVIDENCE_SCRIPT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_OPENSHELL_PRELOAD_SCRIPT).toBe(
        OPENCLAW_LAUNCH_OPENSHELL_PRELOAD_SCRIPT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_PTY_MONITOR_STARTER_SCRIPT).toBe(
        OPENCLAW_PTY_MONITOR_STARTER_SCRIPT,
      );
      expect(call.env?.NEMOCLAW_LAUNCH_RUNTIME_ENV_SCRIPT).toBe(OPENCLAW_LAUNCH_RUNTIME_ENV_SCRIPT);
    });
  },
);
