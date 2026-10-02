// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildHermesManagedPolicy } from "../../../agents/hermes/config/managed-policy.ts";
import { candidatePolicy, settings } from "./hermes-config-removal-fixture.ts";

describe("Hermes proposed configuration removals", () => {
  it("H04 stops seeding memory and curator choices without changing the initial inference route (#11763)", () => {
    const current = buildHermesManagedPolicy(settings, {});
    const candidate = candidatePolicy(["memory", "curator", "auxiliary"]);
    expect(current.config.memory).toMatchObject({ memory_enabled: true });
    expect(current.config.curator).toMatchObject({ enabled: true });
    expect(candidate.config.memory).toBeUndefined();
    expect(candidate.config.curator).toBeUndefined();
    expect(candidate.config.auxiliary).toBeUndefined();
    expect(candidate.config.model).toEqual(current.config.model);
    expect(candidate.env_lines).toEqual(current.env_lines);
  });

  it("H07 leaves packaged adapter activation unset when neutral defaults are omitted (#11763)", () => {
    const current = buildHermesManagedPolicy(settings, {});
    const candidate = candidatePolicy([], true);
    expect(current.config.platforms).toMatchObject({
      discord: { enabled: false },
      slack: { enabled: false },
    });
    expect(candidate.config.platforms).toEqual({
      api_server: { enabled: true, extra: { port: 18642, host: "127.0.0.1" } },
    });
    expect(candidate.config.model).toEqual(current.config.model);
    expect(candidate.env_lines).toEqual(current.env_lines);
  });

  it("H08 stops seeding the API tool list when its configuration is omitted (#11763)", () => {
    const current = buildHermesManagedPolicy(settings, {});
    const candidate = candidatePolicy(["platform_toolsets"]);
    expect(current.config.platform_toolsets).toMatchObject({
      api_server: expect.arrayContaining(["terminal", "file"]),
    });
    expect(candidate.config.platform_toolsets).toBeUndefined();
    expect(candidate.config.model).toEqual(current.config.model);
    expect(candidate.env_lines).toEqual(current.env_lines);
  });
});
