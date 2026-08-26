// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createDockerFinalHandoffCaptureFixture,
  createDockerFinalHandoffRunFixture,
} from "../../src/lib/onboard/__test-helpers__/docker-gpu-patch-fixtures";
import { getDockerGpuPatchFailureContext } from "../../src/lib/onboard/docker-gpu-patch";
import { recreateOpenShellDockerSandboxWithStartupCommand } from "../../src/lib/onboard/docker-startup-command-patch";

const OLD_CONTAINER_ID = "a".repeat(64);
const NEW_CONTAINER_ID = "b".repeat(64);

describe("Docker final handoff lifecycle integration", () => {
  it("restarts only after Error and Deleting release the selected sandbox name (#10153)", () => {
    const events: string[] = [];
    const dockerStart = vi.fn(() => {
      events.push("start replacement");
      return { status: 0 };
    });
    const runCaptureOpenshell = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("observe error");
        return "alpha  2026-08-23 10:00:00  Error\n";
      })
      .mockImplementationOnce(() => {
        events.push("observe deleting");
        return "alpha  2026-08-23 10:00:02  Deleting\n";
      })
      .mockImplementationOnce(() => {
        events.push("observe name absence");
        return "beta  2026-08-23 10:00:04  Ready\n";
      })
      .mockImplementationOnce(() => {
        events.push("observe replacement ready");
        return "alpha  2026-08-23 10:00:06  Ready\n";
      });

    const result = recreateOpenShellDockerSandboxWithStartupCommand(
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
        dockerStop: vi.fn(() => ({ status: 0 })),
        dockerRm: vi.fn(() => ({ status: 0 })),
        dockerStart,
        runCaptureOpenshell,
        runOpenshell: vi.fn(() => ({ status: 0 })),
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
      "observe error",
      "observe deleting",
      "observe name absence",
      "start replacement",
      "observe replacement ready",
    ]);
  });

  it("never restarts when Error advances to Deleting without a name-absence receipt (#10153)", () => {
    const dockerStart = vi.fn(() => ({ status: 0 }));
    const runCaptureOpenshell = vi
      .fn()
      .mockReturnValueOnce("alpha  2026-08-23 10:00:00  Error\n")
      .mockReturnValue("alpha  2026-08-23 10:00:02  Deleting\n");
    let failure: unknown;

    try {
      recreateOpenShellDockerSandboxWithStartupCommand(
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
          dockerStop: vi.fn(() => ({ status: 0 })),
          dockerRm: vi.fn(() => ({ status: 0 })),
          dockerStart,
          runCaptureOpenshell,
          runOpenshell: vi.fn(() => ({ status: 0 })),
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
      backupRemoved: true,
      newContainerId: NEW_CONTAINER_ID,
      oldContainerId: OLD_CONTAINER_ID,
      rolledBack: false,
    });
    expect(runCaptureOpenshell).toHaveBeenCalledTimes(2);
    expect(dockerStart).not.toHaveBeenCalled();
  });
});
