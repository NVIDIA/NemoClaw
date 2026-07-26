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
    for (const [message, sawProgress, expected] of [
      [rejection, false, true],
      [rejection, true, false],
      ["Docker build failed while compiling a GPU Python package for --gpu support", false, false],
      ["x509: certificate signed by unknown authority", false, false],
      ["notice: error: unexpected argument '--gpu' found while compiling docs", false, false],
      ["error: unexpected argument '--gpu' found\nimage-controlled trailing output", false, false],
      [
        "error: unexpected argument '--gpu' found\nUsage: openshell sandbox create [OPTIONS]\nFor more information, try '--help'.",
        false,
        true,
      ],
    ] as const) {
      expect(isNativeGpuCreateRoutingFailure(message, { sawProgress })).toBe(expected);
    }
  });

  it("requires exact-target terminal phase plus host runtime evidence for readiness fallback", () => {
    for (const [failurePhase, runtimeError, expected] of [
      ["Failed", "policy denied startup exec for gpu-device-initialization-failed", false],
      [null, "CDI device injection failed: unresolvable nvidia.com/gpu=all", false],
      ["Error", "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all", true],
    ] as const) {
      expect(isNativeGpuReadinessRoutingFailure({ failurePhase, runtimeError })).toBe(expected);
    }
  });

  it("recognizes only narrow host-owned OCI/CDI GPU runtime errors", () => {
    for (const [message, expected] of [
      ["unresolvable CDI devices nvidia.com/gpu=all", true],
      [
        "failed to create task for container: failed to create shim task: OCI runtime create failed: error injecting CDI devices: unresolvable CDI devices nvidia.com/gpu=all: unknown",
        true,
      ],
      ['could not select device driver "" with capabilities: [[gpu]]', true],
      ["Docker build failed while compiling CUDA support", false],
      ["CDI device injection failed: unresolvable CDI devices example.com/widget=all", false],
      [
        'failed to create task: exec: "CDI injection failed nvidia.com/gpu=all": executable file not found',
        false,
      ],
      [
        'chdir to cwd ("/CDI device injection failed/nvidia.com/gpu=all") set in config.json failed: no such file or directory',
        false,
      ],
      ["nvidia-container-cli: requirement error: unsatisfied condition: cuda>=999", false],
      ["nvidia-container-cli: mount error: failed to mount /image-controlled/path", false],
    ] as const) {
      expect(isTrustedNativeGpuRuntimeError(message)).toBe(expected);
    }
  });
});
