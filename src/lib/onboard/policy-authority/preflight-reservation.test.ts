// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  managedPolicyInspection,
  managedSandboxEntry,
  SANDBOX_IDENTITY,
} from "../../../../test/helpers/managed-policy-receipt-fixture";
import type { SandboxEntry } from "../../state/registry";
import { createOnboardPolicyAuthorityBindings, qualifySandboxPolicyAuthority } from "./preflight";

const CURRENT_SESSION_ID = "session-current";
const requiredPolicy = {
  policyPath: "/tmp/unused.yaml",
  sourceBytes: Buffer.from("version: 1\nnetwork_policies: {}\n"),
  appliedPresets: [],
};

function pendingManagedSandboxEntry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    ...managedSandboxEntry("demo"),
    pendingRouteReservation: true,
    reservationSessionId: CURRENT_SESSION_ID,
    ...overrides,
  };
}

function managedQualificationDeps() {
  return {
    inspectSandboxPolicyAuthority: managedPolicyInspection,
    inspectOpenShellSandboxIdentityFingerprint: () => SANDBOX_IDENTITY,
    assertOpenShellGatewayPortBinding: vi.fn(),
  };
}

describe("receipt-bound policy authority during inference route reservation", () => {
  it("accepts the pending route owned by the current onboarding session (#9833)", () => {
    const recorded = pendingManagedSandboxEntry();
    const deps = managedQualificationDeps();

    expect(
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["nemoclaw-managed"],
          recordedSandbox: recorded,
          readRecordedSandbox: () => ({ ...recorded }),
          currentSessionId: CURRENT_SESSION_ID,
          prepareRequiredPolicy: () => requiredPolicy,
          operation: "reuse sandbox 'demo'",
        },
        deps,
      ),
    ).toEqual({ authority: "nemoclaw-managed" });
    expect(deps.assertOpenShellGatewayPortBinding).toHaveBeenCalledOnce();
  });

  it("continues from provider reservation to sandbox preflight for the same session (#9833)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "nemoclaw-policy-reservation-"));
    vi.stubEnv("HOME", home);
    vi.resetModules();
    try {
      const registry = await import("../../state/registry");
      const original = registry.registerSandbox(managedSandboxEntry("demo"));
      registry.reserveSandboxInferenceRoute("demo", {
        provider: "nvidia-prod",
        model: "nvidia/test",
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-responses",
        gatewayName: "nemoclaw",
        reservationSessionId: CURRENT_SESSION_ID,
      });
      const inspectSandboxForCreate = vi.fn((name: string) => ({
        existingEntry: registry.getSandbox(name),
        liveExists: true,
      }));
      const prepareAgentPolicy = vi.fn(() => "/unused/openclaw-policy.yaml");
      const bindings = createOnboardPolicyAuthorityBindings(
        {
          GATEWAY_NAME: "nemoclaw",
          ROOT: "/repo",
          agentDefs: { loadAgent: () => ({ name: "openclaw" }) as never },
          agentOnboard: { getAgentPolicyPath: prepareAgentPolicy as never },
          inspectSandboxForCreate,
          onboardSession: {
            loadSession: () => ({ sessionId: CURRENT_SESSION_ID }),
            updateSession: vi.fn(),
          },
        },
        null,
        managedQualificationDeps(),
      );

      expect(() =>
        bindings.preflightPolicyRequirements({
          gatewayName: "nemoclaw",
          sandboxName: "demo",
          agent: { name: "openclaw" } as never,
          selectedMessagingChannels: [],
          hermesToolGateways: [],
          gpuPassthrough: false,
          provider: "nvidia-prod",
          webSearchConfig: null,
          observabilityEnabled: false,
          operation: "continue after reserving the inference route",
        }),
      ).not.toThrow();
      expect(registry.getSandbox("demo")).toMatchObject({
        pendingRouteReservation: true,
        reservationSessionId: CURRENT_SESSION_ID,
        policyCreationReceipt: original.policyCreationReceipt,
      });
      expect(inspectSandboxForCreate).toHaveBeenCalledTimes(2);
      expect(prepareAgentPolicy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it.each([
    ["is missing", undefined],
    ["is empty", ""],
    ["belongs to another session", "session-foreign"],
  ])("refuses when the current onboarding session %s (#9833)", (_case, currentSessionId) => {
    const recorded = pendingManagedSandboxEntry();
    const deps = managedQualificationDeps();

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["nemoclaw-managed"],
          recordedSandbox: recorded,
          readRecordedSandbox: () => ({ ...recorded }),
          currentSessionId,
          prepareRequiredPolicy: () => requiredPolicy,
          operation: "reuse sandbox 'demo'",
        },
        deps,
      ),
    ).toThrow(/ownership is not durably verified/u);
    expect(deps.assertOpenShellGatewayPortBinding).not.toHaveBeenCalled();
  });

  it.each([
    ["has no receipt", { policyCreationReceipt: undefined }, /creation receipt does not match/u],
    [
      "has no lifecycle generation",
      { lifecycleGeneration: undefined },
      /ownership is not durably verified/u,
    ],
    [
      "has no live identity",
      { lifecycleLiveIdentityFingerprint: undefined },
      /ownership is not durably verified/u,
    ],
    [
      "has an incomplete policy checkpoint",
      { pendingPolicyVerification: {} as never },
      /ownership is not durably verified/u,
    ],
  ])("refuses when a pending managed row %s (#9833)", (_case, overrides, expected) => {
    const recorded = pendingManagedSandboxEntry(overrides);

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["nemoclaw-managed"],
          recordedSandbox: recorded,
          readRecordedSandbox: () => ({ ...recorded }),
          currentSessionId: CURRENT_SESSION_ID,
          prepareRequiredPolicy: () => requiredPolicy,
          operation: "reuse sandbox 'demo'",
        },
        managedQualificationDeps(),
      ),
    ).toThrow(expected);
  });

  it.each([
    ["disappears", null],
    [
      "changes its reservation owner",
      pendingManagedSandboxEntry({ reservationSessionId: "session-raced" }),
    ],
    [
      "completes concurrently",
      pendingManagedSandboxEntry({
        pendingRouteReservation: undefined,
        reservationSessionId: CURRENT_SESSION_ID,
      }),
    ],
  ])("refuses when the recorded route %s during live verification (#9833)", (_case, reread) => {
    const recorded = pendingManagedSandboxEntry();

    expect(() =>
      qualifySandboxPolicyAuthority(
        {
          sandboxName: "demo",
          gatewayName: "nemoclaw",
          liveExists: true,
          recordedAuthorities: ["nemoclaw-managed"],
          recordedSandbox: recorded,
          readRecordedSandbox: () => reread,
          currentSessionId: CURRENT_SESSION_ID,
          prepareRequiredPolicy: () => requiredPolicy,
          operation: "reuse sandbox 'demo'",
        },
        managedQualificationDeps(),
      ),
    ).toThrow(/recorded sandbox policy boundary changed/u);
  });
});
