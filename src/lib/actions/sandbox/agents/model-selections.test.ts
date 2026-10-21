// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { restoredAgentModelSelections } from "./model-selections";
import {
  imageRef,
  managedWorkload,
  profileInput,
} from "../../../domain/config/export-source-test-fixture";
import type { SandboxEntry } from "../../../state/registry/types";

const hostedNvidiaEndpoint = "https://integrate.api.nvidia.com/v1";
const model = "nvidia/nemotron-3-ultra-550b-a55b";

function sandbox(routedBaseUrl?: string): SandboxEntry {
  const input = profileInput();
  return {
    name: "alpha",
    agent: "openclaw",
    model,
    provider: "nvidia-prod",
    modelSelectionProvenance: {
      schemaVersion: 1,
      model,
      provider: "nvidia-prod",
      providerProfile: "nvidia",
      modelSource: "custom",
      apiFamily: "openai-completions",
    },
    ...(routedBaseUrl
      ? {
          imageTag: imageRef,
          workload: managedWorkload({
            ...input,
            inference: {
              ...input.inference!,
              routeProvider: "inference",
              upstreamProvider: "nvidia-prod",
              model,
              routedBaseUrl,
              api: "openai-completions",
              primaryModelRef: `inference/${model}`,
            },
          }),
        }
      : {}),
  } as SandboxEntry;
}

const nativeConfig = (baseUrl: string) => ({
  agents: { defaults: { model: `inference/${model}` }, entries: { main: {} } },
  models: { providers: { inference: { api: "openai-completions", baseUrl } } },
});

const primary = {
  schemaVersion: 1,
  agentId: "main",
  assignment: "primary",
  reference: `inference/${model}`,
  modelSource: "custom",
};

it.each([
  ["the gateway route", "https://inference.local/v1", undefined],
  [
    "a hosted native route recorded in the startup profile",
    hostedNvidiaEndpoint,
    hostedNvidiaEndpoint,
  ],
])("retains the primary model source for %s (#13576)", (_label, baseUrl, routedBaseUrl) => {
  const entry = sandbox(routedBaseUrl);
  expect(restoredAgentModelSelections(nativeConfig(baseUrl), entry, entry)).toEqual([primary]);
});

it.each([
  ["no managed startup profile", undefined],
  ["a different recorded route", "https://example.invalid/v1"],
])("rejects an upstream route with %s (#13576)", (_label, routedBaseUrl) => {
  const entry = sandbox(routedBaseUrl);
  expect(restoredAgentModelSelections(nativeConfig(hostedNvidiaEndpoint), entry, entry)).toBeNull();
});
