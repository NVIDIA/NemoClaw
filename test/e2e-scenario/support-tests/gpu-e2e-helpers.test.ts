// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_OLLAMA_PULL_TIMEOUT_SECONDS, env } from "../live/gpu-e2e-helpers.ts";

const ORIGINAL_PULL_TIMEOUT = process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT;

afterEach(() => {
  if (ORIGINAL_PULL_TIMEOUT === undefined) {
    delete process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT;
  } else {
    process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT = ORIGINAL_PULL_TIMEOUT;
  }
});

describe("GPU E2E helpers", () => {
  it("gives cold Ollama model pulls a 40 minute wall-clock budget", () => {
    delete process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT;

    expect(DEFAULT_OLLAMA_PULL_TIMEOUT_SECONDS).toBe("2400");
    expect(env().NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe("2400");
  });

  it("preserves an explicit Ollama model pull timeout override", () => {
    process.env.NEMOCLAW_OLLAMA_PULL_TIMEOUT = "3600";

    expect(env().NEMOCLAW_OLLAMA_PULL_TIMEOUT).toBe("3600");
  });
});
