// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { detectNvidiaDriverVersion } from "./nim";

describe("detectNvidiaDriverVersion", () => {
  it.each(["595.84", "580.65.06"])("accepts the NVIDIA driver version %s", (version) => {
    const runCaptureImpl = vi.fn(() => `${version}\n`);

    expect(detectNvidiaDriverVersion({ runCaptureImpl })).toBe(version);
    expect(runCaptureImpl).toHaveBeenCalledWith(
      ["nvidia-smi", "--query-gpu=driver_version", "--format=csv,noheader,nounits"],
      { ignoreError: true },
    );
  });

  it.each(["595", "595.84.1.2", "595.x"])("rejects the malformed driver version %s", (version) => {
    expect(detectNvidiaDriverVersion({ runCaptureImpl: () => version })).toBeUndefined();
  });

  it("rejects inconsistent driver versions across GPUs", () => {
    expect(
      detectNvidiaDriverVersion({ runCaptureImpl: () => "595.84\n580.65.06\n" }),
    ).toBeUndefined();
  });
});
