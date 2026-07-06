// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { getSandboxFailurePhase } from "../state/gateway";
import {
  buildDockerGpuMode,
  captureDockerGpuPatchSandboxSnapshot,
  classifyDockerGpuPatchFailure,
} from "./docker-gpu-patch";

function sandboxCapture(getOutput: string, listOutput: string) {
  const responses: Record<string, string> = {
    "sandbox:get": getOutput,
    "sandbox:list": listOutput,
  };
  return vi.fn((args: readonly string[]) => responses[args.slice(0, 2).join(":")] ?? "");
}

describe("Docker GPU patch diagnostics", () => {
  it("detects terminal failure phases in `openshell sandbox list` output", () => {
    const errorList = "my-sandbox   Error   2s ago";
    expect(getSandboxFailurePhase(errorList, "my-sandbox")).toBe("Error");
    expect(getSandboxFailurePhase("my-sandbox   CrashLoopBackOff   3s ago", "my-sandbox")).toBe(
      "CrashLoopBackOff",
    );
    expect(getSandboxFailurePhase("my-sandbox   Failed   3s ago", "my-sandbox")).toBe("Failed");
    expect(getSandboxFailurePhase("my-sandbox   Ready   3s ago", "my-sandbox")).toBeNull();
    expect(getSandboxFailurePhase("other   Error   3s ago", "my-sandbox")).toBeNull();
    expect(getSandboxFailurePhase("", "my-sandbox")).toBeNull();
  });

  it("prefers `sandbox list` phase over `sandbox get` when both are present (stale get)", () => {
    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      {
        runCaptureOpenshell: sandboxCapture(
          "Name: alpha\nPhase: Provisioning\n",
          "alpha   Error   2s ago\n",
        ),
      },
    );

    expect(snapshot.sandboxPhase).toBe("Error");
    expect(snapshot.sandboxListLine).toContain("Error");
  });

  it("uses the list-derived phase whenever the sandbox row is present", () => {
    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      {
        runCaptureOpenshell: sandboxCapture(
          "Name: alpha\nPhase: Error\nReason: ContainerCannotRun\n",
          "alpha   Ready   1m ago\n",
        ),
      },
    );

    expect(snapshot.sandboxPhase).toBe("Ready");
    expect(snapshot.sandboxListLine).toContain("Ready");
  });

  it("keeps the get-derived phase when the sandbox row is absent from list output", () => {
    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      {
        runCaptureOpenshell: sandboxCapture(
          "Name: alpha\nPhase: Terminated\n",
          "other-box   Ready   2s ago\n",
        ),
      },
    );

    expect(snapshot.sandboxPhase).toBe("Terminated");
    expect(snapshot.sandboxListLine).toBeNull();
  });

  it("captures sandbox phase and patched container State via the snapshot helper", () => {
    const state = {
      Status: "exited",
      Running: false,
      ExitCode: 125,
      Error: 'could not select device driver "nvidia" with capabilities: [[gpu]]',
      OOMKilled: false,
      StartedAt: "2026-05-12T00:00:00Z",
      FinishedAt: "2026-05-12T00:00:01Z",
    };
    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: "new-container-id" },
      {
        runCaptureOpenshell: sandboxCapture(
          "Name: alpha\nPhase: Error\nReason: ContainerExit\n",
          "alpha   Error   1m ago\n",
        ),
        dockerCapture: vi.fn(() => JSON.stringify(state)),
      },
    );

    expect(snapshot.sandboxPhase).toBe("Error");
    expect(snapshot.sandboxListLine).toBe("alpha   Error   1m ago");
    expect(snapshot.patchedContainerState?.ExitCode).toBe(125);
    expect(snapshot.patchedContainerState?.Error).toContain("could not select device driver");
  });

  it("classifies a dead patched container as patched_container_failed with the failed mode", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Error",
        sandboxListLine: "alpha   Error   1m ago",
        patchedContainerState: {
          Status: "exited",
          ExitCode: 125,
          Error: 'could not select device driver "nvidia" with capabilities: [[gpu]]',
        },
      },
      buildDockerGpuMode("gpus"),
    );

    expect(result.kind).toBe("patched_container_failed");
    expect(result.headline).toContain("Patched GPU container exited with code 125");
    expect(result.headline).toContain("--gpus all");
    const flat = result.summaryLines.join("\n");
    expect(flat).toContain("sandbox_phase=Error");
    expect(flat).toContain("patched_container_exit_code=125");
    expect(flat).toContain("could not select device driver");
    expect(flat).toContain("patched_create_option=--gpus all");
  });

  it("classifies an Error-phase sandbox with unknown container state as sandbox_error_phase", () => {
    const result = classifyDockerGpuPatchFailure(
      { sandboxPhase: "Error", sandboxListLine: null, patchedContainerState: null },
      buildDockerGpuMode("gpus"),
    );

    expect(result.kind).toBe("sandbox_error_phase");
    expect(result.headline).toContain("OpenShell sandbox entered Error phase");
  });

  it("classifies a live container but timed-out supervisor as supervisor_unreachable", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Provisioning",
        sandboxListLine: "alpha   Provisioning   30s ago",
        patchedContainerState: { Status: "running", Running: true, ExitCode: 0 },
      },
      buildDockerGpuMode("gpus"),
    );

    expect(result.kind).toBe("supervisor_unreachable");
    expect(result.headline).toContain("Provisioning");
  });

  it("prefers supervisor_unreachable over proof_failure when the sandbox is non-live but non-terminal", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Provisioning",
        sandboxListLine: "alpha   Provisioning   30s ago",
        patchedContainerState: null,
      },
      buildDockerGpuMode("gpus"),
      { proofError: new Error("openshell sandbox exec refused: sandbox not ready") },
    );

    expect(result.kind).toBe("supervisor_unreachable");
    expect(result.headline).toContain("Provisioning");
    expect(result.summaryLines.join("\n")).toContain("proof_error=");
  });

  it("does not blame the supervisor when the patch failed before a container existed", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Provisioning",
        sandboxListLine: "alpha   Provisioning   3s ago",
        patchedContainerState: null,
      },
      null,
    );

    expect(result.kind).toBe("unknown");
    expect(result.headline).not.toMatch(/supervisor/i);
  });

  it("treats proof failures inside a Ready sandbox as proof_failure, not patched_container_failed", () => {
    const result = classifyDockerGpuPatchFailure(
      {
        sandboxPhase: "Ready",
        sandboxListLine: "alpha   Ready   30s ago",
        patchedContainerState: { Status: "running", Running: true, ExitCode: 0 },
      },
      buildDockerGpuMode("gpus"),
      { proofError: new Error("nvidia-smi exited with status 9") },
    );

    expect(result.kind).toBe("proof_failure");
    expect(result.summaryLines.join("\n")).toContain("proof_error=nvidia-smi exited with status 9");
  });

  it("does not inspect the original/backup container when newContainerId is missing", () => {
    const dockerCapture = vi.fn((_args: readonly string[]) =>
      JSON.stringify({ Status: "exited", ExitCode: 1 }),
    );
    const snapshot = captureDockerGpuPatchSandboxSnapshot(
      "alpha",
      { patchedContainerId: null },
      { dockerCapture },
    );

    expect(snapshot.patchedContainerState).toBeNull();
    expect(
      dockerCapture.mock.calls.some(([args]) => args[0] === "inspect" && args[1] === "--format"),
    ).toBe(false);
  });
});
