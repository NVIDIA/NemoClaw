// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeMessagingPlan } from "../../../../../test/helpers/messaging-plan-fixtures";
import * as registry from "../../../state/registry";
import type { SandboxEntry } from "../../../state/registry";
import {
  qualifySnapshotPolicyAuthority,
  resolveSnapshotBuiltinPolicyRequirements,
  resolveSnapshotPolicyRequirements,
} from "./snapshot";

describe("snapshot policy authority qualification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("retains only agreed legacy authority when a requirement is missing (#9833)", () => {
    const sourceEntry = { name: "alpha" };
    const updateSandbox = vi.spyOn(registry, "updateSandbox").mockReturnValue(true);
    const inspection = {
      authority: "externally-managed" as const,
      effectivePolicy: { network_policies: {} },
      policyIdentity: { hash: "external-policy", activeVersion: 1 },
    };

    expect(() =>
      qualifySnapshotPolicyAuthority(
        {
          gatewayName: "nemoclaw",
          managedMcpPolicies: [],
          operation: "clone snapshot 'alpha' into sandbox 'beta'",
          requiredPolicies: [{ network_policies: { required_api: {} } }],
          sourceEntry,
          sourceLive: true,
          verifyGlobalCreatePolicy: false,
        },
        {
          inspectSandboxPolicyAuthority: vi.fn(() => inspection),
        },
      ),
    ).toThrow(/missing entries "required_api"/);

    expect(updateSandbox).toHaveBeenCalledWith("alpha", {
      policyAuthority: "externally-managed",
    });
    expect(sourceEntry).toEqual({ name: "alpha", policyAuthority: "externally-managed" });
  });

  it.each([
    ["absent", "version: 1\n"],
    ["empty", "version: 1\nnetwork_policies: {}\n"],
  ])("rejects a required policy whose network_policies mapping is %s (#9833)", (_case, content) => {
    expect(() =>
      resolveSnapshotPolicyRequirements({
        basePolicyContent: content,
        builtinPresetNames: [],
        customPolicies: [],
        operation: "restore snapshot 'alpha'",
        sandboxName: "alpha",
      }),
    ).toThrow(
      "Refusing to restore snapshot 'alpha': a required network policy document is invalid.",
    );
  });

  it("derives requirements from durable features without NemoClaw attribution (#9833)", () => {
    expect(
      resolveSnapshotBuiltinPolicyRequirements({
        customPolicies: [],
        snapshotPolicyPresets: [],
        sourceEntry: {
          name: "alpha",
          agent: "langchain-deepagents-code",
          messaging: {
            schemaVersion: 1,
            plan: {
              ...makeMessagingPlan({ channels: ["telegram"] }),
              networkPolicy: {
                presets: ["telegram"],
                entries: [
                  {
                    channelId: "telegram",
                    presetName: "telegram",
                    policyKeys: ["telegram"],
                    source: "manifest",
                  },
                ],
              },
            },
          },
          observabilityEnabled: true,
          policyAuthority: "externally-managed",
          provider: "ollama-local",
          webSearchEnabled: true,
          webSearchProvider: "brave",
        },
      }),
    ).toEqual(
      expect.arrayContaining(["telegram", "brave", "local-inference", "observability-otlp-local"]),
    );
  });

  it("does not require local inference for a proven canonical injected route (#9833)", () => {
    const routeOnlyEntry = {
      name: "alpha",
      endpointSource: "inference-set",
      endpointUrl: "https://inference.local/v1",
      hostLocalInferenceProvenance: {},
      hostLocalInferenceReceipt: "receipt",
      provider: "ollama-local",
    } as SandboxEntry;

    expect(
      resolveSnapshotBuiltinPolicyRequirements({
        customPolicies: [],
        snapshotPolicyPresets: [],
        sourceEntry: routeOnlyEntry,
      }),
    ).not.toContain("local-inference");
  });
});
