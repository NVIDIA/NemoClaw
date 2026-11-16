// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildConfig as buildOpenClawConfig } from "../../../scripts/generate-openclaw-config.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "./managed-startup/agent-environment";
import {
  buildManagedStartupOnboardProfile,
  type ManagedStartupOnboardProfileInput,
} from "./managed-startup/onboard-profile";
import {
  decodeManagedStartupProfile,
  encodeManagedStartupProfile,
  type ManagedStartupProfile,
  validateManagedStartupProfile,
} from "./managed-startup/profile";

const EXTRA_ORIGINS = ["https://launchpad.example.test:8443", "http://localhost:9000"];

function openClawInput(
  overrides: Partial<ManagedStartupOnboardProfileInput> = {},
): ManagedStartupOnboardProfileInput {
  return {
    agentName: "openclaw",
    inference: {
      routeProvider: "openai",
      upstreamProvider: "openai-api",
      model: "gpt-5.4",
      routedBaseUrl: "https://inference.local/v1",
      upstreamEndpointUrl: null,
      api: "openai-responses",
      primaryModelRef: "openai/gpt-5.4",
      compatibility: {},
    },
    chatUiUrl: "https://launchpad.example.test:18789",
    effectiveDashboardPort: 18_789,
    manageDashboard: true,
    dashboardBindAddress: undefined,
    wslExposure: false,
    dashboardOrigins: [],
    hermesDashboardState: { config: null, enabled: false },
    webSearch: null,
    toolDisclosure: "progressive",
    hermesToolGateways: [],
    messagingPlan: null,
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    environment: {},
    corporateCa: null,
    ...overrides,
  };
}

function profileWith(dashboardOrigins: readonly string[]): ManagedStartupProfile {
  return buildManagedStartupOnboardProfile(openClawInput({ dashboardOrigins })).profile;
}

function withDashboard(
  profile: ManagedStartupProfile,
  dashboard: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify({ ...profile, dashboard: { ...profile.dashboard, ...dashboard } }),
  );
}

describe("managed startup OpenClaw dashboard origins (#13177)", () => {
  it("records extra origins and keeps them through encoding", () => {
    const profile = profileWith(EXTRA_ORIGINS);

    expect(profile.dashboard).toMatchObject({ agent: "openclaw", extraOrigins: EXTRA_ORIGINS });
    expect(decodeManagedStartupProfile(encodeManagedStartupProfile(profile)).dashboard).toEqual(
      profile.dashboard,
    );
  });

  it("omits the key when no extra origin is set", () => {
    expect(Object.keys(profileWith([]).dashboard)).toEqual([
      "agent",
      "mode",
      "url",
      "port",
      "bindAddress",
      "wslExposure",
    ]);
  });

  it("keeps the dashboard mode and bind independent of extra origins", () => {
    const loopback = buildManagedStartupOnboardProfile(
      openClawInput({ chatUiUrl: "http://127.0.0.1:18789", dashboardOrigins: EXTRA_ORIGINS }),
    ).profile;

    expect(loopback.dashboard).toMatchObject({ mode: "loopback", bindAddress: "127.0.0.1" });
  });

  it.each([
    ["an empty list", []],
    ["a path", ["https://launchpad.example.test/dashboard"]],
    ["plain http for a remote host", ["http://launchpad.example.test:8443"]],
    ["a duplicate", ["https://launchpad.example.test:8443", "https://launchpad.example.test:8443"]],
    ["a non-string entry", [8443]],
  ])("rejects a recorded profile with %s", (_case, extraOrigins) => {
    expect(() =>
      validateManagedStartupProfile(withDashboard(profileWith([]), { extraOrigins })),
    ).toThrow(/dashboard\.extraOrigins/);
  });

  it("makes the released OpenClaw dashboard check refuse a profile with extra origins", () => {
    // Frozen copy of the OpenClaw dashboard key check that shipped before #13177
    // (OPENCLAW_DASHBOARD_KEYS + rejectUnknownKeys in managed-startup/profile.ts).
    // A CLI from before this change validates recorded profiles with it.
    const RELEASED_OPENCLAW_DASHBOARD_KEYS = new Set([
      "agent",
      "mode",
      "url",
      "port",
      "bindAddress",
      "wslExposure",
    ]);
    /** Dashboard fields the released check would refuse as unsupported. */
    const unsupportedByReleasedCheck = (encoded: string): string[] => {
      const { dashboard } = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
        dashboard: Record<string, unknown>;
      };
      return Object.keys(dashboard).filter((key) => !RELEASED_OPENCLAW_DASHBOARD_KEYS.has(key));
    };

    expect(
      unsupportedByReleasedCheck(encodeManagedStartupProfile(profileWith(EXTRA_ORIGINS))),
    ).toEqual(["extraOrigins"]);
    expect(unsupportedByReleasedCheck(encodeManagedStartupProfile(profileWith([])))).toEqual([]);
  });

  it("does not let an exported NEMOCLAW_DASHBOARD_ORIGINS reach the profile builder", () => {
    const profile = buildManagedStartupOnboardProfile(
      openClawInput({
        environment: { NEMOCLAW_DASHBOARD_ORIGINS: "https://ambient.example.test:9443" },
      }),
    ).profile;

    expect(profile.dashboard).not.toHaveProperty("extraOrigins");
  });

  it("refuses extra origins for another agent instead of dropping them", () => {
    expect(() =>
      buildManagedStartupOnboardProfile(
        openClawInput({
          agentName: "langchain-deepagents-code",
          manageDashboard: false,
          inference: null,
          dashboardOrigins: EXTRA_ORIGINS,
        }),
      ),
    ).toThrow(/dashboard origins are supported only for OpenClaw/);
  });

  it("feeds the extra origins to the OpenClaw config generator", () => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(profileWith(EXTRA_ORIGINS));
    const config = buildOpenClawConfig({
      ...mapped.configurationEnvironment,
      ...mapped.runtimeEnvironment,
    });

    expect(config.gateway.controlUi.allowedOrigins).toEqual(
      expect.arrayContaining(["https://launchpad.example.test:18789", ...EXTRA_ORIGINS]),
    );
  });

  it("maps a profile without extra origins to the same environment as before", () => {
    const mapped = mapManagedStartupProfileToAgentEnvironment(profileWith([]));

    expect(mapped.configurationEnvironment).not.toHaveProperty("NEMOCLAW_DASHBOARD_ORIGINS");
    expect(mapped.runtimeEnvironment).not.toHaveProperty("NEMOCLAW_DASHBOARD_ORIGINS");
  });
});
