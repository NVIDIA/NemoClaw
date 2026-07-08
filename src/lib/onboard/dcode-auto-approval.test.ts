// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  DCODE_AUTO_APPROVAL_BUILD_ARG,
  DCODE_AUTO_APPROVAL_FEATURE,
  DEFAULT_DCODE_AUTO_APPROVAL_MODE,
  dcodeAutoApprovalModeOrDefault,
  hasDcodeAutoApprovalDrift,
  invalidRecordedDcodeAutoApprovalMode,
  normalizeDcodeAutoApprovalMode,
} from "./dcode-auto-approval";

describe("DCode auto-approval capability", () => {
  it("defaults missing and malformed input to the closed mode (#6478)", () => {
    expect(DEFAULT_DCODE_AUTO_APPROVAL_MODE).toBe("disabled");
    expect(DCODE_AUTO_APPROVAL_BUILD_ARG).toBe("NEMOCLAW_DCODE_AUTO_APPROVAL");
    expect(normalizeDcodeAutoApprovalMode(undefined)).toBe("disabled");
    expect(normalizeDcodeAutoApprovalMode("THREAD-OPT-IN")).toBe("disabled");
    expect(dcodeAutoApprovalModeOrDefault("thread-opt-in")).toBe("thread-opt-in");
    expect(invalidRecordedDcodeAutoApprovalMode(undefined)).toBe(false);
    expect(invalidRecordedDcodeAutoApprovalMode("always")).toBe(true);
  });

  it("is enabled only for thread opt-in on Deep Agents Code (#6478)", () => {
    expect(DCODE_AUTO_APPROVAL_FEATURE.supportsAgent("langchain-deepagents-code")).toBe(true);
    expect(DCODE_AUTO_APPROVAL_FEATURE.supportsAgent("hermes")).toBe(false);
    expect(DCODE_AUTO_APPROVAL_FEATURE.isEnabled("disabled")).toBe(false);
    expect(DCODE_AUTO_APPROVAL_FEATURE.isEnabled("thread-opt-in")).toBe(true);
  });

  it("treats missing legacy state as disabled without forcing migration (#6478)", () => {
    expect(
      hasDcodeAutoApprovalDrift({
        liveExists: true,
        managedDcodeAgent: true,
        hasRegistryEntry: true,
        recordedDcodeAutoApprovalMode: undefined,
        requestedDcodeAutoApprovalMode: "disabled",
      }),
    ).toBe(false);
    expect(
      hasDcodeAutoApprovalDrift({
        liveExists: true,
        managedDcodeAgent: true,
        hasRegistryEntry: true,
        recordedDcodeAutoApprovalMode: undefined,
        requestedDcodeAutoApprovalMode: "thread-opt-in",
      }),
    ).toBe(true);
  });

  it("marks malformed recorded state as drift without ever enabling it (#6478)", () => {
    expect(
      hasDcodeAutoApprovalDrift({
        liveExists: true,
        managedDcodeAgent: true,
        hasRegistryEntry: true,
        recordedDcodeAutoApprovalMode: "always",
        requestedDcodeAutoApprovalMode: "thread-opt-in",
      }),
    ).toBe(true);
    expect(normalizeDcodeAutoApprovalMode("always")).toBe("disabled");
  });
});
