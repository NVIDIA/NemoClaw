// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  OPENCLAW_CONFIG_DIR,
  parseOpenClawConfigGuardOutput,
  runOpenClawConfigGuard,
} from "./openclaw-config-lock";
import type { PrivilegedExec, PrivilegedExecResult } from "./state-dir-lock";

type RunCall = { cmd: string[]; input?: string };

function success(action: string, chattrApplied = false): string {
  return JSON.stringify({
    type: "result",
    action,
    status: "ok",
    configDir: OPENCLAW_CONFIG_DIR,
    files: ["openclaw.json", ".config-hash"],
    chattrApplied,
    ...(action === "write-config" ? { configSha256: "b".repeat(64) } : {}),
  });
}

function createExec(installed: boolean): { calls: RunCall[]; privileged: PrivilegedExec } {
  const calls: RunCall[] = [];
  return {
    calls,
    privileged: {
      run: (cmd, input) => {
        calls.push({ cmd, input });
        switch (cmd[0]) {
          case "test":
            return { status: installed ? 0 : 1, signal: null, stdout: "", stderr: "" };
        }
        const scriptIndex =
          cmd.indexOf("-") >= 0
            ? cmd.indexOf("-")
            : cmd.indexOf(cmd.find((arg) => arg.endsWith("openclaw-config-guard.py")) ?? "");
        const action = cmd[scriptIndex + 1];
        return {
          status: 0,
          signal: null,
          stdout: `${success(action, action === "lock")}\n`,
          stderr: "",
        };
      },
    },
  };
}

describe("OpenClaw top-config guard host wiring", () => {
  it("uses the root-only installed helper and preserves its immutable result", () => {
    const { calls, privileged } = createExec(true);

    expect(runOpenClawConfigGuard(privileged, "lock")).toEqual({
      issues: [],
      chattrApplied: true,
    });
    expect(calls.at(-1)?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "5m",
      "python3",
      "-I",
      "/usr/local/lib/nemoclaw/openclaw-config-guard.py",
      "lock",
      "--config-dir",
      OPENCLAW_CONFIG_DIR,
    ]);
    expect(calls.at(-1)?.input).toBeUndefined();
  });

  it("injects the trusted host helper into old images", () => {
    const { calls, privileged } = createExec(false);

    expect(runOpenClawConfigGuard(privileged, "unlock").issues).toEqual([]);
    expect(calls.at(-1)?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "5m",
      "python3",
      "-I",
      "-",
      "unlock",
      "--config-dir",
      OPENCLAW_CONFIG_DIR,
    ]);
    expect(calls.at(-1)?.input).toContain("Descriptor-safe OpenClaw top-level config");
  });

  it("passes OpenClaw config bytes and the matching CAS digest to the installed helper", () => {
    const { calls, privileged } = createExec(true);
    const digest = "a".repeat(64);

    expect(
      runOpenClawConfigGuard(privileged, "write-config", {
        expectedConfigSha256: digest,
        input: '{"gateway":{}}\n',
      }),
    ).toMatchObject({ issues: [], configSha256: "b".repeat(64) });
    expect(calls.at(-1)?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "5m",
      "python3",
      "-I",
      "/usr/local/lib/nemoclaw/openclaw-config-guard.py",
      "write-config",
      "--config-dir",
      OPENCLAW_CONFIG_DIR,
      "--expected-config-sha256",
      digest,
    ]);
    expect(calls.at(-1)?.input).toBe('{"gateway":{}}\n');
  });

  it("refuses an unsafe old-image write fallback because stdin carries the helper source", () => {
    const { calls, privileged } = createExec(false);

    expect(
      runOpenClawConfigGuard(privileged, "write-config", {
        expectedConfigSha256: "a".repeat(64),
        input: "{}\n",
      }).issues,
    ).toEqual([expect.stringContaining("rebuild before writing config transactionally")]);
    expect(calls).toHaveLength(1);
  });

  it("surfaces structured findings and contradictory exit contracts", () => {
    const result: PrivilegedExecResult = {
      status: 0,
      signal: null,
      stdout: [
        JSON.stringify({
          type: "issue",
          code: "hardlinked-config-file",
          path: `${OPENCLAW_CONFIG_DIR}/openclaw.json`,
          detail: "link count is 2",
        }),
        JSON.stringify({ type: "result", action: "preflight", status: "failed" }),
      ].join("\n"),
      stderr: "",
    };

    expect(parseOpenClawConfigGuardOutput("preflight", result).issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[hardlinked-config-file]"),
        expect.stringContaining("reported failure with a zero exit"),
      ]),
    );
  });

  it("rejects malformed success summaries and capability probe errors", () => {
    const malformed: PrivilegedExecResult = {
      status: 0,
      signal: null,
      stdout: JSON.stringify({
        type: "result",
        action: "lock",
        status: "ok",
        configDir: "/tmp/.openclaw",
        files: ["openclaw.json"],
      }),
      stderr: "",
    };
    expect(parseOpenClawConfigGuardOutput("lock", malformed).issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("configDir=/tmp/.openclaw"),
        expect.stringContaining("unexpected protected-file set"),
      ]),
    );

    const probeFailure: PrivilegedExec = {
      run: () => ({
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "probe timed out",
      }),
    };
    expect(runOpenClawConfigGuard(probeFailure, "lock").issues).toEqual([
      expect.stringContaining("capability probe failed"),
    ]);
  });
});
