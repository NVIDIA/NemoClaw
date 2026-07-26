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
});
