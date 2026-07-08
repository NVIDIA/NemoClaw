// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const {
  getKimiK26ValidationProbeCurlArgs,
  getValidationProbeCurlArgs,
} = require("./probe-http-helpers");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validation probe curl timing helpers", () => {
  it("allows onboard validation max-time to be raised from the environment", () => {
    vi.stubEnv("NEMOCLAW_ONBOARD_VALIDATION_TIMEOUT_SECONDS", "300");
    expect(getValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "300",
    ]);
    expect(getKimiK26ValidationProbeCurlArgs({ isWsl: false })).toEqual([
      "--connect-timeout",
      "10",
      "--max-time",
      "300",
    ]);
  });
});
