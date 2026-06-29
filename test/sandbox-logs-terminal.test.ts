// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import { showSandboxLogsWithDeps } from "../src/lib/actions/sandbox/logs.js";

function makeSpawnChild(): EventEmitter & {
  exitCode: number | null;
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
  signalCode: NodeJS.Signals | null;
} {
  return Object.assign(new EventEmitter(), {
    exitCode: null,
    killed: false,
    signalCode: null,
    kill(_signal?: NodeJS.Signals) {
      this.killed = true;
      return true;
    },
  });
}

describe("sandbox logs for terminal agents", () => {
  it("skips the OpenClaw gateway log source but keeps OpenShell audit logs", () => {
    const calls: string[] = [];
    let exitCode: number | null = null;

    try {
      showSandboxLogsWithDeps(
        "deepagents-code",
        { follow: false, lines: "20", since: null },
        {
          getSessionAgent: () =>
            ({
              runtime: { kind: "terminal" },
            }) as never,
          isDockerRuntimeDown: () => false,
          runOpenshell: (args) => {
            calls.push(args.join(" "));
            return {
              status: 0,
              stdout: args[0] === "logs" ? "openshell audit line\n" : "",
              stderr: "",
            };
          },
          writeStdout: () => undefined,
          exit: ((code: number): never => {
            exitCode = code;
            throw new Error("exit");
          }) as never,
        },
      );
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("exit");
    }

    expect(exitCode).toBe(0);
    expect(calls).toContain("settings set deepagents-code --key ocsf_json_enabled --value true");
    expect(calls).toContain("logs deepagents-code -n 20 --source all");
    expect(calls.some((call) => call.includes("/tmp/gateway.log"))).toBe(false);
  });

  it("logs --follow spawns only the OpenShell source for terminal agents", () => {
    const calls: string[] = [];
    let exitCode: number | null = null;
    let child: ReturnType<typeof makeSpawnChild> | null = null;

    showSandboxLogsWithDeps(
      "deepagents-code",
      { follow: true, lines: "20", since: null },
      {
        getOpenshellBinary: () => "openshell",
        getSessionAgent: () =>
          ({
            runtime: { kind: "terminal" },
          }) as never,
        isDockerRuntimeDown: () => false,
        runOpenshell: (args) => {
          calls.push(args.join(" "));
          return { status: 0, stdout: "", stderr: "" };
        },
        spawn: ((_bin: string, args: string[]) => {
          calls.push(args.join(" "));
          child = makeSpawnChild();
          return child as never;
        }) as never,
        exit: ((code: number): never => {
          exitCode = code;
          throw new Error("exit");
        }) as never,
      },
    );

    expect(calls).toContain("settings set deepagents-code --key ocsf_json_enabled --value true");
    expect(
      calls.some(
        (call) =>
          call.startsWith("logs deepagents-code") &&
          call.includes("-n 20") &&
          call.includes("--source all") &&
          call.includes("--tail"),
      ),
    ).toBe(true);
    expect(calls.some((call) => call.includes("/tmp/gateway.log"))).toBe(false);
    expect(child).not.toBeNull();
    expect(() => child?.emit("exit", 0, null)).toThrow("exit");
    expect(exitCode).toBe(0);
  });
});
