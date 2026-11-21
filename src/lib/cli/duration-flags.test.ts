// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parseLogsSinceDuration } from "./duration-flags";

describe("oclif duration flag parsers", () => {
  it("normalizes logs --since durations", () => {
    expect(parseLogsSinceDuration(" 5m ")).toBe("5m");
    expect(parseLogsSinceDuration("30s")).toBe("30s");
    expect(parseLogsSinceDuration("1h")).toBe("1h");
  });

  it.each(["0s", "someday", "500ms", "1d", "5M"])(
    "rejects logs --since duration %j with the public parser message",
    (input) => {
      expect(() => parseLogsSinceDuration(input)).toThrow(
        "--since requires a positive duration like 5m, 1h, or 30s",
      );
    },
  );
});
