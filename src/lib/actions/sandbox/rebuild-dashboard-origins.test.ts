// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import { mapManagedStartupProfileToAgentEnvironment } from "../../onboard/managed-startup/agent-environment";
import type * as managedWorkload from "../../onboard/workload/rebuild";
import {
  managedRebuildProfileDependencies,
  prepareManagedRebuildProfileHandoff,
} from "./agents/managed-workload-rebuild-profile";
import {
  buildRebuildRecreateOnboardOpts,
  type RebuildRecreateOnboardOpts,
} from "./rebuild-gpu-opt-out";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

const ORIGINS = ["https://launchpad.example.test:8443"];
const previousProfile = managedStartupE2eProfile("openclaw");
const targetConfig = {
  agentDefinition: {},
  resumeConfig: {
    provider: "nvidia-prod",
    model: previousProfile.inference!.model,
    preferredInferenceApi: "openai-completions",
    endpointUrl: null,
    compatibleEndpointReasoning: null,
    compatibleEndpointReasoningEffort: null,
  },
  durableConfig: { webSearchConfig: null },
  hermesToolGateways: [],
} as unknown as RebuildTargetConfig;

function prepare(input: {
  readonly previousOrigins?: readonly string[];
  readonly recordedDashboardOrigins?: readonly string[] | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}) {
  vi.spyOn(
    managedRebuildProfileDependencies,
    "resolveManagedStartupInferenceRoute",
  ).mockReturnValue({
    providerKey: "inference",
    primaryModelRef: previousProfile.inference!.primaryModelRef!,
    inferenceBaseUrl: "https://inference.local/v1",
    inferenceApi: "openai-completions",
    inferenceCompat: null,
  });
  vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
    131_072,
  );
  const dashboard = {
    ...previousProfile.dashboard,
    ...(input.previousOrigins ? { extraOrigins: [...input.previousOrigins] } : {}),
  };
  const prepared = prepareManagedRebuildProfileHandoff({
    catalogHandoff: {
      agent: "openclaw",
      previousProfile: { ...previousProfile, dashboard },
      previousReceipt: { credentialProxyReplayRequired: false },
      corporateCa: null,
    } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff,
    gatewayPort: 8080,
    targetConfig,
    recreateOptions: {
      controlUiPort: 18_790,
      toolDisclosure: "progressive",
      dcodeAutoApprovalMode: "disabled",
      observabilityEnabled: false,
    } as unknown as RebuildRecreateOnboardOpts,
    messagingPlan: null,
    environment: input.environment ?? {},
    recordedDashboardOrigins: input.recordedDashboardOrigins,
  });
  const profile = prepared.replacementProfile.profile;
  return {
    dashboard: profile.dashboard,
    env: mapManagedStartupProfileToAgentEnvironment(profile, {}).configurationEnvironment,
  };
}

describe("rebuild replays recorded dashboard origins (#13177)", () => {
  it("replays the origins that onboarding recorded for the sandbox", () => {
    const { dashboard, env } = prepare({ recordedDashboardOrigins: ORIGINS });

    expect(dashboard).toMatchObject({ extraOrigins: ORIGINS });
    expect(env.NEMOCLAW_DASHBOARD_ORIGINS).toBe(ORIGINS.join(","));
  });

  it("follows the registry when onboarding removed the origins", () => {
    expect(prepare({ previousOrigins: ORIGINS }).dashboard).not.toHaveProperty("extraOrigins");
  });

  it("prefers the registry record over the previous profile", () => {
    const recorded = ["https://dash.example.test:9443"];

    expect(
      prepare({ previousOrigins: ORIGINS, recordedDashboardOrigins: recorded }).dashboard,
    ).toMatchObject({ extraOrigins: recorded });
  });

  it("ignores NEMOCLAW_DASHBOARD_ORIGINS from the rebuild environment", () => {
    const { dashboard } = prepare({
      environment: { NEMOCLAW_DASHBOARD_ORIGINS: "https://other.example.test" },
    });

    expect(dashboard).not.toHaveProperty("extraOrigins");
  });
});

describe("rebuild recreate options (#13177)", () => {
  const baseArgs = {
    rebuildAgent: "openclaw",
    storedFromDockerfile: null,
    autoYes: true,
    usageNoticeAccepted: true as const,
  };

  it("carries recorded origins into the inner onboard so the replacement records them", () => {
    const opts = buildRebuildRecreateOnboardOpts({
      ...baseArgs,
      sb: { dashboardPort: 18789, dashboardOrigins: ORIGINS },
    });

    expect(opts.dashboardOrigins).toEqual(ORIGINS);
  });

  it("refuses a malformed recorded value instead of dropping the origins", () => {
    expect(() =>
      buildRebuildRecreateOnboardOpts({
        ...baseArgs,
        sb: { dashboardPort: 18789, dashboardOrigins: ["http://launchpad.example.test"] },
      }),
    ).toThrow(/recorded dashboard origins are invalid/i);
  });

  it("treats an absent record as no origins", () => {
    const opts = buildRebuildRecreateOnboardOpts({ ...baseArgs, sb: { dashboardPort: 18789 } });

    expect(opts).not.toHaveProperty("dashboardOrigins");
  });
});
