// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { verifyNemoClawRefFidelity } from "../live/openclaw-tui-ref-fidelity.ts";

const EXPECTED_REF = "0123456789abcdef0123456789abcdef01234567";
const CLI_PATH = "/repo/bin/nemoclaw.js";

describe("OpenClaw TUI NemoClaw ref fidelity", () => {
  it("records the exact checkout that produced the tested CLI", () => {
    expect(
      verifyNemoClawRefFidelity({
        expectedRef: EXPECTED_REF,
        actualRef: EXPECTED_REF,
        cliPath: CLI_PATH,
        expectedCliPath: CLI_PATH,
      }),
    ).toEqual({
      expectedRef: EXPECTED_REF,
      actualRef: EXPECTED_REF,
      cliPath: CLI_PATH,
      source: "workflow-checkout",
    });
  });

  it("fails fast when the tested checkout does not match the workflow ref", () => {
    const actualRef = "fedcba9876543210fedcba9876543210fedcba98";
    expect(() =>
      verifyNemoClawRefFidelity({
        expectedRef: EXPECTED_REF,
        actualRef,
        cliPath: CLI_PATH,
        expectedCliPath: CLI_PATH,
      }),
    ).toThrow(`tested NemoClaw ref mismatch: expected ${EXPECTED_REF}, received ${actualRef}`);
  });

  it("rejects missing workflow evidence and a CLI outside the checkout", () => {
    expect(() =>
      verifyNemoClawRefFidelity({
        expectedRef: undefined,
        actualRef: EXPECTED_REF,
        cliPath: CLI_PATH,
        expectedCliPath: CLI_PATH,
      }),
    ).toThrow(/NEMOCLAW_TUI_EXPECTED_CHECKOUT_SHA/u);

    expect(() =>
      verifyNemoClawRefFidelity({
        expectedRef: EXPECTED_REF,
        actualRef: EXPECTED_REF,
        cliPath: "/usr/local/bin/nemoclaw",
        expectedCliPath: CLI_PATH,
      }),
    ).toThrow(/CLI does not come from the tested checkout/u);
  });
});
