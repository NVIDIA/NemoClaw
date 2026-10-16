// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { OpenShellGpuDiagnostics } from "../adapters/openshell/gpu-diagnostics";
import { GATEWAY_PORT } from "../core/ports";
import { nemoclawStateRoot } from "../state/state-root";
const dockerAdapterMocks = vi.hoisted(() => ({
  dockerCapture: vi.fn((args: readonly string[]) =>
    args[0] === "ps" ? "default-container-id\n" : "",
  ),
  dockerLogs: vi.fn(() => ""),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerCapture: dockerAdapterMocks.dockerCapture,
  dockerLogs: dockerAdapterMocks.dockerLogs,
}));

import {
  applyDockerGpuPatchOrExit,
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
  it("keeps the GPU headline and GPU-only escape hatches for a GPU operation", () => {
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => JSON.stringify({ Status: "running", Running: true, ExitCode: 0 })),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("gpus"),
      },
    });

    expect(stderr).toContain("Docker GPU patch failed.");
    expect(stderr).toContain("Escape hatches:");
    expect(stderr).toContain("--no-gpu");
    expect(stderr).toContain("NEMOCLAW_SANDBOX_GPU=0");
    expect(stderr).toContain("NEMOCLAW_DOCKER_GPU_PATCH=1");
    expect(stderr).not.toContain("Next action:");
    expect(stderr).not.toContain("Docker startup-command patch failed.");
  });

  it("reports the selected startup-command operation without GPU-only wording (#12080)", () => {
    const stderr = printAndCapture({
      runCaptureOpenshell: vi.fn(() => "alpha   Error   1m ago\n"),
      dockerCapture: vi.fn(() => ""),
      context: {
        sandboxName: "alpha",
        newContainerId: "new-container-id",
        selectedMode: buildDockerGpuMode("startup-command"),
      },
    });

    expect(stderr).toContain("Docker startup-command patch failed.");
    expect(stderr).toContain("startup-command restart persistence");
    expect(stderr).toContain("patched_create_option=persistent sandbox startup command");
    expect(stderr).toContain("Next action:");
    expect(stderr).toContain("Rebuild the sandbox image, then rerun onboarding to recreate it.");
    expect(stderr).not.toContain("Docker GPU patch failed.");
    expect(stderr).not.toContain("Escape hatches:");
    expect(stderr).not.toContain("--no-gpu");
    expect(stderr).not.toContain("NEMOCLAW_SANDBOX_GPU=0");
    expect(stderr).not.toContain("NEMOCLAW_DOCKER_GPU_PATCH");
  });

  it("preserves typed OpenShell artifacts through the recreation-failure wrapper", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-wrapper-"));
    const collect = vi.fn<OpenShellGpuDiagnostics["collect"]>(() => [
      {
        name: "openshell-sandbox-get.txt",
        content: "Phase: Error\n",
        outcome: { kind: "completed", exitCode: 0 },
      },
    ]);
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__test_exit__");
    }) as never);

    try {
      await expect(
        applyDockerGpuPatchOrExit(
          { sandboxName: "alpha", timeoutSecs: 1 },
          { openShellGpuDiagnostics: { collect } },
        ),
      ).rejects.toThrow(/__test_exit__/);

      expect(collect).toHaveBeenCalledExactlyOnceWith({
        target: { kind: "selected" },
        sandboxName: "alpha",
        timeoutMs: 30_000,
        redact: expect.any(Function),
      });
      expect(errorSpy.mock.calls.map((args) => args.map(String).join(" ")).join("\n")).toContain(
        "OpenShell sandbox entered Error phase",
      );
      const failuresDir = path.join(nemoclawStateRoot(tmpDir, GATEWAY_PORT), "onboard-failures");
      const [failureDir] = fs.readdirSync(failuresDir);
      expect(failureDir).toBeTruthy();
      expect(
        fs.readFileSync(path.join(failuresDir, failureDir!, "openshell-sandbox-get.txt"), "utf8"),
      ).toBe("Phase: Error\n");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
      homeSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not retry a typed diagnostic collection that throws", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-collect-failure-"));
    const collect = vi.fn<OpenShellGpuDiagnostics["collect"]>(() => {
      throw new Error("typed diagnostics unavailable");
    });
    const runCaptureOpenshell = vi.fn(() => "alpha   Ready   1m ago\n");
    const output: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__test_exit__");
    }) as never);

    try {
      expect(() =>
        printDockerGpuPatchFailureAndExit("alpha", new Error("supervisor did not reconnect"), {
          openShellGpuDiagnostics: { collect },
          runCaptureOpenshell,
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            rolledBack: true,
            replacementPresence: "unknown",
          },
        }),
      ).toThrow(/__test_exit__/);

      expect(collect).toHaveBeenCalledOnce();
      expect(runCaptureOpenshell).not.toHaveBeenCalled();
      expect(output.join("\n")).toContain("supervisor did not reconnect");
      expect(output.join("\n")).toContain("Replacement container cleanup could not be confirmed");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps original failure reporting when a retained artifact cannot be written", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-write-failure-"));
    const collect = vi.fn<OpenShellGpuDiagnostics["collect"]>(() => [
      {
        name: "openshell-sandbox-get.txt",
        content: "Phase: Error\n",
        outcome: { kind: "completed", exitCode: 0 },
      },
    ]);
    const writeFileSync = fs.writeFileSync.bind(fs);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file, data, options) => {
      return String(file).endsWith("openshell-sandbox-get.txt")
        ? (() => {
            throw new Error("artifact write denied");
          })()
        : writeFileSync(file, data, options);
    }) as typeof fs.writeFileSync);
    const output: string[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((_code?: number) => {
      throw new Error("__test_exit__");
    }) as never);

    try {
      expect(() =>
        printDockerGpuPatchFailureAndExit("alpha", new Error("supervisor did not reconnect"), {
          openShellGpuDiagnostics: { collect },
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            rolledBack: true,
            replacementPresence: "unknown",
          },
        }),
      ).toThrow(/__test_exit__/);

      expect(collect).toHaveBeenCalledOnce();
      expect(output.join("\n")).toContain("supervisor did not reconnect");
      expect(output.join("\n")).toContain("Replacement container cleanup could not be confirmed");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      writeSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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
