// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  decideSandboxResume,
  hasHermesCompatibleAnthropicInferenceRouteDrift,
  type SandboxResumeSignals,
} from "./sandbox-resume";

function resumeSignals(overrides: Partial<SandboxResumeSignals> = {}): SandboxResumeSignals {
  return {
    resume: true,
    resumeAgentChanged: false,
    sandboxStepComplete: true,
    sandboxReuseState: "ready",
    inferenceRouteConfigChanged: false,
    webSearchConfigChanged: false,
    sandboxGpuConfigChanged: false,
    messagingChannelConfigChanged: false,
    hermesToolGatewayConfigChanged: false,
    toolDisclosureMigrationNeeded: false,
    toolDisclosureChanged: false,
    inferenceSelectionChanged: false,
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
    ["observability", { observabilityChanged: true }, false],
    ["DCode auto-approval", { dcodeAutoApprovalChanged: true }, false],
    ["tool disclosure migration", { toolDisclosureMigrationNeeded: true }, false],
    ["tool disclosure", { toolDisclosureChanged: true }, false],
    ["live DCode inference selection", { inferenceSelectionChanged: true }, false],
  ] as const)("recreates for %s drift", (_label, overrides, removeRegistryEntry) => {
    expect(decideSandboxResume(resumeSignals(overrides))).toMatchObject({
      kind: "recreate",
      removeRegistryEntry,
    });
  });

  it("preserves registry fidelity while recreating for Hermes inference route drift", () => {
    expect(decideSandboxResume(resumeSignals({ inferenceRouteConfigChanged: true }))).toEqual({
      kind: "recreate",
      note: "  [resume] Hermes inference route configuration changed; recreating sandbox.",
      removeRegistryEntry: false,
    });
  });

  it("treats missing registry API metadata as stale after the session is repaired (#6289)", () => {
    expect(
      hasHermesCompatibleAnthropicInferenceRouteDrift({
        agentName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        preferredInferenceApi: "openai-completions",
        registryEntry: {
          name: "saved",
          provider: "compatible-anthropic-endpoint",
          model: "claude-sonnet-proxy",
        },
      }),
    ).toBe(true);
  });

  it("reuses a Hermes route only when registry metadata records the OpenAI frontend (#6289)", () => {
    expect(
      hasHermesCompatibleAnthropicInferenceRouteDrift({
        agentName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        preferredInferenceApi: "openai-completions",
        registryEntry: {
          name: "saved",
          provider: "compatible-anthropic-endpoint",
          model: "claude-sonnet-proxy",
          preferredInferenceApi: "openai-completions",
        },
      }),
    ).toBe(false);
  });

  it.each([
    ["another agent", { agentName: "openclaw" }],
    ["another provider", { provider: "anthropic-prod" }],
    ["the native Anthropic frontend", { preferredInferenceApi: "anthropic-messages" }],
    ["no selected model", { model: null }],
  ])("does not report Hermes compatible-route drift for %s (#6289)", (_label, overrides) => {
    expect(
      hasHermesCompatibleAnthropicInferenceRouteDrift({
        agentName: "hermes",
        provider: "compatible-anthropic-endpoint",
        model: "claude-sonnet-proxy",
        preferredInferenceApi: "openai-completions",
        registryEntry: null,
        ...overrides,
      }),
    ).toBe(false);
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

  it("repairs a not-ready sandbox before recreating for DCode auto-approval drift", () => {
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxReuseState: "not_ready",
          dcodeAutoApprovalChanged: true,
        }),
      ),
    ).toEqual({ kind: "repair-and-recreate" });
  });

  it("creates without resume-specific cleanup when the step is incomplete", () => {
    expect(
      decideSandboxResume(
        resumeSignals({ sandboxStepComplete: false, webSearchConfigChanged: true }),
      ),
    ).toEqual({ kind: "create" });
  });
});
