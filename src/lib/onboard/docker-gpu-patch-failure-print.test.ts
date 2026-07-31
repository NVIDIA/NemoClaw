// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import {
  buildDockerGpuMode,
  type DockerGpuPatchFailureClassification,
  printDockerGpuPatchFailureAndExit,
} from "./docker-gpu-patch";

const PRE_ROLLBACK: DockerGpuPatchFailureClassification = {
  kind: "patched_container_failed",
  headline: "Patched GPU container exited with code 127 (--gpus all).",
  summaryLines: ["patched_container_exit_code=127"],
  hints: ["Exit code 127 means the sandbox image does not provide the managed startup command."],
};

/**
 * Drive the printer and return everything it wrote to stderr. Diagnostics
 * persistence is disabled so the assertions only observe console output.
 */
function printAndCapture(deps: Parameters<typeof printDockerGpuPatchFailureAndExit>[2]): string {
  const output: string[] = [];
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    output.push(args.map(String).join(" "));
  });
  const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
    throw new Error("diagnostics disabled for test");
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
    throw new Error("__test_exit__");
  }) as never);
  try {
    expect(() =>
      printDockerGpuPatchFailureAndExit("alpha", new Error("supervisor did not reconnect"), deps),
    ).toThrow(/__test_exit__/);
    return output.join("\n");
  } finally {
    exitSpy.mockRestore();
    mkdirSpy.mockRestore();
    errorSpy.mockRestore();
  }
}

describe("Docker GPU patch failure reporting (#7996)", () => {
  it("prefers the pre-rollback verdict once rollback has erased the container", () => {
    // Rollback already removed the replacement container, so a fresh inspect
    // returns nothing and the sandbox only shows a generic Error phase.
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
      },
      preRollbackClassification: PRE_ROLLBACK,
    });

    expect(stderr).toContain("Patched GPU container exited with code 127");
    expect(stderr).toContain("patched_container_exit_code=127");
    expect(stderr).toContain("does not provide the managed startup command");
    expect(stderr).not.toContain("entered Error phase");
  });

  it("keeps the freshly observed verdict when the container is still inspectable", () => {
    // The live snapshot has first-hand evidence, so a stale pre-rollback
    // verdict must not overwrite it.
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => JSON.stringify({ Status: "exited", ExitCode: 125 })),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
      },
      preRollbackClassification: PRE_ROLLBACK,
    });

    expect(stderr).toContain("Patched GPU container exited with code 125");
    expect(stderr).not.toContain("code 127");
  });

  it("falls back to the observed verdict when no pre-rollback verdict was captured", () => {
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
      },
      preRollbackClassification: null,
    });

    expect(stderr).toContain("entered Error phase");
  });
});
