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
  selectedModeKind: "gpus",
  summaryLines: ["patched_container_exit_code=127", "patched_create_option=--gpus all"],
  hints: [
    "Container logs show that the sandbox image does not provide the NemoClaw-managed `nemoclaw-start` command.",
  ],
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
  it("prefers the pre-rollback verdict when fresh inspection cannot find the replacement", () => {
    // Fresh inspection returns nothing after rollback, and the sandbox only
    // shows a generic Error phase.
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
        rolledBack: true,
      },
      preRollbackClassification: PRE_ROLLBACK,
    });

    expect(stderr).toContain("Patched GPU container exited with code 127");
    expect(stderr).toContain("patched_container_exit_code=127");
    expect(stderr).toContain("does not provide the NemoClaw-managed `nemoclaw-start` command");
    expect(stderr).not.toContain("entered Error phase");
    expect(stderr).toContain("The pre-patch sandbox container was restored and started");
    expect(stderr).not.toContain("replacement was removed");
    expect(stderr).not.toContain("left in place for inspection");
    expect(stderr).not.toContain("openshell sandbox delete");
  });

  it("keeps the fresh verdict when an inspectable replacement container is running", () => {
    // The live snapshot has first-hand evidence, so a stale pre-rollback
    // verdict must not overwrite it.
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => JSON.stringify({ Status: "running", Running: true, ExitCode: 0 })),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
      },
      preRollbackClassification: PRE_ROLLBACK,
    });

    expect(stderr).toContain("OpenShell sandbox entered Error phase");
    expect(stderr).not.toContain("code 127");
  });

  it("keeps the fresh verdict when the pre-rollback create option does not match (#7996)", () => {
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("cdi"),
        rolledBack: true,
      },
      preRollbackClassification: PRE_ROLLBACK,
    });

    expect(stderr).toContain("OpenShell sandbox entered Error phase");
    expect(stderr).not.toContain("code 127");
    expect(stderr).not.toContain("patched_container_exit_code=127");
  });

  it("matches a saved verdict by mode kind when its display label changes (#7996)", () => {
    const selectedMode = { ...buildDockerGpuMode("gpus"), label: "--gpus=all" };
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode,
        rolledBack: true,
      },
      preRollbackClassification: PRE_ROLLBACK,
    });

    expect(stderr).toContain("Patched GPU container exited with code 127");
    expect(stderr).toContain("patched_container_exit_code=127");
    expect(stderr).not.toContain("entered Error phase");
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

  it.each([
    "sandbox_error_phase",
    "sandbox_deleting_phase",
    "supervisor_unreachable",
    "proof_failure",
  ] as const)("ignores a saved %s verdict after rollback", (kind) => {
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
        rolledBack: true,
        replacementPresence: "absent",
      },
      preRollbackClassification: {
        ...PRE_ROLLBACK,
        kind,
        headline: `Stale ${kind} verdict.`,
      },
    });

    expect(stderr).toContain("OpenShell sandbox entered Error phase");
    expect(stderr).not.toContain(`Stale ${kind} verdict`);
    expect(stderr).not.toContain("patched_container_exit_code=127");
  });

  it("does not suggest deletion when replacement cleanup remains unknown after rollback", () => {
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
        rolledBack: true,
        replacementPresence: "unknown",
      },
      preRollbackClassification: PRE_ROLLBACK,
    });

    expect(stderr).toContain("Replacement container cleanup could not be confirmed");
    expect(stderr).toContain("before removing any container");
    expect(stderr).not.toContain("Manual cleanup");
    expect(stderr).not.toContain("openshell sandbox delete");
    expect(stderr).not.toContain("docker rm -f");
  });

  it("does not suggest deleting the sandbox when rollback fails (#7996)", () => {
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => ""),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "a".repeat(64),
        selectedMode: buildDockerGpuMode("gpus"),
        rolledBack: false,
      },
      preRollbackClassification: null,
    });

    expect(stderr).toContain("container state is uncertain");
    expect(stderr).toContain("before removing any container");
    expect(stderr).not.toContain("Manual cleanup");
    expect(stderr).not.toContain("openshell sandbox delete");
    expect(stderr).not.toContain("docker rm -f");
  });
});
