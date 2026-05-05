// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parseCustomPolicySource,
  parsePolicyAddArgs,
  shouldSkipPolicyConfirmation,
} from "./policy-channel-helpers";

describe("policy channel helpers", () => {
  it("parses custom policy source flags", () => {
    expect(parseCustomPolicySource([])).toEqual({ kind: "none" });
    expect(parseCustomPolicySource(["--from-file", "preset.yaml"])).toEqual({
      kind: "file",
      path: "preset.yaml",
    });
    expect(parseCustomPolicySource(["--from-dir", "presets"])).toEqual({
      kind: "dir",
      path: "presets",
    });
  });

  it("reports custom policy source errors", () => {
    expect(parseCustomPolicySource(["--from-file"])).toEqual({
      kind: "error",
      message: "--from-file requires a path argument.",
    });
    expect(parseCustomPolicySource(["--from-file", "a.yaml", "--from-dir", "dir"])).toEqual({
      kind: "error",
      message: "--from-file and --from-dir are mutually exclusive.",
    });
  });

  it("detects policy confirmation bypass flags", () => {
    expect(shouldSkipPolicyConfirmation(["--yes"])).toBe(true);
    expect(shouldSkipPolicyConfirmation(["-y"])).toBe(true);
    expect(shouldSkipPolicyConfirmation(["--force"])).toBe(true);
    expect(shouldSkipPolicyConfirmation([], { NEMOCLAW_NON_INTERACTIVE: "1" })).toBe(true);
    expect(shouldSkipPolicyConfirmation([], {})).toBe(false);
  });

  it("parses policy add args", () => {
    expect(parsePolicyAddArgs(["github", "--dry-run", "--yes"], {})).toEqual({
      dryRun: true,
      skipConfirm: true,
      source: { kind: "none" },
      presetArg: "github",
    });
  });
});
