// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  CONTAINER_REACHABILITY_IMAGE,
  getWindowsHostOllamaDockerHostValidationArgs,
  isOllamaHostValidationEnabled,
} from "./local";

describe("Windows-host Ollama Host validation", () => {
  it("probes Docker Desktop with an untrusted Host header", () => {
    expect(getWindowsHostOllamaDockerHostValidationArgs()).toEqual([
      "run",
      "--rm",
      CONTAINER_REACHABILITY_IMAGE,
      "-sS",
      "--output",
      "/dev/null",
      "--write-out",
      "%{http_code}",
      "--connect-timeout",
      "2",
      "--max-time",
      "5",
      "--header",
      "Host: rebinding.invalid",
      "http://host.docker.internal:11434/api/tags",
    ]);
  });

  it.each([
    ["403", true],
    [" 403\n", true],
    ["200", false],
    ["", false],
  ])("classifies HTTP status %j as protected=%s", (output, expected) => {
    expect(isOllamaHostValidationEnabled(output)).toBe(expected);
  });
});
