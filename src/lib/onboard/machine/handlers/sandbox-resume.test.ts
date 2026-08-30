// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  decideSandboxResume,
  hasCompatibleEndpointReasoningDrift,
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
    compatibleEndpointReasoningChanged: false,
    webSearchConfigChanged: false,
    sandboxGpuConfigChanged: false,
    hostMountConfigChanged: false,
    recreateSandboxRequested: false,
    messagingChannelConfigChanged: false,
    messagingCredentialChanged: false,
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

  it("continues pending Hermes Portable lifecycle custody instead of reusing its Ready sandbox (#9211)", () => {
    expect(decideSandboxResume(resumeSignals({ hermesPortableLifecyclePending: true }))).toEqual({
      kind: "create",
      continueHermesPortableLifecycle: true,
    });
  });

  it("reuses a Hermes Portable sandbox after lifecycle custody is finalized (#9211)", () => {
    expect(decideSandboxResume(resumeSignals({ hermesPortableLifecyclePending: false }))).toEqual({
      kind: "reuse",
    });
  });

  it.each([
    ["agent", { resumeAgentChanged: true }, false],
    ["compatible endpoint reasoning", { compatibleEndpointReasoningChanged: true }, false],
    ["web search", { webSearchConfigChanged: true }, true],
    ["explicit recreate", { recreateSandboxRequested: true }, false],
    ["sandbox GPU", { sandboxGpuConfigChanged: true }, true],
    ["read-only host mounts", { hostMountConfigChanged: true }, false],
    ["messaging", { messagingChannelConfigChanged: true }, true],
    ["messaging credential", { messagingCredentialChanged: true }, true],
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

  it.each(["missing", "not_ready"])(
    "continues an owned recreate when the outer transaction leaves the source %s (#10056)",
    (sandboxReuseState) => {
      expect(
        decideSandboxResume(
          resumeSignals({
            sandboxStepComplete: false,
            sandboxReuseState,
            recreateSandboxRequested: true,
            recreateJournalHandoff: true,
          }),
        ),
      ).toEqual({
        kind: "recreate",
        note: "  [resume] Continuing journaled sandbox recreation.",
        removeRegistryEntry: false,
      });
    },
  );

  it.each(["ready", "missing", "not_ready"])(
    "continues a validated active recreate while its source is %s (#10056)",
    (sandboxReuseState) => {
      expect(
        decideSandboxResume(
          resumeSignals({
            sandboxStepComplete: false,
            sandboxReuseState,
            activeRecreateJournal: true,
          }),
        ),
      ).toEqual({
        kind: "recreate",
        note: "  [resume] Continuing journaled sandbox recreation.",
        removeRegistryEntry: false,
      });
    },
  );

  it("does not continue an active recreate when source state is unknown (#10056)", () => {
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxStepComplete: false,
          sandboxReuseState: "unknown",
          activeRecreateJournal: true,
        }),
      ),
    ).toEqual({ kind: "create" });
  });

  it("does not trust a journal handoff when the sandbox state is unknown", () => {
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxStepComplete: false,
          sandboxReuseState: "unknown",
          recreateSandboxRequested: true,
          recreateJournalHandoff: true,
        }),
      ),
    ).toEqual({ kind: "create" });
  });

  it.each([
    [
      "only explicit recreation is requested",
      { recreateSandboxRequested: true, recreateJournalHandoff: false },
    ],
    [
      "only a journal handoff is present",
      { recreateSandboxRequested: false, recreateJournalHandoff: true },
    ],
  ])("repairs a not-ready sandbox when %s", (_scenario, overrides) => {
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxReuseState: "not_ready",
          ...overrides,
        }),
      ),
    ).toEqual({ kind: "repair-and-recreate" });
  });

  it("repairs a not-ready sandbox with DCode auto-approval drift", () => {
    // DCode auto-approval guards against not_ready internally (see
    // runtimeConfigurationResumeDecision); the sandbox falls through to
    // repair-and-recreate at the bottom.
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxReuseState: "not_ready",
          dcodeAutoApprovalChanged: true,
        }),
      ),
    ).toEqual({ kind: "repair-and-recreate" });
  });

  it("repairs a not-ready sandbox even with reasoning capability drift (#7570)", () => {
    // compatibleEndpointReasoningChanged only triggers recreate when the
    // sandbox is ready; when not_ready, the sandbox falls through to repair.
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxReuseState: "not_ready",
          compatibleEndpointReasoningChanged: true,
        }),
      ),
    ).toEqual({ kind: "repair-and-recreate" });
  });

  it.each([
    [
      "live DCode inference selection",
      { inferenceSelectionChanged: true },
      "Live DCode model/provider",
    ],
    ["agent selection", { resumeAgentChanged: true }, "Agent selection changed"],
    [
      "Hermes inference route",
      { inferenceRouteConfigChanged: true },
      "Hermes inference route configuration changed",
    ],
  ] as const)(
    "uses compatibility recreate for %s drift even when not-ready (#10056)",
    (_label, drift, expectedNoteFragment) => {
      expect(
        decideSandboxResume(
          resumeSignals({
            sandboxReuseState: "not_ready",
            ...drift,
          }),
        ),
      ).toEqual({
        kind: "recreate",
        note: expect.stringContaining(expectedNoteFragment),
        removeRegistryEntry: false,
      });
    },
  );

  it.each([
    [
      "web search config change",
      { webSearchConfigChanged: true },
      "Web Search configuration changed",
      true,
    ],
    [
      "sandbox GPU config change",
      { sandboxGpuConfigChanged: true },
      "Sandbox GPU settings changed",
      true,
    ],
    [
      "messaging channel config change",
      { messagingChannelConfigChanged: true },
      "Messaging channel configuration changed",
      true,
    ],
    [
      "Hermes tool gateway config change",
      { hermesToolGatewayConfigChanged: true },
      "Hermes managed tool gateway selection changed",
      true,
    ],
    [
      "observability change",
      { observabilityChanged: true },
      "Observability configuration changed",
      false,
    ],
  ] as const)(
    "uses runtime-configuration recreate for %s even when not-ready (#10056)",
    (_label, drift, expectedNoteFragment, expectedRemoveRegistry) => {
      expect(
        decideSandboxResume(
          resumeSignals({
            sandboxReuseState: "not_ready",
            ...drift,
          }),
        ),
      ).toEqual({
        kind: "recreate",
        note: expect.stringContaining(expectedNoteFragment),
        removeRegistryEntry: expectedRemoveRegistry,
      });
    },
  );

  it.each([
    [
      "tool disclosure migration",
      { toolDisclosureMigrationNeeded: true },
      "metadata is missing",
      false,
    ],
    ["tool disclosure change", { toolDisclosureChanged: true }, "configuration changed", false],
  ] as const)(
    "uses tool-disclosure recreate for %s even when not-ready (#10056)",
    (_label, drift, expectedNoteFragment, expectedRemoveRegistry) => {
      expect(
        decideSandboxResume(
          resumeSignals({
            sandboxReuseState: "not_ready",
            ...drift,
          }),
        ),
      ).toEqual({
        kind: "recreate",
        note: expect.stringContaining(expectedNoteFragment),
        removeRegistryEntry: expectedRemoveRegistry,
      });
    },
  );

  it("creates without resume-specific cleanup when the step is incomplete", () => {
    expect(
      decideSandboxResume(
        resumeSignals({
          sandboxStepComplete: false,
          compatibleEndpointReasoningChanged: true,
          webSearchConfigChanged: true,
        }),
      ),
    ).toEqual({ kind: "create" });
  });
});

describe("hasCompatibleEndpointReasoningDrift", () => {
  it("compares the validated capability with the image-baked registry value (#7570)", () => {
    expect(
      hasCompatibleEndpointReasoningDrift({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "true",
        registryEntry: { name: "saved", compatibleEndpointReasoning: "false" },
      }),
    ).toBe(true);
    expect(
      hasCompatibleEndpointReasoningDrift({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "true",
        registryEntry: { name: "saved", compatibleEndpointReasoning: "true" },
      }),
    ).toBe(false);
    expect(
      hasCompatibleEndpointReasoningDrift({
        provider: "compatible-endpoint",
        compatibleEndpointReasoning: "true",
        registryEntry: { name: "saved" },
      }),
    ).toBe(true);
  });

  it("ignores reasoning metadata for providers that do not support the capability", () => {
    expect(
      hasCompatibleEndpointReasoningDrift({
        provider: "provider",
        compatibleEndpointReasoning: "true",
        registryEntry: { name: "saved", compatibleEndpointReasoning: "false" },
      }),
    ).toBe(false);
  });
});
