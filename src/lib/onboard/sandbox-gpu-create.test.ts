// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildSandboxGpuCreateArgs,
  getSandboxReadyTimeoutSecs,
  normalizeSandboxGpuDeviceForCdi,
} from "./sandbox-gpu-create";

describe("sandbox GPU create helpers", () => {
  it("builds OpenShell sandbox GPU create args", () => {
    expect(buildSandboxGpuCreateArgs({ sandboxGpuEnabled: false })).toEqual([]);
    expect(buildSandboxGpuCreateArgs({ sandboxGpuEnabled: true })).toEqual(["--gpu"]);
    expect(
      buildSandboxGpuCreateArgs({ sandboxGpuEnabled: true, sandboxGpuDevice: "nvidia.com/gpu=0" }),
    ).toEqual(["--gpu"]);
    expect(
      buildSandboxGpuCreateArgs(
        { sandboxGpuEnabled: true, sandboxGpuDevice: "nvidia.com/gpu=0" },
        { suppressGpuFlag: true },
      ),
    ).toEqual([]);
  });

  it.each([
    ["0", "nvidia.com/gpu=0"],
    [
      "GPU-69adb14e-820e-bfb4-0993-171e73f68504",
      "nvidia.com/gpu=GPU-69adb14e-820e-bfb4-0993-171e73f68504",
    ],
    ["nvidia.com/gpu=1", "nvidia.com/gpu=1"],
    [" 1 ", "nvidia.com/gpu=1"],
    ["", null],
  ])("normalizes GPU selector %j to CDI device %j", (selector, expected) => {
    expect(normalizeSandboxGpuDeviceForCdi(selector)).toBe(expected);
  });

  it.each(["nvidia.com/gpu=", "nvidia.com/gpu=   "])(
    "rejects empty CDI device identifier %j",
    (selector) => {
      expect(() => normalizeSandboxGpuDeviceForCdi(selector)).toThrow("must include an identifier");
    },
  );

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
