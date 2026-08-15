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
        return cmd.includes("/usr/bin/setpriv") ? validationResult : guardResult(cmd);
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
      "/usr/bin/setpriv",
      "--reuid=gateway",
      "--regid=gateway",
      "--init-groups",
      "--",
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

    const parsed = parseOpenClawConfigGuardOutput("preflight", result);
    expect(parsed.issueCodes).toEqual(["hardlinked-config-file"]);
    expect(parsed.issues).toEqual(
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

  it("sanitizes non-printable bytes and caps oversized guard issue text", () => {
    const result: PrivilegedExecResult = {
      status: 1,
      signal: null,
      stdout: [
        JSON.stringify({
          type: "issue",
          code: "transition-failed\u001b[31m",
          path: `${OPENCLAW_CONFIG_DIR}/openclaw.json\u0007`,
          detail: `quarantined as .nemoclaw-rejected-openclaw.json-abc\u0000\u001b]0;title\u0007${"x".repeat(4096)}`,
        }),
        JSON.stringify({ type: "result", action: "lock", status: "failed" }),
      ].join("\n"),
      stderr: "",
    };

    const issues = parseOpenClawConfigGuardOutput("lock", result).issues;

    expect(issues[0]).toContain("[transition-failed");
    expect(issues[0]).toContain("quarantined as .nemoclaw-rejected-openclaw.json-abc");
    expect(issues[0]).not.toMatch(/[^\x20-\x7e]/);
    expect(issues[0]?.length).toBeLessThan(2500);
  });

  it("propagates the guard's synthesized-hash marker on a successful lock", () => {
    const synthesized: PrivilegedExecResult = {
      status: 0,
      signal: null,
      stdout: `${JSON.stringify({
        type: "result",
        action: "lock",
        status: "ok",
        configDir: OPENCLAW_CONFIG_DIR,
        files: ["openclaw.json", ".config-hash"],
        chattrApplied: false,
        hashSynthesized: true,
      })}\n`,
      stderr: "",
    };
    const plain: PrivilegedExecResult = {
      status: 0,
      signal: null,
      stdout: `${success("lock")}\n`,
      stderr: "",
    };

    const parsed = parseOpenClawConfigGuardOutput("lock", synthesized);

    expect(parsed.issues).toEqual([]);
    expect(parsed.hashSynthesized).toBe(true);
    expect(parseOpenClawConfigGuardOutput("lock", plain).hashSynthesized).toBeUndefined();
  });

  it("propagates the guard's re-sealed-drift marker on a successful lock", () => {
    const resealed: PrivilegedExecResult = {
      status: 0,
      signal: null,
      stdout: `${JSON.stringify({
        type: "result",
        action: "lock",
        status: "ok",
        configDir: OPENCLAW_CONFIG_DIR,
        files: ["openclaw.json", ".config-hash"],
        chattrApplied: false,
        resealedDrift: true,
      })}\n`,
      stderr: "",
    };
    const plain: PrivilegedExecResult = {
      status: 0,
      signal: null,
      stdout: `${success("lock")}\n`,
      stderr: "",
    };

    const parsed = parseOpenClawConfigGuardOutput("lock", resealed);

    expect(parsed.issues).toEqual([]);
    expect(parsed.resealedDrift).toBe(true);
    expect(parseOpenClawConfigGuardOutput("lock", plain).resealedDrift).toBeUndefined();
  });
});

describe("OpenClaw config guard failed-startup recovery wiring (#8304)", () => {
  it("accepts the recovery action's result record instead of discarding it", () => {
    const { privileged } = createExec(true);

    const result = runOpenClawConfigGuard(privileged, "unlock-failed-startup", {
      planJson: '{"version":1}',
    });

    // A missing entry in the parser's action set turns a successful guard run
    // into an "unknown record" issue, which silently disables the whole path.
    expect(result.issues).toEqual([]);
  });

  it("outlasts the guard's own recursive fan-out budget and forwards the plan", () => {
    const { calls, privileged } = createExec(true);

    runOpenClawConfigGuard(privileged, "unlock-failed-startup", { planJson: '{"version":1}' });
    const recovery = calls
      .map(({ cmd }) => cmd)
      .find((cmd) => cmd.includes("unlock-failed-startup"));

    // The guard allows the state-dir fan-out and rollback 22m, so a 5m host timeout would
    // kill it mid-unseal, past its rollback and its JSON error contract.
    expect(recovery?.slice(0, 4)).toEqual(["timeout", "--signal=TERM", "--kill-after=5s", "25m"]);
    const planIndex = recovery?.indexOf("--plan-json") ?? -1;
    expect(planIndex).toBeGreaterThan(-1);
    expect(recovery?.[planIndex + 1]).toBe('{"version":1}');
  });

  it("rejects a missing recovery plan before privileged execution", () => {
    for (const planJson of [undefined, ""]) {
      const { calls, privileged } = createExec(true);
      const result = runOpenClawConfigGuard(privileged, "unlock-failed-startup", {
        planJson,
      });

      expect(result).toEqual({
        issues: ["OpenClaw config guard unlock-failed-startup requires planJson"],
        chattrApplied: false,
      });
      expect(calls).toEqual([]);
    }
  });

  it("refuses the recovery action when the sandbox has no installed guard", () => {
    const { privileged } = createExec(false);

    const result = runOpenClawConfigGuard(privileged, "unlock-failed-startup", {
      planJson: '{"version":1}',
    });

    expect(result.issues).toEqual([
      "OpenClaw config guard is absent in the sandbox; rebuild before recovering a failed startup",
    ]);
  });
});
