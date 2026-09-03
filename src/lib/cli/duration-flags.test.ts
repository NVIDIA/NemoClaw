// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseLogsSinceDuration } from "./duration-flags";

describe("oclif duration flag parsers", () => {
  it("normalizes logs --since durations", () => {
    expect(parseLogsSinceDuration(" 5m ")).toBe("5m");
    expect(parseLogsSinceDuration("30s")).toBe("30s");
  });

  it("rejects invalid logs --since durations with the public parser message", () => {
    expect(() => parseLogsSinceDuration("0s")).toThrow(
      "--since requires a positive duration like 5m, 1h, or 30s",
    );
    expect(() => parseLogsSinceDuration("someday")).toThrow(
      "--since requires a positive duration like 5m, 1h, or 30s",
    );
  });
});
