// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { slashShieldsStatus } from "./shields-status.js";

describe("commands/shields-status", () => {
  it.each([
    { label: "an omitted", arg: undefined },
    { label: "an empty", arg: "" },
    { label: "a whitespace-only", arg: "   " },
    { label: "an explicit", arg: "status" },
  ])("directs $label status request to the authoritative host CLI", ({ arg }) => {
    const result = slashShieldsStatus(arg);

    expect(result.text).toContain("Shields status unavailable inside the sandbox");
    expect(result.text).toContain("cannot verify the host-side shields posture");
    expect(result.text).toContain("nemoclaw <name> shields status");
    expect(result.text).not.toMatch(/Shields: (UP|DOWN|NOT CONFIGURED)/);
  });

  it.each(["up", "down"])("returns host-only guidance for `%s`", (action) => {
    const result = slashShieldsStatus(action);

    expect(result.text).toContain(`Shields ${action}`);
    expect(result.text).toContain("host-only");
    expect(result.text).toContain(`nemoclaw <name> shields ${action}`);
    expect(result.text).toContain("cannot verify shields status");
  });

  it("trims surrounding whitespace before classifying the sub-argument", () => {
    const result = slashShieldsStatus("  down  ");
    expect(result.text).toContain("Shields down");
    expect(result.text).toContain("host-only");
  });

  it("returns usage for an unrecognised sub-argument", () => {
    const result = slashShieldsStatus("abcxyz");
    expect(result.text).toContain("Unknown argument");
    expect(result.text).toContain("abcxyz");
    expect(result.text).toContain("/nemoclaw shields [status]");
  });

  it("strips Markdown delimiters from an echoed unknown argument", () => {
    const result = slashShieldsStatus("`evil`");
    expect(result.text).toContain("Unknown argument");
    expect(result.text).not.toContain("`evil`");
    expect(result.text).toContain("?evil?");
  });

  it("strips ASCII control characters from an echoed unknown argument", () => {
    const result = slashShieldsStatus("ab\x01cd\x1Fef");
    expect(result.text).toContain("Unknown argument");
    expect(result.text).toContain("ab?cd?ef");
    expect(result.text).not.toContain("\x01");
    expect(result.text).not.toContain("\x1F");
  });

  it("truncates an overly long unknown argument", () => {
    const result = slashShieldsStatus("a".repeat(64));
    expect(result.text).toContain(`${"a".repeat(32)}…`);
    expect(result.text).not.toContain("a".repeat(33));
  });
});
