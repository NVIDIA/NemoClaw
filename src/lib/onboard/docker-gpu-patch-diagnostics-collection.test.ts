// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

const dockerAdapterMocks = vi.hoisted(() => ({
  dockerCapture: vi.fn((args: readonly string[]) =>
    args[0] === "ps" ? "default-container-id\n" : "",
  ),
}));

vi.mock("../adapters/docker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/docker")>()),
  dockerCapture: dockerAdapterMocks.dockerCapture,
}));

import {
  buildDockerGpuMode,
  classifyDockerGpuPatchFailure,
  collectDockerGpuPatchDiagnostics,
} from "./docker-gpu-patch";

describe("Docker GPU patch diagnostics", () => {
  it.each(["", "relative-home"])("rejects non-absolute diagnostic home %j", (home) => {
    const dockerCapture = vi.fn();
    expect(
      collectDockerGpuPatchDiagnostics("alpha", {}, { dockerCapture, homedir: () => home }),
    ).toBeNull();
    expect(dockerCapture).not.toHaveBeenCalled();
  });

  it("preserves the default Docker capture when callers omit dockerCapture from deps", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-default-"));
    try {
      dockerAdapterMocks.dockerCapture.mockClear();
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "new-container-id",
            selectedMode: buildDockerGpuMode("gpus"),
          },
        },
        {
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      expect(diagnostics?.dir).toBeTruthy();
      expect(
        fs.readFileSync(path.join(diagnostics?.dir || "", "docker-ps.txt"), "utf-8"),
      ).toContain("default-container-id");
      expect(dockerAdapterMocks.dockerCapture).toHaveBeenCalledWith(
        expect.arrayContaining(["ps"]),
        expect.objectContaining({ ignoreError: true }),
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

  it("omits cleanup after rollback confirms that the replacement is absent (#7996)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-rollback-"));
    try {
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "removed-container-id",
            rolledBack: true,
            replacementStopConfirmed: true,
            replacementRemovalConfirmed: true,
            replacementPresence: "absent",
          },
        },
        {
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:00Z"),
        },
      );

      const summary = fs.readFileSync(path.join(diagnostics?.dir || "", "summary.txt"), "utf-8");
      expect(diagnostics?.cleanupCommands).toEqual([]);
      expect(diagnostics?.cleanupDisposition).toBe("not_required");
      expect(summary).toContain("cleanup_required=no");
      expect(summary).not.toContain("openshell sandbox delete");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps cleanup unknown when rollback cannot confirm replacement absence (#7996)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-unknown-"));
    try {
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "unconfirmed-container-id",
            rolledBack: true,
            replacementStopConfirmed: false,
            replacementRemovalConfirmed: false,
            replacementPresence: "unknown",
          },
        },
        {
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:01Z"),
        },
      );

      const summary = fs.readFileSync(path.join(diagnostics?.dir || "", "summary.txt"), "utf-8");
      expect(diagnostics?.cleanupCommands).toEqual([]);
      expect(diagnostics?.cleanupDisposition).toBe("unknown");
      expect(summary).toContain("replacement_presence=unknown");
      expect(summary).toContain("cleanup_required=unknown");
      expect(summary).not.toContain("openshell sandbox delete");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("keeps cleanup unknown when a present replacement lacks an exact ID (#7996)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-invalid-id-"));
    try {
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: "short-container-id",
            rolledBack: true,
            replacementStopConfirmed: false,
            replacementRemovalConfirmed: false,
            replacementPresence: "present",
          },
        },
        {
          dockerCapture: vi.fn(() => ""),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:02Z"),
        },
      );

      const summary = fs.readFileSync(path.join(diagnostics?.dir || "", "summary.txt"), "utf-8");
      expect(diagnostics?.cleanupCommands).toEqual([]);
      expect(diagnostics?.cleanupDisposition).toBe("unknown");
      expect(summary).toContain("replacement_presence=present");
      expect(summary).toContain("cleanup_required=unknown");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("uses exact-ID cleanup when post-rollback inspection finds the replacement (#7996)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-docker-gpu-inspect-"));
    const replacementId = "b".repeat(64);
    try {
      const diagnostics = collectDockerGpuPatchDiagnostics(
        "alpha",
        {
          context: {
            sandboxName: "alpha",
            newContainerId: replacementId,
            rolledBack: true,
            replacementStopConfirmed: false,
            replacementRemovalConfirmed: false,
            replacementPresence: "unknown",
          },
        },
        {
          dockerCapture: vi.fn((args: readonly string[]) =>
            args[0] === "inspect" && args[1] === replacementId
              ? JSON.stringify([{ Id: replacementId }])
              : "",
          ),
          dockerLogs: vi.fn(() => ""),
          homedir: () => tmpDir,
          now: () => new Date("2026-05-12T00:00:02Z"),
        },
      );

      const summary = fs.readFileSync(path.join(diagnostics?.dir || "", "summary.txt"), "utf-8");
      expect(diagnostics?.cleanupCommands).toEqual([
        `docker rm -f ${JSON.stringify(replacementId)}`,
      ]);
      expect(diagnostics?.cleanupDisposition).toBe("manual");
      expect(summary).toContain("replacement_presence=present");
      expect(summary).toContain("cleanup_required=yes");
      expect(summary).not.toContain("openshell sandbox delete");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
