// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import type { ManagedStartupProfileBuilderInput } from "../../onboard/managed-startup/profile-builder";

export const startupInput = {
  agent: "openclaw",
  inference: {
    routeProvider: "inference",
    upstreamProvider: "nvidia-prod",
    model: "model-a",
    routedBaseUrl: "https://inference.local/v1",
    upstreamEndpointUrl: null,
    api: "openai-completions",
    primaryModelRef: "inference/model-a",
    compatibility: {},
  },
  dashboard: {
    agent: "openclaw",
    mode: "loopback",
    url: "http://127.0.0.1:18789",
    port: 18_789,
    bindAddress: "127.0.0.1",
    wslExposure: false,
  },
  webSearch: null,
  toolDisclosure: "progressive",
  hermesToolGateways: [],
  messagingPlan: null,
  dcodeAutoApprovalMode: null,
  observabilityEnabled: null,
  environment: {},
  corporateCa: null,
} satisfies ManagedStartupProfileBuilderInput;
export const startup = buildManagedStartupProfile(startupInput);

export function configuration(revision = 3) {
  return {
    policy: {
      version: 1,
      process: { run_as_user: "sandbox", run_as_group: "sandbox" },
      filesystem_policy: { include_workdir: false, read_only: ["/usr"], read_write: ["/sandbox"] },
      network_policies: {
        api: {
          name: "api",
          endpoints: [{ host: "api.example.com", port: 443 }],
          binaries: [{ path: "/usr/bin/curl" }],
        },
      },
    },
    workspace: "default",
    version: revision,
    policyHash: "a".repeat(64),
    configRevision: 11n,
    providerEnvRevision: 12n,
    policySource: 1,
    globalPolicyVersion: 0,
  };
}
