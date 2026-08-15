// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import * as managedWorkload from "../../onboard/workload/rebuild";
import * as registry from "../../state/registry";
import type { SandboxEntry } from "../../state/registry/types";
import {
  managedRebuildProfileDependencies,
  prepareManagedRebuildProfileHandoff,
} from "./agents/managed-workload-rebuild-profile";
import type { RebuildRecreateOnboardOpts } from "./rebuild-gpu-opt-out";
import { revalidateManagedWorkloadRebuildBeforeDelete } from "./rebuild-preflight-guards";
import type { RebuildTargetConfig } from "./rebuild-target-preflight";

const entry = {
  name: "alpha",
  openshellDriver: "docker",
} as SandboxEntry;
const handoff = {
  providerId: "docker",
} as managedWorkload.ManagedWorkloadRebuildHandoff;

describe("managed workload rebuild mutation guard", () => {
  it("blocks deletion when durable workload authority changes", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(entry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the sandbox entry disappeared", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue(null);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("blocks deletion when the recorded runtime provider is unknown", () => {
    vi.spyOn(registry, "getSandbox").mockReturnValue({
      ...entry,
      openshellDriver: "not-a-provider",
    } as SandboxEntry);

    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", handoff)).toEqual({
      ok: false,
      message: "Managed workload authority changed before sandbox deletion.",
    });
  });

  it("does not alter legacy rebuild validation", () => {
    expect(revalidateManagedWorkloadRebuildBeforeDelete("alpha", undefined)).toBeNull();
  });

  it("stages compatible-endpoint OpenClaw reasoning authority before deletion", () => {
    const catalogHandoff = {
      agent: "openclaw",
      previousProfile: {
        inference: { model: "previous-model", upstreamProvider: "nvidia-prod" },
        dashboard: { agent: "openclaw", bindAddress: "127.0.0.1", wslExposure: false },
      },
    } as unknown as managedWorkload.ManagedWorkloadRebuildCatalogHandoff;
    const targetConfig = {
      agentDefinition: {},
      resumeConfig: {
        provider: "compatible-endpoint",
        model: "reasoning-model",
        preferredInferenceApi: "openai-completions",
        endpointUrl: "https://inference.example.test/v1",
        compatibleEndpointReasoning: "true",
        compatibleEndpointReasoningEffort: "high",
      },
      durableConfig: { webSearchConfig: null },
      hermesToolGateways: [],
    } as unknown as RebuildTargetConfig;
    const stage = vi
      .spyOn(managedWorkload, "stageManagedWorkloadRebuildProfile")
      .mockReturnValue(handoff);
    vi.spyOn(managedRebuildProfileDependencies, "resolveContextWindowForModel").mockReturnValue(
      131_072,
    );

    expect(
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toBe(handoff);
    expect(stage).toHaveBeenCalledWith(
      catalogHandoff,
      expect.objectContaining({
        inference: expect.objectContaining({
          model: "reasoning-model",
          upstreamProvider: "compatible-endpoint",
          api: "openai-completions",
        }),
      }),
      {},
      {
        openClawContextWindow: 131_072,
        openClawReasoning: true,
        openClawReasoningEffort: "high",
      },
    );

    vi.spyOn(
      managedRebuildProfileDependencies,
      "resolveManagedStartupInferenceRoute",
    ).mockReturnValue({
      providerKey: "compatible-endpoint",
      primaryModelRef: "reasoning-model",
      inferenceBaseUrl: "http://127.0.0.1:8080/v1",
      inferenceApi: "unsupported-api",
      inferenceCompat: null,
    });
    expect(() =>
      prepareManagedRebuildProfileHandoff({
        catalogHandoff,
        targetConfig,
        recreateOptions: {
          controlUiPort: 18_789,
          toolDisclosure: "progressive",
          dcodeAutoApprovalMode: "disabled",
          observabilityEnabled: false,
        } as unknown as RebuildRecreateOnboardOpts,
        messagingPlan: null,
        environment: {},
      }),
    ).toThrow("Unsupported managed startup inference API 'unsupported-api'.");
  });
});
