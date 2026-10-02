// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildHermesManagedPolicy } from "../../../agents/hermes/config/managed-policy.ts";
import type { HermesBuildSettings } from "../../../agents/hermes/config/build-env.ts";
const settings: HermesBuildSettings = {
  model: "fixture-model",
  baseUrl: "https://inference.local/v1",
  providerKey: "custom",
  upstreamProvider: "custom",
  inferenceApi: "openai-completions",
  contextWindow: null,
  toolDisclosure: "progressive",
  webSearchProvider: null,
  messagingCredentialPlaceholders: [],
  managedToolGateways: { brokerEnabled: false, presets: [] },
  managedImageCapabilityUnion: true,
};

describe("Hermes native configuration choices", () => {
  it.each([
    { id: "H01", key: "display" },
    { id: "H02", key: "session_reset" },
    { id: "H09", key: "updates" },
  ])("$id leaves native defaults unset in generated configuration (#11763)", ({ key }) => {
    const candidate = buildHermesManagedPolicy(settings, {});
    expect(candidate.config[key]).toBeUndefined();
    expect(candidate.managed_paths.some((entry) => entry.startsWith(`${key}.`))).toBe(false);
  });
  it("H04 stops seeding memory and curator choices without changing the initial inference route (#11763)", () => {
    const candidate = buildHermesManagedPolicy(settings, {});
    expect(candidate.config.memory).toBeUndefined();
    expect(candidate.config.curator).toBeUndefined();
    expect(candidate.config.auxiliary).toBeUndefined();
    expect(candidate.config.model).toMatchObject({
      default: "fixture-model",
      base_url: "https://inference.local/v1",
    });
  });

  it("H07 leaves packaged adapter activation unset when neutral defaults are omitted (#11763)", () => {
    const candidate = buildHermesManagedPolicy(settings, {});
    expect(candidate.config.platforms).toEqual({
      api_server: { enabled: true, extra: { port: 18642, host: "127.0.0.1" } },
    });
    expect(candidate.config.model).toMatchObject({
      default: "fixture-model",
      base_url: "https://inference.local/v1",
    });
  });

  it("H08 stops seeding the API tool list when its configuration is omitted (#11763)", () => {
    const candidate = buildHermesManagedPolicy(settings, {});
    expect(candidate.config.platform_toolsets).toBeUndefined();
    expect(candidate.config.model).toMatchObject({
      default: "fixture-model",
      base_url: "https://inference.local/v1",
    });
  });
});
