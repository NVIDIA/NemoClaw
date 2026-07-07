// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  isNativeGpuCreatePreBuildRejection,
  isNativeGpuCreateRoutingFailure,
  isNativeGpuReadinessRoutingFailure,
  isTrustedNativeGpuRuntimeError,
} from "./sandbox-gpu-create-attempt";

describe("native GPU create failure classification", () => {
  it("accepts an argument rejection without treating unrelated build failures as routing", () => {
    const rejection = "error: unexpected argument '--gpu' found";
    expect(isNativeGpuCreatePreBuildRejection(rejection)).toBe(true);
    expect(isNativeGpuCreateRoutingFailure(rejection, { sawProgress: false })).toBe(true);
    expect(isNativeGpuCreateRoutingFailure(rejection, { sawProgress: true })).toBe(false);
    expect(
      isNativeGpuCreateRoutingFailure(
        "Docker build failed while compiling a GPU Python package for --gpu support",
        { sawProgress: false },
      ),
    ).toBe(false);
    expect(
      isNativeGpuCreateRoutingFailure("x509: certificate signed by unknown authority", {
        sawProgress: false,
      }),
    ).toBe(false);
    expect(
      isNativeGpuCreateRoutingFailure(
        "notice: error: unexpected argument '--gpu' found while compiling docs",
        { sawProgress: false },
      ),
    ).toBe(false);
    expect(
      isNativeGpuCreateRoutingFailure(
        "error: unexpected argument '--gpu' found\nimage-controlled trailing output",
        { sawProgress: false },
      ),
    ).toBe(false);
    expect(
      isNativeGpuCreateRoutingFailure(
        "error: unexpected argument '--gpu' found\nUsage: openshell sandbox create [OPTIONS]\nFor more information, try '--help'.",
        { sawProgress: false },
      ),
    ).toBe(true);
  });

  it("requires exact-target terminal phase plus host runtime evidence for readiness fallback", () => {
    expect(
      isNativeGpuReadinessRoutingFailure({
        failurePhase: "Failed",
        runtimeError: "policy denied startup exec for gpu-device-initialization-failed",
      }),
    ).toBe(false);
    expect(
      isNativeGpuReadinessRoutingFailure({
        failurePhase: null,
        runtimeError: "CDI device injection failed: unresolvable nvidia.com/gpu=all",
      }),
    ).toBe(false);
    expect(
      isNativeGpuReadinessRoutingFailure({
        failurePhase: "Error",
        runtimeError: "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all",
      }),
    ).toBe(true);
  });

  it("recognizes only narrow host-owned OCI/CDI GPU runtime errors", () => {
    expect(isTrustedNativeGpuRuntimeError("unresolvable CDI devices nvidia.com/gpu=all")).toBe(
      true,
    );
    expect(
      isTrustedNativeGpuRuntimeError(
        "failed to create task for container: failed to create shim task: OCI runtime create failed: error injecting CDI devices: unresolvable CDI devices nvidia.com/gpu=all: unknown",
      ),
    ).toBe(true);
    expect(
      isTrustedNativeGpuRuntimeError(
        'could not select device driver "" with capabilities: [[gpu]]',
      ),
    ).toBe(true);
    expect(isTrustedNativeGpuRuntimeError("Docker build failed while compiling CUDA support")).toBe(
      false,
    );
    expect(
      isTrustedNativeGpuRuntimeError(
        "CDI device injection failed: unresolvable CDI devices example.com/widget=all",
      ),
    ).toBe(false);
    expect(
      isTrustedNativeGpuRuntimeError(
        'failed to create task: exec: "CDI injection failed nvidia.com/gpu=all": executable file not found',
      ),
    ).toBe(false);
    expect(
      isTrustedNativeGpuRuntimeError(
        'chdir to cwd ("/CDI device injection failed/nvidia.com/gpu=all") set in config.json failed: no such file or directory',
      ),
    ).toBe(false);
    expect(
      isTrustedNativeGpuRuntimeError(
        "nvidia-container-cli: requirement error: unsatisfied condition: cuda>=999",
      ),
    ).toBe(false);
    expect(
      isTrustedNativeGpuRuntimeError(
        "nvidia-container-cli: mount error: failed to mount /image-controlled/path",
      ),
    ).toBe(false);
  });
});
