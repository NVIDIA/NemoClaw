// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { parsePolicyAddOptions } from "./policy-channel";

describe("policy channel helpers", () => {
  it("parses policy add options without reconstructing CLI argv", () => {
    expect(
      parsePolicyAddOptions(
        { preset: "github", dryRun: true, yes: true, fromFile: "preset.yaml" },
        {},
      ),
    ).toEqual({
      dryRun: true,
      skipConfirm: true,
      source: { kind: "file", path: "preset.yaml" },
      presetArg: "github",
    });
  });

  it("parses policy add option errors", () => {
    expect(parsePolicyAddOptions({ fromFile: "a.yaml", fromDir: "dir" }, {})).toEqual({
      dryRun: false,
      skipConfirm: false,
      source: { kind: "error", message: "--from-file and --from-dir are mutually exclusive." },
      presetArg: null,
    });
    expect(parsePolicyAddOptions({ fromFile: "" }, {})).toEqual({
      dryRun: false,
      skipConfirm: false,
      source: { kind: "error", message: "--from-file requires a path argument." },
      presetArg: null,
    });
  });

  it("detects policy confirmation bypass options", () => {
    expect(parsePolicyAddOptions({ yes: true }, {}).skipConfirm).toBe(true);
    expect(parsePolicyAddOptions({ force: true }, {}).skipConfirm).toBe(true);
    expect(parsePolicyAddOptions({}, { NEMOCLAW_NON_INTERACTIVE: "1" }).skipConfirm).toBe(true);
    expect(parsePolicyAddOptions({}, {}).skipConfirm).toBe(false);
  });
});
