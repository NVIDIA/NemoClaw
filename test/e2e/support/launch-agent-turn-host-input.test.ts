// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { runOpenClawLaunchSession } from "../live/launch-agent-turn.ts";

it.runIf(process.platform === "linux")(
  "rejects a relative OpenShell command before launching a host command (#9160)",
  async () => {
    let commandCallCount = 0;
    const host = {
      command: async () => {
        commandCallCount += 1;
        return { exitCode: 0, signal: null, stderr: "", stdout: "" };
      },
      openshellCommandPath: "openshell",
    };
    await expect(
      runOpenClawLaunchSession({
        artifactName: "relative-openshell-command",
        cliCommand: "node",
        env: {},
        host: host as never,
        redactionValues: [],
        sandboxName: "alpha",
      }),
    ).rejects.toThrow("launch session coverage requires an absolute OpenShell command path");
    expect(commandCallCount).toBe(0);
  },
);

it.each(["", "relative-tmp", "/tmp/absolute-tmp"])(
  "passes an absolute host temporary root for empty, relative, or absolute TMPDIR input [%s] (#9160)",
  async (root) => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const roots: Array<string | undefined> = [];
    const host = {
      command: async (_command: string, _args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
        roots.push(options?.env?.NEMOCLAW_LAUNCH_HOST_TMP_ROOT);
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
      openshellCommandPath: "/usr/bin/openshell",
    };
    try {
      await runOpenClawLaunchSession({
        artifactName: "host-temporary-root",
        cliCommand: "node",
        env: { TMPDIR: root },
        host: host as never,
        redactionValues: [],
        sandboxName: "alpha",
      });
      expect(roots).toEqual([root === "" ? resolve("/tmp") : resolve(root)]);
    } finally {
      platform.mockRestore();
    }
  },
);
