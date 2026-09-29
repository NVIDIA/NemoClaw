// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  captureHostCommand,
  captureOpenShellHostCommand,
  openShellSandboxNeedsLifecycleStart,
  readOpenShellSandboxPhase,
} from "./doctor-host-command";

describe("captureHostCommand", () => {
  it("treats signal-terminated processes as failed", () => {
    const result = captureHostCommand(process.execPath, [
      "-e",
      "process.kill(process.pid, 'SIGTERM')",
    ]);

    expect(result.status).not.toBe(0);
  });
});

describe("captureOpenShellHostCommand", () => {
  it("resolves from the source environment without forwarding provider credentials", () => {
    const environment = {
      HOME: "/test-home",
      PATH: "/test-bin",
      NEMOCLAW_OPENSHELL_BIN: process.execPath,
      NVIDIA_INFERENCE_API_KEY: "provider-secret",
      XDG_CONFIG_HOME: "/test-home/.config",
    };

    expect(
      captureOpenShellHostCommand(
        [
          "-e",
          "process.stdout.write(JSON.stringify({home:process.env.HOME,path:process.env.PATH,config:process.env.XDG_CONFIG_HOME,provider:process.env.NVIDIA_INFERENCE_API_KEY,resolver:process.env.NEMOCLAW_OPENSHELL_BIN}))",
        ],
        environment,
        5_000,
      ),
    ).toMatchObject({
      status: 0,
      output: '{"home":"/test-home","path":"/test-bin","config":"/test-home/.config"}',
    });
  });

  it("fails closed when no absolute executable can be resolved", () => {
    expect(
      captureOpenShellHostCommand([], {}, 5_000, { resolveExecutable: () => null }),
    ).toMatchObject({ status: 1, output: "OpenShell is unavailable" });
  });
});

describe("readOpenShellSandboxPhase", () => {
  it("reads the selected sandbox through the exact OpenShell command", () => {
    const captureCommand = vi.fn(() => ({ status: 0, output: "Phase: Stopped\n" }));
    const environment = { HOME: "/test-home" };

    expect(
      readOpenShellSandboxPhase("alpha", "nemoclaw-8091", environment, 30_000, {
        captureCommand,
      }),
    ).toBe("Stopped");
    expect(captureCommand).toHaveBeenCalledWith(
      ["sandbox", "get", "-g", "nemoclaw-8091", "alpha"],
      environment,
      30_000,
      expect.any(Object),
    );
  });

  it("returns null when the OpenShell command fails", () => {
    expect(
      readOpenShellSandboxPhase("alpha", "nemoclaw", {}, 30_000, {
        captureCommand: () => ({ status: 1, output: "gateway unavailable" }),
      }),
    ).toBeNull();
  });

  it.each([
    ["Phase: Stopped\n", true],
    ["Phase: Ready\n", false],
  ])("owns the lifecycle-start decision for %j", (output, expected) => {
    expect(
      openShellSandboxNeedsLifecycleStart("alpha", "nemoclaw", {}, 30_000, {
        captureCommand: () => ({ status: 0, output }),
      }),
    ).toBe(expected);
  });
});
