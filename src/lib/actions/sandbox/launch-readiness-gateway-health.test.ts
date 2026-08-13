// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { isSandboxGatewayRunningForStatus } from "./process-recovery";

describe("launch-readiness gateway health scope", () => {
  it("pins the semantic gateway probe to the owning OpenShell gateway (#8942)", async () => {
    const capture = vi.fn(async (_args: string[]) => ({
      status: 0,
      output: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stdout: "__NEMOCLAW_SANDBOX_EXEC_STARTED__\nRUNNING\n",
      stderr: "",
    }));

    await expect(
      isSandboxGatewayRunningForStatus("alpha", "nemoclaw-8091", {
        getSessionAgent: () => null,
        getHealthProbeUrl: () => "http://127.0.0.1:18789/health",
        capture: capture as never,
      }),
    ).resolves.toBe(true);

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]?.slice(0, 7)).toEqual([
      "sandbox",
      "exec",
      "--name",
      "alpha",
      "-g",
      "nemoclaw-8091",
      "--",
    ]);
  });
});
