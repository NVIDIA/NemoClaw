// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { hasAgentPassthroughHelpToken } from "./passthrough-help";

describe("hasAgentPassthroughHelpToken", () => {
  it("returns true for --help before the OpenClaw argv separator", () => {
    expect(hasAgentPassthroughHelpToken(["--help"])).toBe(true);
    expect(hasAgentPassthroughHelpToken(["-h", "-m", "hi"])).toBe(true);
  });

  it("ignores --help that appears after the OpenClaw argv separator", () => {
    expect(hasAgentPassthroughHelpToken(["--", "--help"])).toBe(false);
  });

  it("returns false for unrelated flags", () => {
    expect(hasAgentPassthroughHelpToken(["-m", "hi"])).toBe(false);
    expect(hasAgentPassthroughHelpToken([])).toBe(false);
  });
});
