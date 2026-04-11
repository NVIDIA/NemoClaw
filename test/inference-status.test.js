// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const { getInferenceRuntimeStatus } = require("../bin/lib/inference-status");

describe("inference runtime status", () => {
  it("reports Ollama without mentioning NIM", () => {
    assert.deepEqual(
      getInferenceRuntimeStatus({
        name: "assistant",
        provider: "ollama-local",
        providerBaseUrl: "http://host.docker.internal:11434/v1",
      }),
      [{ label: "Ollama", value: "configured (http://host.docker.internal:11434/v1)" }],
    );
  });

  it("reports external vLLM without mentioning NIM", () => {
    assert.deepEqual(
      getInferenceRuntimeStatus({
        name: "assistant",
        provider: "vllm-local",
        providerBaseUrl: "http://host.openshell.internal:8000/v1",
      }),
      [{ label: "vLLM", value: "configured (http://host.openshell.internal:8000/v1)" }],
    );
  });

  it("reports NIM when a managed NIM container is present", () => {
    assert.deepEqual(
      getInferenceRuntimeStatus(
        {
          name: "assistant",
          provider: "vllm-local",
          nimContainer: "nim-assistant",
        },
        () => ({ running: true, healthy: true, container: "nim-assistant" }),
      ),
      [
        { label: "NIM", value: "running (nim-assistant)" },
        { label: "Healthy", value: "yes" },
      ],
    );
  });
});
