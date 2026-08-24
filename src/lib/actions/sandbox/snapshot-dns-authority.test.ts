// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as f from "./snapshot-restore-test-fixture";

beforeEach(f.resetSnapshotRestoreMocks);
afterEach(f.cleanupSnapshotRestoreMocks);

describe("runSandboxSnapshot restore: DNS policy authority", () => {
  it("passes the recorded policy authority to DNS setup for an unregistered clone (#9833)", async () => {
    const existsSync = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation(
      (path) => String(path) === "/repo/scripts/setup-dns-proxy.sh" || existsSync(path),
    );
    f.getSandboxMock.mockImplementation((name) =>
      name === "alpha"
        ? {
            name: "alpha",
            agent: "openclaw",
            gatewayName: "nemoclaw-9090",
            imageTag: "nemoclaw-alpha:test",
            model: "nvidia/model-a",
            openshellDriver: "kubernetes",
            policyAuthority: "nemoclaw-managed",
            provider: "nvidia-nim",
          }
        : null,
    );
    f.captureOpenshellMock.mockImplementation((args) =>
      f.openshellResponses(args, {
        "sandbox exec": { status: 0, output: f.dcodeProbeOutput("idle") },
        "sandbox list": { status: 0, output: "alpha Ready\nbeta Ready\n" },
      }),
    );
    f.dockerCaptureMock.mockReturnValue("nemoclaw-alpha:test\n");
    f.getLatestBackupMock.mockReturnValue({ ...f.latestBackupFixture });

    const { runSandboxSnapshot } = await import("./snapshot");
    await runSandboxSnapshot("alpha", { kind: "restore", to: "beta" });

    expect(f.runMock).toHaveBeenCalledWith(
      ["bash", "/repo/scripts/setup-dns-proxy.sh", "nemoclaw-9090", "beta", "nemoclaw-managed"],
      { ignoreError: true },
    );
  });
});
