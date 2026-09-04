// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it, vi } from "vitest";
import { runOpenClawLaunchSession } from "../live/launch-agent-turn.ts";

function launchOptions(host: unknown) {
  return {
    artifactName: "provider-turn",
    cliCommand: "node",
    env: {},
    host: host as never,
    redactionValues: [],
    sandboxName: "alpha",
  };
}

it("retries a transient provider failure in a fresh launch session (#10978)", async () => {
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const calls: Array<{ artifactName?: string; env?: NodeJS.ProcessEnv }> = [];
  const host = {
    command: async (
      _command: string,
      _args: string[],
      options?: { artifactName?: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ artifactName: options?.artifactName, env: options?.env });
      return calls.length === 1
        ? {
            exitCode: 1,
            signal: null,
            stderr: "litellm.ServiceUnavailableError: NVIDIA upstream unavailable",
            stdout: "",
          }
        : { exitCode: 0, signal: null, stderr: "", stdout: "" };
    },
    openshellCommandPath: "/usr/bin/openshell",
  };

  try {
    const result = await runOpenClawLaunchSession(launchOptions(host));
    expect(result.exitCode).toBe(0);
    expect(calls.map((call) => call.artifactName)).toEqual([
      "provider-turn",
      "provider-turn-provider-retry-02",
    ]);
    expect(new Set(calls.map((call) => call.env?.NEMOCLAW_LAUNCH_RUN_ID)).size).toBe(2);
    expect(new Set(calls.map((call) => call.env?.NEMOCLAW_LAUNCH_FIRST_INPUT)).size).toBe(2);
  } finally {
    platform.mockRestore();
  }
});

it("classifies exhausted transient launch attempts as provider unavailable (#10978)", async () => {
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const calls: string[] = [];
  const host = {
    command: async (_command: string, _args: string[], options?: { artifactName?: string }) => {
      calls.push(options?.artifactName ?? "");
      return {
        exitCode: 1,
        signal: null,
        stderr: `launch did not record the required structured session turns\nHTTP ${calls.length === 1 ? "503" : "502"}`,
        stdout: "",
      };
    },
    openshellCommandPath: "/usr/bin/openshell",
  };

  try {
    await expect(runOpenClawLaunchSession(launchOptions(host))).rejects.toThrow(
      "OpenClaw launch provider unavailable after 2 attempts",
    );
    expect(calls).toEqual(["provider-turn", "provider-turn-provider-retry-02"]);
  } finally {
    platform.mockRestore();
  }
});

it.each([
  [
    "invalid structured session evidence",
    'ServiceUnavailableError\nlaunch final structured session evidence did not qualify (status 2)\n{"reason":"message_order_invalid"}',
  ],
  [
    "authentication failure",
    "ServiceUnavailableError: HTTP 503\nauthentication failed: invalid API key",
  ],
  ["policy failure", "ServiceUnavailableError: HTTP 503\ndenied by network policy"],
  ["invalid response", "ServiceUnavailableError: HTTP 503\ninvalid provider response"],
  ["unknown failure", "launch failed for an unknown reason"],
])("does not retry a %s (#10978)", async (_case, stderr) => {
  const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  let calls = 0;
  const host = {
    command: async () => {
      calls += 1;
      return { exitCode: 1, signal: null, stderr, stdout: "" };
    },
    openshellCommandPath: "/usr/bin/openshell",
  };

  try {
    await expect(runOpenClawLaunchSession(launchOptions(host))).rejects.toThrow(
      "launch session failed",
    );
    expect(calls).toBe(1);
  } finally {
    platform.mockRestore();
  }
});
