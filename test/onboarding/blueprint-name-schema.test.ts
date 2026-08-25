// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { compileConfigSchema } from "../../scripts/validate-configs.mts";

interface BlueprintFixture {
  version: string;
  profiles: string[];
  components: {
    sandbox: { image: string; name: string };
    inference: {
      profiles: {
        default: {
          provider_type: string;
          endpoint: string;
          provider_name?: string;
        };
      };
    };
  };
}

function createBlueprint(): BlueprintFixture {
  return {
    version: "1.0.0",
    profiles: ["default"],
    components: {
      sandbox: { image: "example.invalid/nemoclaw:fixture", name: "fixture" },
      inference: {
        profiles: {
          default: { provider_type: "openai", endpoint: "https://api.example.com" },
        },
      },
    },
  };
}

describe("blueprint name schema", () => {
  const validate = compileConfigSchema("schemas/blueprint.schema.json");

  it.each([
    ["a flag-like sandbox name", "--help"],
    ["a leading-dash sandbox name", "-x"],
    ["a command-substitution sandbox name", "$(id)"],
    ["an uppercase sandbox name", "TestSandbox"],
    ["a trailing-hyphen sandbox name", "sandbox-"],
    ["a 20-character sandbox name", "a".repeat(20)],
    ["a double-hyphen sandbox name", "legacy--sandbox"],
  ])("rejects blueprint with %s", (_label, name) => {
    const blueprint = createBlueprint();
    blueprint.components.sandbox.name = name;
    expect(validate(blueprint)).toBe(false);
  });

  it.each([
    ["accepts uppercase, dots, and underscores", "Provider_1.prod", true],
    ["accepts exactly 128 characters", `a${"b".repeat(127)}`, true],
    ["rejects command substitution", "$(id)", false],
    ["rejects a leading digit", "1provider", false],
    ["rejects a leading dash", "-provider", false],
    ["rejects whitespace and controls", "provider\nname", false],
    ["rejects 129 characters", `a${"b".repeat(128)}`, false],
  ])("%s in blueprint provider_name", (_label, providerName, expected) => {
    const blueprint = createBlueprint();
    blueprint.components.inference.profiles.default.provider_name = providerName;
    expect(validate(blueprint)).toBe(expected);
  });

  it("accepts blueprint with an exact 19-character sandbox name (#8497)", () => {
    const blueprint = createBlueprint();
    blueprint.components.sandbox.name = `a${"b".repeat(18)}`;
    expect(validate(blueprint), JSON.stringify(validate.errors)).toBe(true);
  });
});
