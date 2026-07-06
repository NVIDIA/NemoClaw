// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isNativeGpuCreatePreBuildRejection,
  isNativeGpuCreateRoutingFailure,
  isNativeGpuReadinessRoutingFailure,
} from "./sandbox-gpu-create-attempt";

describe("native GPU create failure classification", () => {
  it("accepts an argument rejection without treating unrelated build failures as routing", () => {
    const rejection = "error: unexpected argument '--gpu' found";
    expect(isNativeGpuCreatePreBuildRejection(rejection)).toBe(true);
    expect(isNativeGpuCreateRoutingFailure(rejection)).toBe(true);
    expect(
      isNativeGpuCreateRoutingFailure(
        "Docker build failed while compiling a GPU Python package for --gpu support",
      ),
    ).toBe(false);
    expect(isNativeGpuCreateRoutingFailure("x509: certificate signed by unknown authority")).toBe(
      false,
    );
  });

  it("requires GPU-specific evidence before treating readiness as a routing failure", () => {
    expect(isNativeGpuReadinessRoutingFailure("alpha Failed: policy denied startup exec")).toBe(
      false,
    );
    expect(
      isNativeGpuReadinessRoutingFailure(
        "alpha Error: NVIDIA GPU device initialization failed during sandbox startup",
      ),
    ).toBe(true);
  });

  it("keeps CUDA-bearing Docker build output on the build failure path", () => {
    expect(
      isNativeGpuReadinessRoutingFailure(
        "Docker build failed while compiling CUDA device initialization support",
      ),
    ).toBe(false);
  });
});
