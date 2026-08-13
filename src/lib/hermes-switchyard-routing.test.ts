// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type HermesSwitchyardRouting,
  parseHermesSwitchyardRelayToml,
  serializeHermesSwitchyardRelayToml,
  validateHermesSwitchyardRouting,
} from "./hermes-switchyard-routing";

const ROUTING: HermesSwitchyardRouting = {
  algorithm: "llm_classifier",
  baseThreshold: 0.5,
  targets: [
    {
      role: "strong",
      baseUrl: "https://quality.models.test/v1/",
      model: "quality-model",
      protocol: "openai_chat",
      headerEnv: [
        {
          headerName: "Authorization",
          envKey: "SWITCHYARD_STRONG_AUTHORIZATION",
        },
      ],
    },
    {
      role: "judge",
      baseUrl: "https://judge.models.test/v1",
      model: "judge-model",
      protocol: "openai_chat",
      headerEnv: [
        {
          headerName: "authorization",
          envKey: "SWITCHYARD_JUDGE_AUTHORIZATION",
        },
      ],
    },
    {
      role: "weak",
      baseUrl: "https://fast.models.test/v1",
      model: "fast-model",
      protocol: "openai_chat",
      headerEnv: [
        {
          headerName: "authorization",
          envKey: "SWITCHYARD_WEAK_AUTHORIZATION",
        },
      ],
    },
  ],
};

describe("Hermes Switchyard routing contract", () => {
  it("canonicalizes exactly judge, weak, and strong and emits deterministic fail-closed TOML (#8886)", () => {
    const canonical = validateHermesSwitchyardRouting(ROUTING);
    const serialized = serializeHermesSwitchyardRelayToml(ROUTING);

    expect(canonical.targets.map(({ role }) => role)).toEqual(["judge", "weak", "strong"]);
    expect(canonical.targets[2]?.baseUrl).toBe("https://quality.models.test/v1");
    expect(serializeHermesSwitchyardRelayToml(canonical)).toBe(serialized);
    expect(parseHermesSwitchyardRelayToml(serialized).size).toBe(11);
    expect(serialized).toContain('manifest = "/opt/switchyard-relay-plugin/relay-plugin.toml"');
    expect(serialized).toContain('failure_mode = "fail_closed"');
    expect(serialized).toContain("[plugins.dynamic.config.targets.strong.header_env]");
    expect(serialized).toContain('"authorization" = "SWITCHYARD_STRONG_AUTHORIZATION"');
    expect(serialized).not.toContain("openshell:resolve:env:");
    expect(serialized).not.toContain("QUALITY_API_KEY");
  });

  it.each([
    ["missing role", { ...ROUTING, targets: ROUTING.targets.slice(0, 2) }],
    [
      "duplicate role",
      {
        ...ROUTING,
        targets: [ROUTING.targets[0], ROUTING.targets[1], ROUTING.targets[1]],
      },
    ],
    [
      "HTTP URL",
      {
        ...ROUTING,
        targets: ROUTING.targets.map((target) =>
          target.role === "weak" ? { ...target, baseUrl: "http://fast.models.test/v1" } : target,
        ),
      },
    ],
    [
      "URL userinfo",
      {
        ...ROUTING,
        targets: ROUTING.targets.map((target) =>
          target.role === "weak"
            ? { ...target, baseUrl: "https://user:secret@fast.models.test/v1" }
            : target,
        ),
      },
    ],
    [
      "unsafe header env key",
      {
        ...ROUTING,
        targets: ROUTING.targets.map((target) =>
          target.role === "weak"
            ? {
                ...target,
                headerEnv: [{ ...target.headerEnv[0], envKey: "FAST_API_KEY" }],
              }
            : target,
        ),
      },
    ],
    [
      "duplicate model",
      {
        ...ROUTING,
        targets: ROUTING.targets.map((target) =>
          target.role === "weak" ? { ...target, model: "quality-model" } : target,
        ),
      },
    ],
    [
      "duplicate dispatch URL",
      {
        ...ROUTING,
        targets: ROUTING.targets.map((target) =>
          target.role === "weak"
            ? { ...target, baseUrl: "https://quality.models.test/v1" }
            : target,
        ),
      },
    ],
  ])("rejects %s before generating native Relay configuration (#8887)", (_name, candidate) => {
    expect(() => validateHermesSwitchyardRouting(candidate)).toThrow(
      /Invalid Hermes Switchyard routing/,
    );
  });

  it("rejects malformed TOML before root promotion (#8886)", () => {
    expect(() => parseHermesSwitchyardRelayToml("version = 1\nversion = 2\n")).toThrow(
      /repeats key/,
    );
    expect(() => parseHermesSwitchyardRelayToml("version=1\n")).toThrow(/unsupported syntax/);
  });
});
