// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parseQwenGpuManagedImageReceipt,
  qwenGpuAgentPlan,
  qwenGpuProbeDiagnostic,
  qwenGpuRecipeBinding,
  QWEN_GPU_GATEWAY_NETWORK_PATTERN,
  QWEN_GPU_RECIPE_ID,
  validateQwenGpuProcessEvidence,
} from "../../../scripts/checks/llama-cpp-qwen-gpu-contract.ts";

const IMAGE = `ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:${"a".repeat(64)}`;
const REVISION = "b".repeat(40);
const MANAGED_IMAGE_RECEIPT = {
  kind: "nemoclaw-managed-image-cohort-receipt-v1",
  cohort: "ghrun-123-1",
  revision: REVISION,
  runAttempt: 1,
  runId: 123,
  images: { openclaw: { "linux/amd64": IMAGE } },
};

describe("Qwen llama.cpp RTX qualification plan", () => {
  it("binds the validated managed image to the routed OpenClaw tool journey", () => {
    expect(qwenGpuAgentPlan(IMAGE, REVISION)).toMatchObject({
      agent: "openclaw",
      execution: "enabled",
      image: { reference: IMAGE, sourceRevision: REVISION },
      bounds: { maxStreamEvents: 2048, maxTokens: 1024 },
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

  it("validates the actual managed-image receipt trust boundary", () => {
    expect(parseQwenGpuManagedImageReceipt(JSON.stringify(MANAGED_IMAGE_RECEIPT))).toEqual({
      cohort: "ghrun-123-1",
      revision: REVISION,
      runAttempt: 1,
      runId: 123,
      openClawAmd64: IMAGE,
    });
    expect(() => parseQwenGpuManagedImageReceipt("not-json")).toThrow("not valid JSON");
    expect(() => parseQwenGpuManagedImageReceipt("[]")).toThrow("must be an object");
  });

  it.each([
    ["wrong kind", { ...MANAGED_IMAGE_RECEIPT, kind: "other" }],
    ["invalid revision", { ...MANAGED_IMAGE_RECEIPT, revision: "main" }],
    ["invalid attempt", { ...MANAGED_IMAGE_RECEIPT, runAttempt: 0 }],
    ["invalid run id", { ...MANAGED_IMAGE_RECEIPT, runId: 1.5 }],
    ["unbound cohort", { ...MANAGED_IMAGE_RECEIPT, cohort: "ghrun-elsewhere" }],
    [
      "mutable image",
      {
        ...MANAGED_IMAGE_RECEIPT,
        images: {
          openclaw: {
            "linux/amd64": "ghcr.io/nvidia/nemoclaw/openclaw:latest",
          },
        },
      },
    ],
  ])("rejects a managed-image receipt with %s", (_label, receipt) => {
    expect(() => parseQwenGpuManagedImageReceipt(JSON.stringify(receipt))).toThrow(
      "does not bind one OpenClaw amd64 image",
    );
  });

  it("rejects a preset that no longer binds the intended Qwen recipe", () => {
    expect(qwenGpuRecipeBinding(QWEN_GPU_RECIPE_ID)).toBe(QWEN_GPU_RECIPE_ID);
    expect(() => qwenGpuRecipeBinding("llama-cpp.other.v1")).toThrow(
      "preset does not bind the expected llama.cpp recipe",
    );
  });

  it("requires a unique harness-owned OpenShell gateway network", () => {
    expect(QWEN_GPU_GATEWAY_NETWORK_PATTERN.test("nemoclaw-managed-pr-123-mabc123")).toBe(true);
    expect(QWEN_GPU_GATEWAY_NETWORK_PATTERN.test("openshell-docker")).toBe(false);
  });

  it("binds the Qwen container process to full-offload NVIDIA memory", () => {
    const modelSizeBytes = 20 * 1024 ** 3;
    const fullGpuProcess =
      "PID COMMAND COMMAND\n123 llama-server /usr/local/bin/llama-server --model /models/qwen.gguf --gpu-layers all\n";
    expect(
      validateQwenGpuProcessEvidence(
        fullGpuProcess,
        "123, /usr/local/bin/llama-server, 22000\n",
        modelSizeBytes,
      ),
    ).toEqual({
      gpuLayerRequest: "all",
      processName: "/usr/local/bin/llama-server",
      usedGpuMemoryMiB: 22000,
      minimumFullOffloadMemoryMiB: 20480,
    });
    expect(() =>
      validateQwenGpuProcessEvidence(
        fullGpuProcess,
        "456, /usr/local/bin/llama-server, 22000\n",
        modelSizeBytes,
      ),
    ).toThrow("Qwen llama-server is not the exact NVIDIA compute process");
    expect(() =>
      validateQwenGpuProcessEvidence(
        fullGpuProcess,
        "123, /usr/local/bin/llama-server, 20000\n",
        modelSizeBytes,
      ),
    ).toThrow("Qwen llama-server GPU memory is below the full-offload threshold");
    expect(() =>
      validateQwenGpuProcessEvidence(
        "PID COMMAND COMMAND\n123 llama-server /usr/local/bin/llama-server --gpu-layers 40\n",
        "123, /usr/local/bin/llama-server, 22000\n",
        modelSizeBytes,
      ),
    ).toThrow("process does not request every GPU layer");
  });

  it("bounds probe diagnostics and redacts exact and credential-shaped secrets", () => {
    const diagnostic = qwenGpuProbeDiagnostic(
      "openclaw-agent:normal",
      {
        status: 1,
        stdout: `${"x".repeat(5000)} Bearer explicit-secret`,
        stderr: "API_TOKEN=token-shaped-value",
      },
      ["explicit-secret"],
    );
    expect(diagnostic).toMatchObject({
      label: "openclaw-agent:normal",
      status: 1,
      stderr: "API_TOKEN=<REDACTED>",
    });
    expect(Buffer.byteLength(diagnostic.stdout)).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(diagnostic)).not.toContain("explicit-secret");
    expect(JSON.stringify(diagnostic)).not.toContain("token-shaped-value");
  });
});
