// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { getSandboxFailurePhase } from "../state/gateway";
import {
  buildDockerGpuMode,
  captureDockerGpuPatchSandboxSnapshot,
  classifyDockerGpuPatchFailure,
  collectDockerGpuPatchDiagnostics,
  type DockerContainerInspect,
  formatDockerInspectNetworkSummary,
} from "./docker-gpu-patch";

function inspectFixture(): DockerContainerInspect {
  return {
    Id: "old-container-id",
    Name: "/openshell-alpha",
    Config: {
      Image: "openshell/sandbox:abc",
      Env: ["A=1", "OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/", "OPENSHELL_TEST=1"],
      Labels: {
        "openshell.ai/managed-by": "openshell",
        "openshell.ai/sandbox-name": "alpha",
      },
    },
    HostConfig: {
      NetworkMode: "openshell-docker",
      ExtraHosts: ["host.openshell.internal:172.17.0.1"],
    },
    NetworkSettings: {
      Networks: {
        "openshell-docker": {
          IPAddress: "172.18.0.2",
          Gateway: "172.18.0.1",
          Aliases: ["openshell-alpha"],
        },
      },
    },
  };
}

function sandboxCapture(getOutput: string, listOutput: string) {
  const responses: Record<string, string> = {
    "sandbox:get": getOutput,
    "sandbox:list": listOutput,
  };
  return vi.fn((args: readonly string[]) => responses[args.slice(0, 2).join(":")] ?? "");
}

describe("Docker GPU patch diagnostics", () => {
  it("formats sanitized network diagnostics without dumping provider secrets", () => {
    const inspect = inspectFixture();
    inspect.Config?.Env?.push("NVIDIA_INFERENCE_API_KEY=secret");
    const summary = formatDockerInspectNetworkSummary("old-container-id", inspect);

    expect(summary).toContain("target=old-container-id");
    expect(summary).toContain("network_mode=openshell-docker");
    expect(summary).toContain("host.openshell.internal:172.17.0.1");
    expect(summary).toContain("env.OPENSHELL_ENDPOINT=http://host.openshell.internal:8080/");
    expect(summary).toContain("openshell-docker: ip=172.18.0.2 gateway=172.18.0.1");
    expect(summary).not.toContain("NVIDIA_INFERENCE_API_KEY");
    expect(summary).not.toContain("secret");
  });

  it("keeps Docker network diagnostics when old patch containers are gone", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-diag-"));
    try {
      const liveInspect = inspectFixture();
      liveInspect.Id = "new-container-id";
      const responses: Record<string, string> = {
        "ps:": "new-container-id\n",
        "inspect:new-container-id": JSON.stringify([liveInspect]),
      };
      const dockerCapture = vi.fn((args: readonly string[]) => {
        const key = `${args[0]}:${String(args[1] ?? "")}`;
        return (
          responses[key] ??
          (() => {
            throw new Error(`missing target ${String(args[1])}`);
          })()
        );
      });
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            oldContainerId: "old-container-id",
            newContainerId: "new-container-id",
            backupContainerName: "backup-container",
          },
        },
        {
          dockerCapture,
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      expect(diagnostics?.dir).toBeTruthy();
      const summary = fs.readFileSync(
        path.join(diagnostics?.dir || "", "docker-network-summary.txt"),
        "utf-8",
      );
      expect(summary).toContain("target=new-container-id");
      expect(summary).toContain("network_mode=openshell-docker");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

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

  it("preserves the default Docker capture when callers omit dockerCapture from deps", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-default-"));
    try {
      const dockerCapture = vi.fn((_args: readonly string[]) => "");
      collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            selectedMode: buildDockerGpuMode("gpus"),
          },
        },
        {
          dockerCapture,
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      expect(dockerCapture.mock.calls.some(([args]) => args?.[0] === "ps")).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("writes patched-container-state.json and surfaces failure_kind/sandbox_phase in the summary", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-4316-"));
    try {
      const snapshot = {
        sandboxPhase: "Error",
        sandboxListLine: "alpha   Error   1m ago",
        patchedContainerState: {
          Status: "exited",
          ExitCode: 125,
          Error: 'could not select device driver "nvidia"',
        },
      };
      const classification = classifyDockerGpuPatchFailure(snapshot, buildDockerGpuMode("gpus"));
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            selectedMode: buildDockerGpuMode("gpus"),
          },
          selectedMode: buildDockerGpuMode("gpus"),
          snapshot,
          classification,
        },
        {
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      expect(diagnostics?.dir).toBeTruthy();
      const summary = fs.readFileSync(path.join(diagnostics?.dir || "", "summary.txt"), "utf-8");
      expect(summary).toContain("failure_kind=patched_container_failed");
      expect(summary).toContain("sandbox_phase=Error");
      expect(summary).toContain("patched_container_exit_code=125");
      const state = fs.readFileSync(
        path.join(diagnostics?.dir || "", "patched-container-state.json"),
        "utf-8",
      );
      expect(state).toContain("could not select device driver");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
