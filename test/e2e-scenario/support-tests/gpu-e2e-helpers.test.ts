// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DEFAULT_OLLAMA_PULL_TIMEOUT_SECONDS,
  resolveOllamaPullTimeoutSeconds,
} from "../live/gpu-e2e-helpers.ts";

describe("GPU E2E helpers", () => {
  it("gives cold Ollama model pulls a 40 minute wall-clock budget", () => {
    expect(DEFAULT_OLLAMA_PULL_TIMEOUT_SECONDS).toBe("2400");
    expect(resolveOllamaPullTimeoutSeconds(undefined)).toBe("2400");
    expect(resolveOllamaPullTimeoutSeconds(" ")).toBe("2400");
  });

  it("preserves an explicit Ollama model pull timeout override", () => {
    expect(resolveOllamaPullTimeoutSeconds("3600")).toBe("3600");
  });
});
