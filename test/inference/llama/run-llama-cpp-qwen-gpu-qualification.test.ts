// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  qwenGpuAgentPlan,
  validateQwenGpuStartupLog,
} from "../../../scripts/checks/run-llama-cpp-qwen-gpu-qualification.ts";

const IMAGE = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
const REVISION = "b".repeat(40);

describe("Qwen llama.cpp RTX qualification plan", () => {
  it("binds the validated managed image to the routed OpenClaw tool journey", () => {
    expect(qwenGpuAgentPlan(IMAGE, REVISION)).toMatchObject({
      agent: "openclaw",
      execution: "enabled",
      image: { reference: IMAGE, sourceRevision: REVISION },
      route: {
        provider: "llama-cpp-local",
        routedBaseUrl: "https://inference.local/v1",
      },
      tool: { name: "read" },
    });
  });

  it("rejects mutable images and unbound source revisions", () => {
    expect(() =>
      qwenGpuAgentPlan("ghcr.io/nvidia/nemoclaw/openclaw-sandbox:latest", REVISION),
    ).toThrow("managed-image cohort returned an invalid OpenClaw identity");
    expect(() => qwenGpuAgentPlan(IMAGE, "main")).toThrow(
      "managed-image cohort returned an invalid OpenClaw identity",
    );
  });

  it("requires complete and consistent Qwen GPU offload", () => {
    expect(validateQwenGpuStartupLog("offloaded 49/49 layers to GPU")).toEqual({
      offloadedLayers: 49,
      totalLayers: 49,
    });
    expect(() => validateQwenGpuStartupLog("offloaded 48/49 layers to GPU")).toThrow(
      "Qwen llama.cpp startup reports partial GPU offload",
    );
    expect(() => validateQwenGpuStartupLog("CPU fallback")).toThrow(
      "Qwen llama.cpp startup reports a rejected GPU or CPU fallback",
    );
  });
});
