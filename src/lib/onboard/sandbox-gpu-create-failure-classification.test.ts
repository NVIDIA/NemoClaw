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
  it.each([
    { scenario: "argument rejection before progress" },
    { scenario: "argument rejection after progress" },
    { scenario: "build failure mentioning GPU flag" },
    { scenario: "certificate failure" },
    { scenario: "documentation output" },
    { scenario: "unbounded trailing output" },
    { scenario: "bounded CLI usage output" },
  ])(
    "accepts an argument rejection without treating unrelated build failures as routing [$scenario]",
    ({ scenario }) => {
      const rejection = "error: unexpected argument '--gpu' found";
      expect(isNativeGpuCreatePreBuildRejection(rejection)).toBe(true);
      const [message, sawProgress, expected] = (
        {
          "argument rejection before progress": [rejection, false, true],
          "argument rejection after progress": [rejection, true, false],
          "build failure mentioning GPU flag": [
            "Docker build failed while compiling a GPU Python package for --gpu support",
            false,
            false,
          ],
          "certificate failure": ["x509: certificate signed by unknown authority", false, false],
          "documentation output": [
            "notice: error: unexpected argument '--gpu' found while compiling docs",
            false,
            false,
          ],
          "unbounded trailing output": [
            "error: unexpected argument '--gpu' found\nimage-controlled trailing output",
            false,
            false,
          ],
          "bounded CLI usage output": [
            "error: unexpected argument '--gpu' found\nUsage: openshell sandbox create [OPTIONS]\nFor more information, try '--help'.",
            false,
            true,
          ],
        } as const
      )[scenario]!;
      expect(isNativeGpuCreateRoutingFailure(message, { sawProgress })).toBe(expected);
    },
  );

  it.each([
    ["Failed", "policy denied startup exec for gpu-device-initialization-failed", false],
    [null, "CDI device injection failed: unresolvable nvidia.com/gpu=all", false],
    ["Error", "CDI device injection failed: unresolvable CDI devices nvidia.com/gpu=all", true],
  ] as const)(
    "requires exact-target terminal phase plus host runtime evidence for readiness fallback [case %#]",
    (failurePhase, runtimeError, expected) => {
      expect(isNativeGpuReadinessRoutingFailure({ failurePhase, runtimeError })).toBe(expected);
    },
  );

  it.each([
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
  ] as const)(
    "recognizes only narrow host-owned OCI/CDI GPU runtime errors [case %#]",
    (message, expected) => {
      expect(isTrustedNativeGpuRuntimeError(message)).toBe(expected);
    },
  );
});
