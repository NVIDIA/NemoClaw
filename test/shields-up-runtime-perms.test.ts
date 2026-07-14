// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  CONFIDENTIALITY_STATE_DIRS,
  HIGH_RISK_STATE_DIRS,
  WRITABLE_RUNTIME_SUBPATHS,
} from "../src/lib/shields/state-dir-lock";

const OPENCLAW_GUARD = "/usr/local/lib/nemoclaw/openclaw-config-guard.py";
const STATE_DIR_GUARD = "/usr/local/lib/nemoclaw/state-dir-guard.py";

type GuardProbeResult = {
  calls: string[][];
  status: number | null;
  stderr: string;
};

function runLockAgentConfigProbe(
  options: { stateDirIssuePath?: string; malformedStateDirOutput?: boolean } = {},
): GuardProbeResult {
  const probe = spawnSync(
    process.execPath,
    [
      "-e",
      String.raw`
const Module = require("node:module");
const originalLoad = Module._load;
const calls = [];
const stateDirIssuePath = ${JSON.stringify(options.stateDirIssuePath ?? null)};
const malformedStateDirOutput = ${JSON.stringify(options.malformedStateDirOutput === true)};

function commandFromArgs(args) {
  const separator = args.indexOf("--");
  return separator >= 0 ? args.slice(separator + 1) : args;
}

function completed(stdout = "", status = 0) {
  return { status, signal: null, stdout, stderr: "" };
}

function guardAction(command, helper) {
  const helperIndex = command.indexOf(helper);
  return helperIndex >= 0 ? command[helperIndex + 1] : null;
}

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "../adapters/docker/exec") {
    return {
      dockerExecFileSync(args) {
        const command = commandFromArgs(args);
        calls.push(command);
        if (command[0] === "stat" && command[1] === "-c") {
          if (command.at(-1) === "/sandbox") return "1775 root:sandbox\n";
          if (command.at(-1) === "/sandbox/.openclaw") return "755 root:root\n";
          return "444 root:root\n";
        }
        if (command[0] === "lsattr") {
          return "----i----------------- " + command.at(-1) + "\n";
        }
        if (command[0] === "sha256sum") {
          return (
            "0000000000000000000000000000000000000000000000000000000000000001  " +
            command.at(-1) +
            "\n"
          );
        }
        return "";
      },
      dockerSpawnSync(args) {
        const command = commandFromArgs(args);
        calls.push(command);
        if (command[0] === "test" && command[1] === "-r") return completed();

        const openClawAction = guardAction(command, ${JSON.stringify(OPENCLAW_GUARD)});
        if (openClawAction) {
          return completed(
            JSON.stringify({
              type: "result",
              action: openClawAction,
              status: "ok",
              configDir: "/sandbox/.openclaw",
              files: ["openclaw.json", ".config-hash"],
              chattrApplied: true,
            }) + "\n",
          );
        }

        const stateDirAction = guardAction(command, ${JSON.stringify(STATE_DIR_GUARD)});
        if (stateDirAction) {
          if (malformedStateDirOutput) return completed("not-json\n");
          if (stateDirIssuePath && stateDirAction === "lock") {
            return completed(
              [
                JSON.stringify({
                  type: "issue",
                  code: "state-root-symlink",
                  path: stateDirIssuePath,
                  detail: "state-dir roots must not be symlinks",
                }),
                JSON.stringify({
                  type: "result",
                  action: "lock",
                  status: "failed",
                  issueCount: 1,
                }),
              ].join("\n") + "\n",
              1,
            );
          }
          return completed(
            JSON.stringify({
              type: "result",
              action: stateDirAction,
              status: "ok",
              issueCount: 0,
            }) + "\n",
          );
        }
        return completed("", 127);
      },
    };
  }
  if (request === "../sandbox/privileged-exec") {
    return {
      privilegedSandboxExecArgv(_sandboxName, cmd) {
        return [...cmd];
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { lockAgentConfig } = require("./src/lib/shields/index.ts");
  lockAgentConfig(
    "sandbox-pod",
    {
      agentName: "openclaw",
      configPath: "/sandbox/.openclaw/openclaw.json",
      configDir: "/sandbox/.openclaw",
      sensitiveFiles: ["/sandbox/.openclaw/.config-hash"],
    },
    false,
  );
  process.stdout.write(JSON.stringify(calls));
} catch (error) {
  process.stdout.write(JSON.stringify(calls));
  process.stderr.write(error && error.message ? error.message : String(error));
  process.exitCode = 2;
}
`,
    ],
    { encoding: "utf-8", timeout: 5000 },
  );
  return {
    calls: probe.stdout ? (JSON.parse(probe.stdout) as string[][]) : [],
    status: probe.status,
    stderr: probe.stderr,
  };
}

