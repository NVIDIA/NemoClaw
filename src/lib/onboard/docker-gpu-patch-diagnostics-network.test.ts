// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createDockerGpuDiagnosticsInspectFixture as inspectFixture } from "./__test-helpers__/docker-gpu-patch-fixtures";
import {
  collectDockerGpuPatchDiagnostics,
  formatDockerInspectNetworkSummary,
} from "./docker-gpu-patch";

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
});
