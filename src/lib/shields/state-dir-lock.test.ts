// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { AgentStateLockPlan } from "../agent/definition-types";
import type { PrivilegedExec } from "./state-dir-lock";
import {
  applyStateDirLockMode,
  CONTAINER_STATE_LOCK_PLAN,
  preflightStateDirLock,
  restoreStateDirLockPosture,
  restoreStateDirStartupAccess,
  stateLockPlanCompatibilityIssues,
} from "./state-dir-lock";

type RunCall = { cmd: string[]; input?: string };

const PLAN: AgentStateLockPlan = {
  version: 1,
  readOnlyRoots: ["skills"],
  confidentialRoots: ["credentials"],
  readOnlyPrefixes: ["workspace-"],
  confidentialPrefixes: [],
  writableSubpaths: ["agents/*/sessions"],
};

function success(action: string): string {
  return JSON.stringify({
    type: "result",
    action,
    status: "ok",
    roots: 0,
    directories: 0,
    files: 0,
    symlinks: 0,
    issueCount: 0,
  });
}

function createExec(
  runtimePlan: "current" | "historical" = "current",
  helperAvailable = true,
): {
  calls: RunCall[];
  privileged: PrivilegedExec;
} {
  const calls: RunCall[] = [];
  return {
    calls,
    privileged: {
      run: (cmd, input) => {
        calls.push({ cmd, input });
        switch (cmd[0]) {
          case "test":
            return {
              status:
                cmd.at(-1) === CONTAINER_STATE_LOCK_PLAN
                  ? runtimePlan === "current"
                    ? 0
                    : 1
                  : helperAvailable
                    ? 0
                    : 1,
              signal: null,
              stdout: "",
              stderr: "",
            };
          case "cat":
            return { status: 0, signal: null, stdout: JSON.stringify(PLAN), stderr: "" };
        }
        const pythonIndex = cmd.indexOf("python3");
        const action = cmd[pythonIndex + 3];
        return {
          status: 0,
          signal: null,
          stdout: `${success(action)}\n`,
          stderr: "",
        };
      },
    },
  };
}

function actions(calls: RunCall[]): string[] {
  return calls
    .filter(({ cmd }) => cmd.includes("python3"))
    .map(({ cmd }) => {
      const pythonIndex = cmd.indexOf("python3");
      return cmd[pythonIndex + 3];
    });
}

