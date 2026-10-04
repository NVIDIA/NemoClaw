// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  DCODE_AUTO_APPROVAL_BUILD_ARG,
  DCODE_AUTO_APPROVAL_FEATURE,
  DEFAULT_DCODE_AUTO_APPROVAL_MODE,
  hasDcodeAutoApprovalDrift,
  invalidRecordedDcodeAutoApprovalMode,
  normalizeDcodeAutoApprovalMode,
  prepareDcodeAutoApprovalCreatePlan,
} from "./dcode-auto-approval";

describe("DCode auto-approval capability", () => {
  it("defaults missing and malformed input to the closed mode (#6478)", () => {
    expect(DEFAULT_DCODE_AUTO_APPROVAL_MODE).toBe("disabled");
    expect(DCODE_AUTO_APPROVAL_BUILD_ARG).toBe("NEMOCLAW_DCODE_AUTO_APPROVAL");
    expect(normalizeDcodeAutoApprovalMode(undefined)).toBe("disabled");
    expect(normalizeDcodeAutoApprovalMode("THREAD-OPT-IN")).toBe("disabled");
    expect(normalizeDcodeAutoApprovalMode("thread-opt-in")).toBe("thread-opt-in");
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

  it("prepares the managed create projection and rebuild flag (#6478)", () => {
    expect(
      prepareDcodeAutoApprovalCreatePlan({
        sandboxName: "alpha",
        liveExists: true,
        managedDcodeAgent: true,
        registryEntry: { dcodeAutoApprovalMode: "disabled" },
        requestedMode: "thread-opt-in",
      }),
    ).toEqual({
      mode: "thread-opt-in",
      hasDrift: true,
      rebuildFlag: " --dcode-auto-approval thread-opt-in",
    });
  });

  it.each([
    ["orphaned", null, "missing its NemoClaw registry record"],
    ["malformed", { dcodeAutoApprovalMode: "always" }, "mode is invalid"],
  ])("rejects %s create state before mutation (#6478)", (_label, registryEntry, message) => {
    const error = vi.fn();
    expect(() =>
      prepareDcodeAutoApprovalCreatePlan(
        {
          sandboxName: "alpha",
          liveExists: true,
          managedDcodeAgent: true,
          registryEntry,
          requestedMode: "thread-opt-in",
        },
        {
          error,
          exitProcess: vi.fn(() => {
            throw new Error("exit 1");
          }),
        },
      ),
    ).toThrow("exit 1");
    expect(error.mock.calls.flat().join("\n")).toContain(message);
  });
});
