// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { detectNvidiaDriverVersion } from "./nim";

describe("NVIDIA driver version detection", () => {
  it.each([
    ["595.84", "595.84"],
    ["580.65.06", "580.65.06"],
    ["595.84\n595.84", "595.84"],
  ])("accepts a uniform numeric NVIDIA driver inventory %# (#8144)", (output, expected) => {
    const runCaptureImpl = vi.fn(() => output);

    expect(detectNvidiaDriverVersion({ runCaptureImpl })).toBe(expected);
    expect(runCaptureImpl).toHaveBeenCalledWith(
      ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader,nounits"],
      { ignoreError: true },
    );
  });

  it.each([
    "595",
    "595.84.1.2",
    "595.x",
    "595.84\n580.65.06",
    "595.84\nunsafe\u001b[31m",
  ])("rejects a malformed or mixed NVIDIA driver inventory %# (#8144)", (output) => {
    expect(detectNvidiaDriverVersion({ runCaptureImpl: () => output })).toBeUndefined();
  });
});