function helperCalls(calls: string[][], helper: string, action?: string): string[][] {
  return calls.filter((command) => {
    const helperIndex = command.indexOf(helper);
    if (helperIndex < 0) return false;
    return action === undefined || command[helperIndex + 1] === action;
  });
}

describe("shields-up state-dir lock preserves sandbox-group access + runtime sessions writable", () => {
  it("uses the installed descriptor-safe guards for top-level and recursive lockdown", () => {
    const result = runLockAgentConfigProbe();
    expect(result.status, result.stderr).toBe(0);

    const configLocks = helperCalls(result.calls, OPENCLAW_GUARD, "lock");
    const stateLocks = helperCalls(result.calls, STATE_DIR_GUARD, "lock");
    expect(configLocks).toHaveLength(1);
    expect(stateLocks).toHaveLength(1);
    for (const command of [...configLocks, ...stateLocks]) {
      expect(command).toEqual(expect.arrayContaining(["python3", "-I"]));
      expect(command).toEqual(expect.arrayContaining(["--config-dir", "/sandbox/.openclaw"]));
    }
  });

  it("freezes the canonical config before recursive state containment", () => {
    const result = runLockAgentConfigProbe();
    expect(result.status, result.stderr).toBe(0);

    const configLockIndex = result.calls.findIndex(
      (command) => helperCalls([command], OPENCLAW_GUARD, "lock").length === 1,
    );
    const stateLockIndex = result.calls.findIndex(
      (command) => helperCalls([command], STATE_DIR_GUARD, "lock").length === 1,
    );
    expect(configLockIndex).toBeGreaterThanOrEqual(0);
    expect(stateLockIndex).toBeGreaterThan(configLockIndex);
  });

  it("keeps the complete protected inventory and writable sessions carve-out", () => {
    expect(HIGH_RISK_STATE_DIRS).toEqual(
      expect.arrayContaining(["skills", "agent", "hooks", "agents", "extensions", "workspace"]),
    );
    expect(CONFIDENTIALITY_STATE_DIRS).toEqual(["credentials", "identity", "pairing"]);
    expect(WRITABLE_RUNTIME_SUBPATHS).toEqual(["agents/*/sessions"]);
  });

  it.each([
    "extensions",
    "agent",
  ])("surfaces a recursive guard refusal for a symlinked %s root", (root) => {
    const unsafePath = `/sandbox/.openclaw/${root}`;
    const result = runLockAgentConfigProbe({ stateDirIssuePath: unsafePath });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Config not locked");
    expect(result.stderr).toContain("state-dir guard lock [state-root-symlink]");
    expect(result.stderr).toContain(unsafePath);
    expect(result.stderr).toContain("state-dir roots must not be symlinks");
  });

  it("preserves the top-level seal when recursive containment refuses", () => {
    const result = runLockAgentConfigProbe({
      stateDirIssuePath: "/sandbox/.openclaw/extensions",
    });
    expect(result.status).toBe(2);

    expect(helperCalls(result.calls, OPENCLAW_GUARD, "lock")).toHaveLength(2);
    expect(helperCalls(result.calls, OPENCLAW_GUARD, "unlock")).toHaveLength(0);
    expect(helperCalls(result.calls, STATE_DIR_GUARD, "lock")).toHaveLength(1);
  });

  it("fails closed when the recursive helper violates its output contract", () => {
    const result = runLockAgentConfigProbe({ malformedStateDirOutput: true });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("state-dir guard returned non-JSON output");
    expect(result.stderr).toContain("state-dir guard returned 0 result records");
    expect(helperCalls(result.calls, OPENCLAW_GUARD, "lock")).toHaveLength(2);
    expect(helperCalls(result.calls, OPENCLAW_GUARD, "unlock")).toHaveLength(0);
  });
});
