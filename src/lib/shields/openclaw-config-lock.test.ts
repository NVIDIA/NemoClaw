// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  OPENCLAW_CONFIG_DIR,
  parseOpenClawConfigGuardOutput,
  runOpenClawConfigGuard,
  validateOpenClawConfigCandidate,
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

function createExec(
  installed: boolean,
  validationResult: PrivilegedExecResult = {
    status: 0,
    signal: null,
    stdout: '{"valid":true}\n',
    stderr: "",
  },
): { calls: RunCall[]; privileged: PrivilegedExec } {
  const calls: RunCall[] = [];
  const guardResult = (cmd: string[]): PrivilegedExecResult => {
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
  };
  return {
    calls,
    privileged: {
      run: (cmd, input) => {
        calls.push({ cmd, input });
        switch (cmd[0]) {
          case "test":
            return { status: installed ? 0 : 1, signal: null, stdout: "", stderr: "" };
        }
        return cmd.includes("gosu") ? validationResult : guardResult(cmd);
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

    expect(validateOpenClawConfigCandidate(privileged, '{"gateway":{}}\n')).toEqual([]);
    expect(
      runOpenClawConfigGuard(privileged, "write-config", {
        expectedConfigSha256: digest,
        input: '{"gateway":{}}\n',
      }),
    ).toMatchObject({ issues: [], configSha256: "b".repeat(64) });
    expect(calls.at(-3)?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "30s",
      "gosu",
      "gateway",
      "sh",
      "-c",
      expect.stringContaining("openclaw config validate --json"),
    ]);
    expect(calls.at(-3)?.cmd.at(-1)).toContain(
      `candidate="$(mktemp "${OPENCLAW_CONFIG_DIR}/.nemoclaw-openclaw-config.XXXXXX")"`,
    );
    expect(calls.at(-3)?.cmd.at(-1)).toContain("head -c 16777217");
    expect(calls.at(-3)?.input).toBe('{"gateway":{}}\n');
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
    expect(calls.at(-1)?.cmd).not.toContain("--validate-schema");
  });

  it("rejects an invalid candidate before probing or invoking the config guard", () => {
    const { calls, privileged } = createExec(true, {
      status: 1,
      signal: null,
      stdout: JSON.stringify({ valid: false, issues: [{ path: "web_search" }] }),
      stderr: "Error: noisy node stack\n    at validate (openclaw.js:1:1)",
    });

    const issues = validateOpenClawConfigCandidate(privileged, '{"web_search":true}\n');

    expect(issues).toEqual([
      expect.stringContaining("schema rejected the candidate at web_search"),
    ]);
    expect(issues.join("\n")).not.toContain("node stack");
    expect(calls).toHaveLength(1);
  });

  it("redacts validator stderr when schema validation cannot run", () => {
    const { calls, privileged } = createExec(true, {
      status: 1,
      signal: null,
      stdout: "",
      stderr: "Error: raw node stack with /sandbox/secrets",
    });

    const issues = validateOpenClawConfigCandidate(privileged, "{}\n");

    expect(issues).toEqual([expect.stringContaining("schema validation could not run")]);
    expect(issues.join("\n")).not.toContain("raw node stack");
    expect(calls).toHaveLength(1);
  });

  it("does not present a validator execution error as a schema rejection", () => {
    const { privileged } = createExec(true, {
      status: 1,
      signal: null,
      stdout: JSON.stringify({ valid: false, error: "plugin loader exposed a secret path" }),
      stderr: "",
    });

    const issues = validateOpenClawConfigCandidate(privileged, "{}\n");

    expect(issues).toEqual([expect.stringContaining("schema validation could not run")]);
    expect(issues.join("\n")).not.toContain("secret path");
  });

  it("reports the timeout utility exit code as a validation timeout", () => {
    const { privileged } = createExec(true, {
      status: 124,
      signal: null,
      stdout: "",
      stderr: "",
    });

    expect(validateOpenClawConfigCandidate(privileged, "{}\n")).toEqual([
      expect.stringContaining("timed out or was terminated"),
    ]);
  });

  it.each([
    {
      label: "times out",
      result: { status: 124, signal: null, error: undefined },
      reason: "timed out or was terminated",
    },
    {
      label: "is terminated",
      result: { status: null, signal: "SIGTERM" as const, error: undefined },
      reason: "timed out or was terminated",
    },
    {
      label: "has an execution error",
      result: { status: 1, signal: null, error: "spawn failed" },
      reason: "could not run",
    },
  ])("does not trust partial schema output when validation $label", ({ result, reason }) => {
    const { privileged } = createExec(true, {
      ...result,
      stdout: JSON.stringify({ valid: false, issues: [{ path: "web_search" }] }),
      stderr: "",
    });

    const issues = validateOpenClawConfigCandidate(privileged, "{}\n");

    expect(issues).toEqual([expect.stringContaining(reason)]);
    expect(issues.join("\n")).not.toContain("schema rejected");
  });

  it("rejects an oversized candidate before creating a sandbox temp file", () => {
    const { calls, privileged } = createExec(true);

    const issues = validateOpenClawConfigCandidate(privileged, "x".repeat(16 * 1024 * 1024 + 1));

    expect(issues).toEqual([expect.stringContaining("exceeds the 16 MiB size limit")]);
    expect(calls).toHaveLength(0);
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