describe("recursive state-dir lock host wiring", () => {
  it("re-locks state directories when the interrupted transition began locked", () => {
    const { calls, privileged } = createExec();

    expect(restoreStateDirLockPosture(privileged, "/sandbox/.hermes", true, PLAN, true)).toEqual(
      [],
    );
    expect(actions(calls)).toEqual(["preflight", "lock"]);
  });

  it("restores mutable state directories when the interrupted transition began mutable", () => {
    const { calls, privileged } = createExec();

    expect(restoreStateDirLockPosture(privileged, "/sandbox/.hermes", false, PLAN, true)).toEqual(
      [],
    );
    expect(actions(calls)).toEqual(["unlock"]);
  });

  it("uses the current image's root-owned helper and generated plan", () => {
    const { calls, privileged } = createExec();

    expect(
      applyStateDirLockMode(privileged, "/sandbox/.openclaw", "root:sandbox", true, PLAN, true),
    ).toEqual([]);
    const invocation = calls.find(({ cmd }) => cmd.includes("python3"));
    expect(invocation?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "12m",
      "python3",
      "-I",
      "/usr/local/lib/nemoclaw/state-dir-guard.py",
      "lock",
      "--config-dir",
      "/sandbox/.openclaw",
      "--plan-file",
      CONTAINER_STATE_LOCK_PLAN,
    ]);
    expect(invocation?.input).toBeUndefined();
  });

  it("uses a historical image's co-bundled helper when no generated plan is installed", () => {
    const { calls, privileged } = createExec("historical");

    expect(
      applyStateDirLockMode(privileged, "/sandbox/.openclaw", "root:sandbox", true, PLAN, true),
    ).toEqual([]);

    const invocation = calls.find(({ cmd }) => cmd.includes("python3"));
    expect(invocation?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "12m",
      "python3",
      "-I",
      "/usr/local/lib/nemoclaw/state-dir-guard.py",
      "lock",
      "--config-dir",
      "/sandbox/.openclaw",
    ]);
    expect(invocation?.input).toBeUndefined();
  });

  it("injects the host helper only for an image that predates both bundled artifacts", () => {
    const { calls, privileged } = createExec("historical", false);

    expect(
      applyStateDirLockMode(privileged, "/sandbox/.openclaw", "root:sandbox", true, PLAN, true),
    ).toEqual([]);

    const invocation = calls.find(({ cmd }) => cmd.includes("python3"));
    expect(invocation?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "12m",
      "python3",
      "-I",
      "-",
      "lock",
      "--config-dir",
      "/sandbox/.openclaw",
      "--plan-json",
      JSON.stringify(PLAN),
    ]);
    expect(invocation?.input).toContain("Descriptor-safe recursive state-directory");
  });

  it("uses the current host guard for the narrow startup repair (#8112)", () => {
    const { calls, privileged } = createExec();

    expect(restoreStateDirStartupAccess(privileged, "/sandbox/.openclaw", PLAN)).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmd).toEqual([
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      "12m",
      "python3",
      "-I",
      "-",
      "startup",
      "--config-dir",
      "/sandbox/.openclaw",
      "--plan-json",
      JSON.stringify(PLAN),
    ]);
    expect(calls[0]?.input).toContain('choices=("preflight", "lock", "unlock", "startup")');
  });

  it("hands the manifest plan to an injected startup helper (#8006)", () => {
    const startupPlan: AgentStateLockPlan = { ...PLAN, readOnlyRoots: ["agents", "skills"] };
    let rawOutput = "";
    let spawnError: Error | undefined;
    const issues = restoreStateDirStartupAccess(
      {
        run: (cmd, input) => {
          const result = spawnSync(cmd[0]!, cmd.slice(1), {
            encoding: "utf-8",
            input,
            timeout: 15_000,
          });
          rawOutput = String(result.stdout) + String(result.stderr);
          spawnError = result.error;
          return {
            status: result.status,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            ...(result.error ? { error: result.error.message } : {}),
          };
        },
      },
      "/sandbox/.nemoclaw-startup-plan-test-" + String(process.pid),
      startupPlan,
    );

    expect(spawnError).toBeUndefined();
    expect(rawOutput).toContain('"action":"startup"');
    expect(rawOutput).not.toContain('"code":"invalid-plan"');
    expect(issues.join("\n")).not.toContain("[invalid-plan]");
  });

  it("injects the host helper and plan for agents without an image recovery plan", () => {
    const { calls, privileged } = createExec();

    expect(
      applyStateDirLockMode(privileged, "/sandbox/.deepagents", "root:sandbox", true, PLAN, false),
    ).toEqual([]);

    const invocation = calls.find(({ cmd }) => cmd.includes("python3"));
    expect(invocation?.cmd).toEqual(
      expect.arrayContaining(["python3", "-I", "-", "lock", "--plan-json", JSON.stringify(PLAN)]),
    );
    expect(invocation?.input).toContain("Descriptor-safe recursive state-directory");
  });

  it("rejects a plan-aware image whose installed helper is missing", () => {
    const { calls, privileged } = createExec("current", false);

    expect(
      applyStateDirLockMode(privileged, "/sandbox/.openclaw", "root:sandbox", true, PLAN, true),
    ).toEqual([
      "state-dir guard is unavailable in an image that contains a generated state lock plan",
    ]);
    expect(actions(calls)).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{", /not valid JSON/],
    ["an unknown field", JSON.stringify({ ...PLAN, registry: [] }), /unknown fields: registry/],
    [
      "a different policy",
      JSON.stringify({ ...PLAN, readOnlyRoots: ["hooks"] }),
      /differs from the current agent manifest/,
    ],
  ])("rejects an installed plan with %s before mutation", (_case, payload, expected) => {
    const privileged: PrivilegedExec = {
      run: (cmd) =>
        cmd[0] === "test"
          ? { status: 0, signal: null, stdout: "", stderr: "" }
          : { status: 0, signal: null, stdout: payload, stderr: "" },
    };

    expect(stateLockPlanCompatibilityIssues(privileged, PLAN, true)).toEqual([
      expect.stringMatching(expected),
    ]);
  });

  it("ignores SPDX metadata and JSON formatting when checking plan parity", () => {
    const privileged: PrivilegedExec = {
      run: (cmd) =>
        cmd[0] === "test"
          ? { status: 0, signal: null, stdout: "", stderr: "" }
          : {
              status: 0,
              signal: null,
              stdout: JSON.stringify({ $comment: "SPDX metadata", ...PLAN }, null, 2),
              stderr: "",
            },
    };

    expect(stateLockPlanCompatibilityIssues(privileged, PLAN, true)).toEqual([]);
  });

  it("treats installed plan arrays as unordered sets", () => {
    const reordered = {
      ...PLAN,
      readOnlyRoots: ["workspace", ...PLAN.readOnlyRoots],
      writableSubpaths: ["workspace/*/sessions", ...PLAN.writableSubpaths],
    };
    const expected = {
      ...PLAN,
      readOnlyRoots: [...reordered.readOnlyRoots].reverse(),
      writableSubpaths: [...reordered.writableSubpaths].reverse(),
    };
    const privileged: PrivilegedExec = {
      run: (cmd) =>
        cmd[0] === "test"
          ? { status: 0, signal: null, stdout: "", stderr: "" }
          : { status: 0, signal: null, stdout: JSON.stringify(reordered), stderr: "" },
    };

    expect(stateLockPlanCompatibilityIssues(privileged, expected, true)).toEqual([]);
  });

  it("surfaces structured helper findings and rejects contradictory exit contracts", () => {
    const privileged: PrivilegedExec = {
      run: (cmd) => {
        switch (cmd[0]) {
          case "test":
            return { status: 0, signal: null, stdout: "", stderr: "" };
          case "cat":
            return { status: 0, signal: null, stdout: JSON.stringify(PLAN), stderr: "" };
        }
        return {
          status: 0,
          signal: null,
          stdout: [
            JSON.stringify({
              type: "issue",
              code: "hardlinked-entry",
              path: "/sandbox/.openclaw/plugins/x",
              detail: "link count is 2",
            }),
            JSON.stringify({
              type: "result",
              action: "preflight",
              status: "failed",
              issueCount: 1,
            }),
          ].join("\n"),
          stderr: "",
        };
      },
    };

    expect(preflightStateDirLock(privileged, "/sandbox/.openclaw", PLAN, true)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[hardlinked-entry]"),
        expect.stringContaining("reported failure with a zero exit"),
      ]),
    );
  });
});
