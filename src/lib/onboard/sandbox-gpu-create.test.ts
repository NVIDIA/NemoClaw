// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildSandboxGpuCreateArgs, getSandboxReadyTimeoutSecs } from "./sandbox-gpu-create";

describe("sandbox GPU create helpers", () => {
  it("builds OpenShell sandbox GPU create args", () => {
    expect(buildSandboxGpuCreateArgs({ sandboxGpuEnabled: false })).toEqual([]);
    expect(buildSandboxGpuCreateArgs({ sandboxGpuEnabled: true })).toEqual(["--gpu"]);
    expect(
      buildSandboxGpuCreateArgs({ sandboxGpuEnabled: true, sandboxGpuDevice: "nvidia.com/gpu=0" }),
    ).toEqual(["--gpu", "--gpu-device", "nvidia.com/gpu=0"]);
    expect(
      buildSandboxGpuCreateArgs(
        { sandboxGpuEnabled: true, sandboxGpuDevice: "nvidia.com/gpu=0" },
        { suppressGpuFlag: true },
      ),
    ).toEqual([]);
  });

  it("keeps the default sandbox readiness timeout unless explicitly overridden", () => {
    expect(getSandboxReadyTimeoutSecs({ sandboxGpuEnabled: false }, {}, "linux")).toBe(180);
    expect(getSandboxReadyTimeoutSecs({ sandboxGpuEnabled: true }, {}, "linux")).toBe(180);
    expect(getSandboxReadyTimeoutSecs({ sandboxGpuEnabled: true }, {}, "win32")).toBe(180);
  });

  it("honors explicit sandbox readiness timeout overrides", () => {
    expect(
      getSandboxReadyTimeoutSecs(
        { sandboxGpuEnabled: true },
        { NEMOCLAW_SANDBOX_READY_TIMEOUT: "75" },
        "linux",
      ),
    ).toBe(75);
  });
});
