// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mockSupportedLiveSource, raw } from "../../../../test/support/config-export-harness";
import {
  endpointlessTavilyProfile,
  managedBraveProfile,
  managedTavilyProfile,
} from "../../../../test/fixtures/openshell-provider-profile";
import { buildManagedStartupProfile } from "../../onboard/managed-startup/profile-builder";
import type { SandboxEntry } from "../../state/registry/types";
import {
  braveProvider,
  entry,
  imageRef,
  inventory,
  provider,
  startupInput,
} from "./live-export-source-test-fixture";

export function tavilyProfile(agent: "openclaw" | "hermes") {
  return agent === "hermes" ? managedTavilyProfile(agent) : endpointlessTavilyProfile();
}

function hermesDashboard() {
  return {
    agent: "hermes" as const,
    mode: "disabled" as const,
    url: "http://127.0.0.1:18789",
    browserUrl: "http://127.0.0.1:18789",
    publicPort: null,
    internalPort: null,
    tuiEnabled: false as const,
  };
}

function searchStartup(searchProvider: "brave" | "tavily", agent: "openclaw" | "hermes") {
  return buildManagedStartupProfile({
    ...startupInput,
    agent,
    ...(agent === "hermes"
      ? {
          inference: { ...startupInput.inference, primaryModelRef: null, compatibility: null },
          dashboard: hermesDashboard(),
        }
      : {}),
    webSearch: { fetchEnabled: true, provider: searchProvider },
  });
}

function searchRegistry(
  searchProvider: "brave" | "tavily",
  agent: "openclaw" | "hermes",
  runtimeImage: string,
  built: ReturnType<typeof searchStartup>,
) {
  return {
    ...entry,
    agent,
    imageTag: runtimeImage,
    ...(agent === "hermes" ? { hermesApiPort: 8642 } : {}),
    webSearchEnabled: true,
    webSearchProvider: searchProvider,
    workload: {
      ...(entry.workload as Extract<
        NonNullable<SandboxEntry["workload"]>,
        { kind: "managed-image" }
      >),
      reference: runtimeImage,
      encodedProfile: built.encodedProfile,
      startupProfileSha256: built.startupProfileSha256,
    },
  };
}

function searchProviderRow(searchProvider: "brave" | "tavily", agent: "openclaw" | "hermes") {
  const base = braveProvider();
  const profile = searchProvider === "brave" ? managedBraveProfile() : tavilyProfile(agent);
  const providerName = `alpha-${searchProvider}-search`;
  return {
    providerName,
    profile,
    search: {
      ...base,
      provider: {
        ...base.provider,
        metadata: { ...base.provider.metadata, name: providerName },
        type: profile.id,
        credentials: Object.defineProperty(
          {},
          searchProvider === "brave" ? "BRAVE_API_KEY" : "TAVILY_API_KEY",
          {
            enumerable: true,
            get: base.readCredential,
          },
        ),
      },
    },
  };
}

export function mockSearchLiveSource(
  searchProvider: "brave" | "tavily",
  agent: "openclaw" | "hermes" = "openclaw",
) {
  const runtimeImage =
    agent === "hermes" ? imageRef.replace("openclaw-sandbox", "hermes-sandbox") : imageRef;
  const built = searchStartup(searchProvider, agent);
  mockSupportedLiveSource(3, 3, searchRegistry(searchProvider, agent, runtimeImage, built));
  const { providerName, profile, search } = searchProviderRow(searchProvider, agent);
  raw.getProviderProfile.mockResolvedValue({ profile });
  raw.getProvider.mockImplementation(async ({ name }: { name: string }) =>
    name === providerName ? { provider: search.provider } : provider(),
  );
  raw.getSandbox.mockResolvedValue({
    sandbox: {
      ...inventory().sandbox,
      spec: { template: { image: runtimeImage }, providers: [providerName] },
    },
  });
  return search;
}
