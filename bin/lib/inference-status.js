// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

function getInferenceRuntimeStatus(
  sandbox = {},
  nimStatusResolver = () => ({ running: false, healthy: false }),
) {
  const provider = sandbox.provider || "unknown";
  const providerBaseUrl = sandbox.providerBaseUrl || null;

  if (provider === "ollama-local") {
    return [
      {
        label: "Ollama",
        value: providerBaseUrl ? `configured (${providerBaseUrl})` : "configured",
      },
    ];
  }

  if (provider === "vllm-local") {
    const nimStatus = nimStatusResolver();
    if (sandbox.nimContainer || nimStatus.running) {
      const nimValue = nimStatus.running
        ? nimStatus.container
          ? `running (${nimStatus.container})`
          : "running"
        : "not running";
      const lines = [
        {
          label: "NIM",
          value: nimValue,
        },
      ];
      if (nimStatus.running) {
        lines.push({ label: "Healthy", value: nimStatus.healthy ? "yes" : "no" });
      }
      return lines;
    }

    return [
      {
        label: "vLLM",
        value: providerBaseUrl ? `configured (${providerBaseUrl})` : "configured",
      },
    ];
  }

  if (provider === "nvidia-nim") {
    return [{ label: "Runtime", value: "NVIDIA Cloud API" }];
  }

  return [];
}

module.exports = { getInferenceRuntimeStatus };
