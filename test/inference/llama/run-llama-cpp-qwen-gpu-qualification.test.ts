// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  qwenGpuAgentPlan,
  validateQwenGpuProcessEvidence,
} from "../../../scripts/checks/llama-cpp-qwen-gpu-contract.ts";

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

  it("binds the Qwen container process to full-offload NVIDIA memory", () => {
    const modelSizeBytes = 20 * 1024 ** 3;
    expect(
      validateQwenGpuProcessEvidence(
        "PID COMMAND\n123 llama-server\n",
        "123, /usr/local/bin/llama-server, 16000\n",
        modelSizeBytes,
      ),
    ).toEqual({
      processName: "/usr/local/bin/llama-server",
      usedGpuMemoryMiB: 16000,
      minimumFullOffloadMemoryMiB: 15360,
    });
    expect(() =>
      validateQwenGpuProcessEvidence(
        "PID COMMAND\n123 llama-server\n",
        "456, /usr/local/bin/llama-server, 16000\n",
        modelSizeBytes,
      ),
    ).toThrow("Qwen llama-server is not the exact NVIDIA compute process");
    expect(() =>
      validateQwenGpuProcessEvidence(
        "PID COMMAND\n123 llama-server\n",
        "123, /usr/local/bin/llama-server, 15000\n",
        modelSizeBytes,
      ),
    ).toThrow("Qwen llama-server GPU memory is below the full-offload threshold");
  });
});
