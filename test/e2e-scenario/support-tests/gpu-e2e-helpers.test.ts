// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { env } from "../live/gpu-e2e-helpers.ts";

describe("GPU E2E helpers", () => {
  it("gives cold Ollama model pulls a 40 minute wall-clock budget", () => {
    expect(env({}, {}).NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe("2400");
    expect(env({}, { NEMOCLAW_OLLAMA_PULL_TIMEOUT: " " }).NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe(
      "2400",
    );
  });

  it("preserves an explicit Ollama model pull timeout override", () => {
    expect(env({}, { NEMOCLAW_OLLAMA_PULL_TIMEOUT: "3600" }).NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe(
      "3600",
    );
  });
});
