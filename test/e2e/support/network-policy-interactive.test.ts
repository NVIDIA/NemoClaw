// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  findPolicyPresetNumber,
  POLICY_ADD_EXPECT_SCRIPT,
  requirePolicyPresetNumber,
} from "../live/network-policy-interactive.ts";

describe("network-policy interactive preset harness", () => {
  it("selects the exact requested preset from the interactive list", () => {
    const output = `
  14) ○ hermes-slack — unrelated prefix
  15) ○ slack — Slack API access
  16) ● pypi — Python Package Index
`;

    expect(findPolicyPresetNumber(output, "slack")).toBe("15");
    expect(findPolicyPresetNumber(output, "pypi")).toBe("16");
    expect(findPolicyPresetNumber(output, "missing")).toBeNull();
    expect(() => requirePolicyPresetNumber(output, "missing")).toThrow(/preset missing not found/);
  });

  it("waits for each prompt before sending the corresponding response", () => {
    expect(POLICY_ADD_EXPECT_SCRIPT).toContain('-glob "*Choose preset*"');
    expect(POLICY_ADD_EXPECT_SCRIPT).toContain('send -- "$env(NEMOCLAW_E2E_PRESET_NUM)\\r"');
    expect(POLICY_ADD_EXPECT_SCRIPT).toContain('-glob "*Y/n*"');
    expect(POLICY_ADD_EXPECT_SCRIPT).toContain('send -- "Y\\r"');
    expect(POLICY_ADD_EXPECT_SCRIPT).not.toMatch(/printf.*Y/);
  });
});
