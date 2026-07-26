// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { PrivilegedExec } from "./state-dir-lock";
import {
  applyStateDirLockMode,
  preflightStateDirLock,
  restoreStateDirLockPosture,
} from "./state-dir-lock";

type RunCall = { cmd: string[]; input?: string };

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

function createExec(installed = true): { calls: RunCall[]; privileged: PrivilegedExec } {
  const calls: RunCall[] = [];
  return {
    calls,
    privileged: {
      run: (cmd, input) => {
        calls.push({ cmd, input });
        switch (cmd[0]) {
          case "test":
            return {
              status: installed ? 0 : 1,
              signal: null,
              stdout: "",
              stderr: "",
            };
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

    expect(restoreStateDirLockPosture(privileged, "/sandbox/.hermes", true)).toEqual([]);
    expect(actions(calls)).toEqual(["preflight", "lock"]);
  });

  it("restores mutable state directories when the interrupted transition began mutable", () => {
    const { calls, privileged } = createExec();

    expect(restoreStateDirLockPosture(privileged, "/sandbox/.hermes", false)).toEqual([]);
    expect(actions(calls)).toEqual(["unlock"]);
  });

  it("injects the trusted host helper into old images instead of using recursive shell commands", () => {
    const { calls, privileged } = createExec(false);

    expect(applyStateDirLockMode(privileged, "/sandbox/.openclaw", "root:sandbox", true)).toEqual(
      [],
    );
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
    ]);
    expect(invocation?.input).toContain("Descriptor-safe recursive state-directory");
  });

  it("surfaces structured helper findings and rejects contradictory exit contracts", () => {
    const privileged: PrivilegedExec = {
      run: (cmd) => {
        switch (cmd[0]) {
          case "test":
            return { status: 0, signal: null, stdout: "", stderr: "" };
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

    expect(preflightStateDirLock(privileged, "/sandbox/.openclaw")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("[hardlinked-entry]"),
        expect.stringContaining("reported failure with a zero exit"),
      ]),
    );
  });
});
