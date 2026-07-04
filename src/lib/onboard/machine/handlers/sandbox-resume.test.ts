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
    toolDisclosureMigrationNeeded: false,
    toolDisclosureChanged: false,
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
    ["tool disclosure migration", { toolDisclosureMigrationNeeded: true }, false],
    ["tool disclosure", { toolDisclosureChanged: true }, false],
  ] as const)("recreates for %s drift", (_label, overrides, removeRegistryEntry) => {
    expect(decideSandboxResume(resumeSignals(overrides))).toMatchObject({
      kind: "recreate",
      removeRegistryEntry,
    });
  });

  it("distinguishes one-time tool-disclosure migration from user configuration drift", () => {
    expect(
      decideSandboxResume(resumeSignals({ toolDisclosureMigrationNeeded: true })),
    ).toMatchObject({
      kind: "recreate",
      note: expect.stringContaining("metadata is missing"),
    });
    expect(decideSandboxResume(resumeSignals({ toolDisclosureChanged: true }))).toMatchObject({
      kind: "recreate",
      note: expect.stringContaining("configuration changed"),
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
