// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { OpenShellSandboxBufferedCommandExecutor } from "../../src/lib/adapters/openshell/sandbox-command";
import {
  createDockerFinalHandoffCaptureFixture,
  createDockerFinalHandoffRunFixture,
} from "../../src/lib/onboard/__test-helpers__/docker-gpu-patch-fixtures";
import { getDockerGpuPatchFailureContext } from "../../src/lib/onboard/docker-gpu-patch";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "../../src/lib/onboard/docker-startup-command-patch";

const OLD_CONTAINER_ID = "a".repeat(64);
const NEW_CONTAINER_ID = "b".repeat(64);

function commandExecutorThrough(
  runOpenshell: (
    args: string[],
    opts?: Record<string, unknown>,
  ) => { status: number | null; stdout?: string; stderr?: string },
): OpenShellSandboxBufferedCommandExecutor {
  return {
    runBuffered: vi.fn(async (request) => {
      const result = runOpenshell(
        ["sandbox", "exec", "-n", request.sandboxName, "--", ...request.command],
        { ignoreError: true, suppressOutput: true },
      );
      return {
        outcome:
          result.status === null
            ? {
                kind: "failed" as const,
                error: { kind: "invocation" as const, message: "failed" },
              }
            : { kind: "completed" as const, exitCode: result.status },
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    }),
  };
}

describe("Docker final handoff lifecycle integration", () => {
  it("commits only between authoritative OpenShell stop and start receipts (#10153)", async () => {
    const events: string[] = [];
    const dockerStop = vi.fn((containerId: string) => {
      events.push(
        containerId === OLD_CONTAINER_ID ? "stop original for recreate" : "stop exact replacement",
      );
      return { status: 0 };
    });
    const dockerRm = vi.fn(() => {
      events.push("remove exact backup");
      return { status: 0 };
    });
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => {
      events.push("observe replacement ready");
      return "alpha  2026-08-23 10:00:06  Ready\n";
    });
    const runOpenshell = vi.fn((args: string[]) => {
      events.push(
        args[1] === "stop"
          ? "stop through OpenShell"
          : args[1] === "start"
            ? "start through OpenShell"
            : args[1] === "exec" && events.includes("stop through OpenShell")
              ? "exec final ready"
              : "exec supervisor ready",
      );
      return { status: 0 };
    });

    const result = await recreateOpenShellDockerSandboxWithStartupCommand(
      {
        sandboxName: "alpha",
        expectedOldContainerId: OLD_CONTAINER_ID,
        openshellSandboxCommand: ["sleep", "infinity"],
        timeoutSecs: 4,
      },
      {
        dockerCapture: vi.fn(createDockerFinalHandoffCaptureFixture(OLD_CONTAINER_ID)),
        dockerRun: vi.fn(createDockerFinalHandoffRunFixture(NEW_CONTAINER_ID)),
        dockerRunDetached: vi.fn(() => ({ status: 0, stdout: `${NEW_CONTAINER_ID}\n` })),
        dockerRename: vi.fn(() => ({ status: 0 })),
        dockerStop,
        dockerRm,
        dockerStart,
        runCaptureOpenshell,
        runOpenshell,
        commandExecutor: commandExecutorThrough(runOpenshell),
        sleep: vi.fn(),
        now: () => new Date("2026-05-12T00:00:00Z"),
        detectSandboxFallbackDns: vi.fn(() => null),
        readDir: vi.fn(() => null),
        readFile: vi.fn(() => null),
      },
    );

    expect(result).toMatchObject({
      backupRemoved: true,
      mode: { kind: "startup-command" },
      newContainerId: NEW_CONTAINER_ID,
      oldContainerId: OLD_CONTAINER_ID,
    });
    expect(events).toEqual([
      "stop original for recreate",
      "exec supervisor ready",
      "stop through OpenShell",
      "stop exact replacement",
      "remove exact backup",
      "start through OpenShell",
      "observe replacement ready",
      "exec final ready",
    ]);
    expect(dockerRm).toHaveBeenCalledWith(OLD_CONTAINER_ID, expect.any(Object));
    expect(dockerStart).not.toHaveBeenCalled();
  });

  it("does not cross the final Docker commit when authoritative OpenShell stop fails (#10153)", async () => {
    const dockerStop = vi.fn(() => ({ status: 0 }));
    const dockerRm = vi.fn(() => ({ status: 0 }));
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const runCaptureOpenshell = vi.fn(() => "alpha  2026-08-23 10:00:00  Ready\n");
    const runOpenshell = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce({ status: 1 });
    let failure: unknown;

    try {
      await recreateOpenShellDockerSandboxWithStartupCommand(
        {
          sandboxName: "alpha",
          expectedOldContainerId: OLD_CONTAINER_ID,
          openshellSandboxCommand: ["sleep", "infinity"],
          timeoutSecs: 1,
        },
        {
          dockerCapture: vi.fn(createDockerFinalHandoffCaptureFixture(OLD_CONTAINER_ID)),
          dockerRun: vi.fn(createDockerFinalHandoffRunFixture(NEW_CONTAINER_ID)),
          dockerRunDetached: vi.fn(() => ({ status: 0, stdout: `${NEW_CONTAINER_ID}\n` })),
          dockerRename: vi.fn(() => ({ status: 0 })),
          dockerStop,
          dockerRm,
          dockerStart,
          runCaptureOpenshell,
          runOpenshell,
          commandExecutor: commandExecutorThrough(runOpenshell),
          sleep: vi.fn(),
          now: () => new Date("2026-05-12T00:00:00Z"),
          detectSandboxFallbackDns: vi.fn(() => null),
          readDir: vi.fn(() => null),
          readFile: vi.fn(() => null),
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("final replacement handoff");
    expect(getDockerGpuPatchFailureContext(failure)).toMatchObject({
      backupRemoved: false,
      newContainerId: NEW_CONTAINER_ID,
      oldContainerId: OLD_CONTAINER_ID,
      rolledBack: false,
    });
    expect(runCaptureOpenshell).not.toHaveBeenCalled();
    expect(dockerStop).toHaveBeenCalledTimes(1);
    expect(dockerStop).toHaveBeenCalledWith(OLD_CONTAINER_ID, expect.any(Object));
    expect(dockerRm).not.toHaveBeenCalled();
    expect(dockerStart).not.toHaveBeenCalled();
  });
});
