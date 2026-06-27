// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { decideSandboxResume, type SandboxResumeSignals } from "./sandbox-resume";

function resumeSignals(overrides: Partial<SandboxResumeSignals> = {}): SandboxResumeSignals {
  return {
    resume: true,
    resumeAgentChanged: false,
    sandboxStepComplete: true,
    sandboxReuseState: "ready",
    webSearchConfigChanged: false,
    sandboxGpuConfigChanged: false,
    messagingChannelConfigChanged: false,
    hermesToolGatewayConfigChanged: false,
    ...overrides,
  };
}

describe("decideSandboxResume", () => {
  it("reuses only a complete ready sandbox without configuration drift", () => {
    expect(decideSandboxResume(resumeSignals())).toEqual({ kind: "reuse" });
  });

  it.each([
    ["agent", { resumeAgentChanged: true }, false],
    ["web search", { webSearchConfigChanged: true }, true],
    ["sandbox GPU", { sandboxGpuConfigChanged: true }, true],
    ["messaging", { messagingChannelConfigChanged: true }, true],
    ["Hermes tool gateway", { hermesToolGatewayConfigChanged: true }, true],
  ] as const)("recreates for %s drift", (_label, overrides, removeRegistryEntry) => {
    expect(decideSandboxResume(resumeSignals(overrides))).toMatchObject({
      kind: "recreate",
      removeRegistryEntry,
    });
  });

  it("repairs a recorded sandbox that is present but not ready", () => {
    expect(decideSandboxResume(resumeSignals({ sandboxReuseState: "not_ready" }))).toEqual({
      kind: "repair-and-recreate",
    });
  });

  it("creates without resume-specific cleanup when the step is incomplete", () => {
    expect(
      decideSandboxResume(
        resumeSignals({ sandboxStepComplete: false, webSearchConfigChanged: true }),
      ),
    ).toEqual({ kind: "create" });
  });
});
